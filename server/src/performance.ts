/**
 * Performance session domain.
 *
 * A session (场次) is an event-sourced-looking aggregate kept in memory:
 *   id        - server assigned, stable for the life of the session
 *   name      - stage-manager supplied label
 *   status    - pending -> running <-> paused -> ended
 *   version   - optimistic-concurrency token, starts at 1, +1 per commit
 *   requestId - id of the last command that was committed to the session
 *   cues      - ordered int32 cues registered while the session is running
 *
 * Every command passes through two serialisation points:
 *
 *   1. a *request-id chain*, global across the whole service. A given
 *      requestId is adjudicated by at most one command at a time, so the
 *      "already committed?" check and the commit cannot interleave between
 *      two sessions (or between a create and a command on an existing
 *      session). This is what makes the deduplication promise global:
 *      one requestId maps to at most one successful commit for the entire
 *      life of the service, regardless of the target session.
 *
 *   2. the *session chain* (a CREATE chain plus one chain per session id),
 *      held for the duration of the request-id slot: validation,
 *      precondition checks and the state mutation happen in one
 *      synchronous critical section, so each command is either committed
 *      exactly once or rejected with the stored data and version
 *      untouched.
 *
 * Commands with different request ids never share a request-id slot, so
 * commands against different sessions still proceed in parallel; only the
 * per-session ordering (and equal-id contenders) are serialised.
 */

import { randomUUID } from 'node:crypto';
import { PlanDeviation, type DeviationReading } from './plan-deviation.js';
import { ApiError } from './validation.js';

export const PERFORMANCE_STATUSES = ['pending', 'running', 'paused', 'ended'] as const;
export type PerformanceStatus = (typeof PERFORMANCE_STATUSES)[number];

/**
 * Snapshot deviation view. `null` marks a legacy session created without a
 * plan: the old flow is unchanged and no verdict is ever surfaced for it.
 */
export interface PerformanceDeviation {
  k: number;
  plan: number[];
  planLength: number;
  prefix: DeviationReading;
  final: DeviationReading;
}

export interface Performance {
  id: string;
  name: string;
  status: PerformanceStatus;
  version: number;
  requestId: string | null;
  cues: number[];
  deviation: PerformanceDeviation | null;
}

/**
 * Internal record: the fixed plan and its incremental DP tracker live here
 * and never leave the store; snapshots carry only the derived deviation view
 * plus a copy of the plan.
 */
interface SessionRecord {
  id: string;
  name: string;
  status: PerformanceStatus;
  version: number;
  requestId: string | null;
  cues: number[];
  /** Present only for sessions created with a plan; null = legacy session. */
  tracker: PlanDeviation | null;
}

export interface CreateCommand {
  type: 'create';
  name: string;
  requestId: string;
  /** Fixed planned cue sequence; undefined together with k keeps the old flow. */
  plan?: number[];
  /** Tolerance for the fixed plan; 0 is a valid value. */
  k?: number;
}

export interface TransitionCommand {
  type: 'transition';
  performanceId: string;
  status: PerformanceStatus;
  expectedVersion: number;
  requestId: string;
}

export interface RegisterCueCommand {
  type: 'registerCue';
  performanceId: string;
  cue: number;
  expectedVersion: number;
  requestId: string;
}

export type PerformanceCommand = CreateCommand | TransitionCommand | RegisterCueCommand;

/** Rejection reasons surfaced alongside code COMMAND_REJECTED. */
export type RejectReason =
  | 'DUPLICATE_REQUEST'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_RUNNING';

// Legal status advance table. pending -> running, running <-> paused,
// running/paused -> ended (no resume required to seal). ended is terminal.
const LEGAL_TRANSITIONS: Record<PerformanceStatus, readonly PerformanceStatus[]> = {
  pending: ['running'],
  running: ['paused', 'ended'],
  paused: ['running', 'ended'],
  ended: [],
};

const CREATE_CHAIN_KEY = '__create__';

function reject(reason: RejectReason, message: string): never {
  throw new ApiError('COMMAND_REJECTED', message, 409, reason);
}

/**
 * Reject a replay of an already-committed request id. The message always
 * names the session the id *first* committed to (its stable global owner),
 * never the session the replay happened to target, so audit logs and
 * client retries see the same conclusion from every target.
 */
function rejectDuplicate(requestId: string, ownerId: string): never {
  reject(
    'DUPLICATE_REQUEST',
    `Request id "${requestId}" was already committed to session "${ownerId}".`,
  );
}

export class PerformanceStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Serial chain per requestId: one adjudication per id at a time, globally. */
  private readonly requestChains = new Map<string, Promise<unknown>>();
  // requestId of every *committed* command -> id of the session it first
  // committed to. Global, so a duplicate is detected no matter which
  // session (or create) it is replayed against afterwards.
  private readonly committedRequests = new Map<string, string>();

  /** Run `task` serially at the end of the chain keyed by `key`. */
  private async runExclusive<T>(
    chains: Map<string, Promise<unknown>>,
    key: string,
    task: () => T | Promise<T>,
  ): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = previous.then(() => gate);
    chains.set(key, slot);
    try {
      await previous;
    } catch {
      // A prior task's rejection is delivered to its own caller.
    }
    try {
      return await task();
    } finally {
      release();
      // Remove the chain only if nobody queued behind us; otherwise the
      // last waiter performs the cleanup.
      if (chains.get(key) === slot) chains.delete(key);
    }
  }

  get(id: string): Performance {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ApiError(
        'SESSION_NOT_FOUND',
        `No performance session exists with id "${id}".`,
        404,
      );
    }
    return this.snapshot(session);
  }

  dispatch(command: PerformanceCommand): Promise<Performance> {
    // The global request-id slot wraps the per-session adjudication. Two
    // commands sharing an id cannot run their decide() sections at the
    // same time, so a cross-session loser always observes the winner's
    // committed id; the loser never touches any session.
    return this.runExclusive(this.requestChains, command.requestId, async () => {
      // Fast path: the id may have committed long before this request
      // arrived; reject without even entering the session chain.
      const owner = this.committedRequests.get(command.requestId);
      if (owner !== undefined) rejectDuplicate(command.requestId, owner);
      const key = command.type === 'create' ? CREATE_CHAIN_KEY : command.performanceId;
      return await this.runExclusive(this.chains, key, () => this.decide(command));
    });
  }

  /**
   * The decision procedure. Runs inside the request-id slot and the
   * per-session chain, so the whole read-check-write sequence is one
   * atomic step. All throws leave the store untouched (nothing is mutated
   * before the single commit at the end).
   */
  private decide(command: PerformanceCommand): Performance {
    // Rechecked inside every lock: an earlier contender (e.g. one queued
    // on the same session chain for another reason) may have committed the
    // id in the meantime. This check deliberately precedes the session
    // lookup, so replaying a committed id at a missing session reports the
    // duplicate instead of SESSION_NOT_FOUND, exactly like replaying it at
    // any existing foreign session.
    const ownerId = this.committedRequests.get(command.requestId);
    if (ownerId !== undefined) {
      rejectDuplicate(command.requestId, ownerId);
    }

    if (command.type === 'create') {
      // The plan is fixed here, at the single commit point, from the exact
      // values the envelope carried. No later command and no page draft can
      // mutate it — the tracker is constructed once and only ever appends.
      const tracker =
        command.plan !== undefined && command.k !== undefined
          ? new PlanDeviation(command.plan, command.k)
          : null;
      const session: SessionRecord = {
        id: randomUUID(),
        name: command.name,
        status: 'pending',
        version: 1,
        requestId: command.requestId,
        cues: [],
        tracker,
      };
      this.sessions.set(session.id, session);
      // Single commit point for creates: the new session and the global
      // id record appear together.
      this.committedRequests.set(command.requestId, session.id);
      return this.snapshot(session);
    }

    const session = this.sessions.get(command.performanceId);
    if (!session) {
      throw new ApiError(
        'SESSION_NOT_FOUND',
        `No performance session exists with id "${command.performanceId}".`,
        404,
      );
    }

    // Only *committed* request ids count as duplicates. A rejected command
    // leaves the store untouched, so its request id is never recorded: the
    // caller may correct the precondition (version/transition/run-state)
    // and replay the very same request id without being falsely reported as
    // a duplicate. Recording happens exclusively at the commit point below.

    if (command.expectedVersion !== session.version) {
      reject(
        'VERSION_CONFLICT',
        `expectedVersion ${command.expectedVersion} does not match current version ${session.version}.`,
      );
    }

    if (command.type === 'transition') {
      if (!LEGAL_TRANSITIONS[session.status].includes(command.status)) {
        reject(
          'ILLEGAL_TRANSITION',
          `Cannot move session from "${session.status}" to "${command.status}".`,
        );
      }
      session.status = command.status;
    } else {
      if (session.status !== 'running') {
        reject(
          'NOT_RUNNING',
          `Cues can only be registered while running; session is "${session.status}".`,
        );
      }
      session.cues.push(command.cue);
      // The DP frontier advances inside the same commit point as the cue
      // append: a committed cue always moves the distance boundary exactly
      // once, and a rejected throw above never reaches this line, so a
      // refused cue cannot advance the deviation state.
      session.tracker?.advance(command.cue);
    }

    // Single commit point: version bump and request-id recording happen
    // together with the state change.
    session.version += 1;
    session.requestId = command.requestId;
    this.committedRequests.set(command.requestId, session.id);
    return this.snapshot(session);
  }

  private snapshot(session: SessionRecord): Performance {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      version: session.version,
      requestId: session.requestId,
      cues: [...session.cues],
      // The view (including the fixed plan copy) is derived from the same
      // committed record and version as every other snapshot field, so a
      // client displaying one snapshot always sees a single-version answer.
      deviation: session.tracker ? session.tracker.view() : null,
    };
  }
}
