import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Performance } from '../src/performance.js';
import { PlanDeviation } from '../src/plan-deviation.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function sendCommand(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/performances/commands',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function getPerformance(id: string) {
  return app.inject({ method: 'GET', url: `/api/performances/${id}` });
}

let seq = 0;
function rid(label: string): string {
  seq += 1;
  return `plan-${label}-${seq}`;
}

// ---------------------------------------------------------------- oracle

/**
 * Short-sequence FULL dynamic-programming oracle (insertion/deletion cost 1,
 * substitution cost 2). It builds the whole O(n * m) matrix — deliberately
 * different from the banded production tracker — so the tracker's per-prefix
 * boundary and the end verdict can both be cross-checked independently.
 */
class FullDPOracle {
  private readonly d: number[][];
  constructor(private readonly plan: number[]) {
    const m = plan.length;
    this.d = [];
    for (let i = 0; i < 1000; i++) {
      const row = new Array<number>(m + 1).fill(0);
      row[0] = i;
      this.d.push(row);
    }
    for (let j = 0; j <= m; j++) this.d[0][j] = j;
  }

  /** Append one live cue and return {prefix, final} EXACT distances. */
  push(cue: number, observedLength: number): { prefix: number; final: number } {
    const i = observedLength;
    const m = this.plan.length;
    let prefix = this.d[i][0]; // distance to the empty prefix
    for (let j = 1; j <= m; j++) {
      this.d[i][j] = Math.min(
        this.d[i - 1][j] + 1,
        this.d[i][j - 1] + 1,
        this.d[i - 1][j - 1] + (cue === this.plan[j - 1] ? 0 : 2),
      );
      if (this.d[i][j] < prefix) prefix = this.d[i][j];
    }
    return { prefix, final: this.d[i][m] };
  }
}

type Reading = { status: 'ok'; distance: number } | { status: 'exceeded' };

function expectReading(actual: Reading | undefined, exact: number, k: number): void {
  if (exact <= k) {
    expect(actual).toEqual({ status: 'ok', distance: exact });
  } else {
    expect(actual).toEqual({ status: 'exceeded' });
  }
}

async function createPlanned(
  name: string,
  plan: number[],
  k: number,
): Promise<{ id: string; p: Performance }> {
  const res = await sendCommand({ command: 'create', name, plan, k, requestId: rid('create') });
  expect(res.statusCode).toBe(200);
  const p = res.json().performance as Performance;
  expect(p.deviation).toMatchObject({ k, planLength: plan.length, plan });
  return { id: p.id, p };
}

async function start(id: string, version: number): Promise<void> {
  const res = await sendCommand({
    command: 'transition',
    performanceId: id,
    status: 'running',
    expectedVersion: version,
    requestId: rid('start'),
  });
  expect(res.statusCode).toBe(200);
}

describe('planned sessions — per-cue boundary against the full-DP oracle', () => {
  it('tracks the prefix minimum and full-plan distance after every committed cue', async () => {
    const plan = [101, 102, 103, 104, 105];
    const k = 2;
    const { id } = await createPlanned('逐条预言机', plan, k);
    await start(id, 1);

    const oracle = new FullDPOracle(plan);
    // Insertion drift (101.5-ish values), a substitution and a wrong cue —
    // small hand-made sequence exercising matches, inserts and deletions.
    const live = [101, 102, 103, 104, 105];

    for (let i = 0; i < live.length; i++) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: id,
        cue: live[i],
        expectedVersion: 2 + i,
        requestId: rid(`cue-${i}`),
      });
      expect(res.statusCode).toBe(200);
      const p = (res.json() as { performance: Performance }).performance;
      const expected = oracle.push(live[i], i + 1);
      expect(p.version).toBe(3 + i);
      expectReading(p.deviation!.prefix, expected.prefix, k);
      expectReading(p.deviation!.final, expected.final, k);
      expect(p.deviation!.plan).toEqual(plan); // fixed plan rides every version
    }
  });

  it('flags unrecoverable exactly when the oracle prefix minimum passes k, and stays flagged', async () => {
    const plan = [10, 20, 30, 40, 50];
    const k = 2;
    const { id } = await createPlanned('中途超限', plan, k);
    await start(id, 1);

    const oracle = new FullDPOracle(plan);
    const live = [99, 98, 97];

    for (let i = 0; i < live.length; i++) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: id,
        cue: live[i],
        expectedVersion: 2 + i,
        requestId: rid(`bad-${i}`),
      });
      const p = (res.json() as { performance: Performance }).performance;
      const expected = oracle.push(live[i], i + 1);
      expectReading(p.deviation!.prefix, expected.prefix, k);
      // Once the oracle says every prefix is beyond k, the verdict flips and,
      // by prefix-minimum monotonicity, can never flip back.
      if (expected.prefix > k) {
        expect(p.deviation!.prefix).toEqual({ status: 'exceeded' });
      }
    }

    // Three unrelated cues: every alignment needs at least three deletions
    // (plus whatever matches cost), so the boundary exceeded k after cue 3.
    // Matching cues arriving afterwards must NOT rescue the show.
    for (const [i, cue] of [10, 20].entries()) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: id,
        cue,
        expectedVersion: 5 + i,
        requestId: rid(`late-${i}`),
      });
      const p = (res.json() as { performance: Performance }).performance;
      expect(p.deviation!.prefix).toEqual({ status: 'exceeded' });
    }
  });

  it('agrees with the oracle on many random short plans/lives for every k', () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };

    for (let trial = 0; trial < 400; trial++) {
      const alphabet = 1 + Math.floor(rand() * 5);
      const m = Math.floor(rand() * 9);
      const plan = Array.from({ length: m }, () => Math.floor(rand() * alphabet));
      const k = Math.floor(rand() * 6);
      const n = Math.floor(rand() * 12);
      const live = Array.from({ length: n }, () => Math.floor(rand() * alphabet));

      const tracker = new PlanDeviation(plan, k);
      // Full matrix oracle, local to the trial.
      const D: number[][] = [Array.from({ length: m + 1 }, (_, j) => j)];

      let view = tracker.view();
      expectReading(view.prefix, 0, k);
      expectReading(view.final, m, k);

      for (let i = 1; i <= n; i++) {
        const row = new Array<number>(m + 1);
        row[0] = i;
        let prefixMin = i;
        for (let j = 1; j <= m; j++) {
          row[j] = Math.min(
            D[i - 1][j] + 1,
            row[j - 1] + 1,
            D[i - 1][j - 1] + (live[i - 1] === plan[j - 1] ? 0 : 2),
          );
          if (row[j] < prefixMin) prefixMin = row[j];
        }
        D.push(row);

        view = tracker.advance(live[i - 1]);
        expectReading(view.prefix, prefixMin, k);
        expectReading(view.final, row[m], k);

        // Monotonicity invariant checked by the oracle too: prefix minima
        // never decrease as live cues are appended.
        if (i > 1) {
          let prevMin = i - 1;
          for (let j = 0; j <= m; j++) prevMin = Math.min(prevMin, D[i - 1][j]);
          expect(prefixMin).toBeGreaterThanOrEqual(prevMin);
        }
      }
    }
  });
});

describe('planned sessions — end verdict against the full plan', () => {
  it('seals with the full-plan distance, recoverable -> exact, too far -> exceeded', async () => {
    const plan = [1, 2, 3, 4, 5];
    const { id } = await createPlanned('终局结论', plan, 3);
    await start(id, 1);
    // [1, 2, 4, 5]: one deletion (3) => distance 1.
    const live = [1, 2, 4, 5];
    for (let i = 0; i < live.length; i++) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: id,
        cue: live[i],
        expectedVersion: 2 + i,
        requestId: rid(`ok-cue-${i}`),
      });
      expect(res.statusCode).toBe(200);
    }
    const end = await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'ended',
      expectedVersion: 6,
      requestId: rid('end-ok'),
    });
    expect(end.statusCode).toBe(200);
    const p = (end.json() as { performance: Performance }).performance;
    expect(p.status).toBe('ended');
    expect(p.deviation!.final).toEqual({ status: 'ok', distance: 1 });

    // A second show beyond recovery: two substitutions alone cost 4 > 3.
    const { id: id2 } = await createPlanned('终局超限', plan, 3);
    await start(id2, 1);
    for (const [i, cue] of [9, 8, 7, 6, 5].entries()) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: id2,
        cue,
        expectedVersion: 2 + i,
        requestId: rid(`far-cue-${i}`),
      });
      expect(res.statusCode).toBe(200);
    }
    const end2 = await sendCommand({
      command: 'transition',
      performanceId: id2,
      status: 'ended',
      expectedVersion: 7,
      requestId: rid('end-far'),
    });
    const p2 = (end2.json() as { performance: Performance }).performance;
    expect(p2.deviation!.final).toEqual({ status: 'exceeded' });
  });

  it('ending a show with no cues compares the empty sequence to the full plan', async () => {
    const { id, p } = await createPlanned('零 cue 收场', [1, 2, 3], 3);
    expect(p.deviation!.final).toEqual({ status: 'ok', distance: 3 });
    await start(id, 1);
    const end = await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'ended',
      expectedVersion: 2,
      requestId: rid('end-empty'),
    });
    const sealed = (end.json() as { performance: Performance }).performance;
    expect(sealed.deviation!.final).toEqual({ status: 'ok', distance: 3 });

    // Plan longer than k with no cues is already over budget.
    const { id: id2 } = await createPlanned('零 cue 超限', [1, 2, 3, 4], 3);
    const p2 = (await getPerformance(id2)).json().performance as Performance;
    expect(p2.deviation!.final).toEqual({ status: 'exceeded' });
  });
});

describe('planned sessions — pause / resume do not advance distance state', () => {
  it('pauses, refuses cues (NOT_RUNNING) and resumes with the boundary frozen', async () => {
    const plan = [7, 8, 9];
    const k = 1;
    const { id } = await createPlanned('暂停核验', plan, k);
    await start(id, 1);

    const first = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 7,
      expectedVersion: 2,
      requestId: rid('cue-7'),
    });
    let p = (first.json() as { performance: Performance }).performance;
    expect(p.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });
    expect(p.version).toBe(3);

    const pause = await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'paused',
      expectedVersion: 3,
      requestId: rid('pause'),
    });
    p = (pause.json() as { performance: Performance }).performance;
    expect(p.version).toBe(4);
    // A transition never advances the DP: the boundary is exactly as left.
    expect(p.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });
    expect(p.cues).toEqual([7]);

    // Cue while paused: refused, boundary and cues untouched.
    const refused = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 99,
      expectedVersion: 4,
      requestId: rid('paused-cue'),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('NOT_RUNNING');

    // Same request id is reusable after the pause ends.
    const resume = await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'running',
      expectedVersion: 4,
      requestId: rid('resume'),
    });
    expect(resume.statusCode).toBe(200);

    const loaded = (await getPerformance(id)).json().performance as Performance;
    expect(loaded.cues).toEqual([7]);
    expect(loaded.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });
  });

  it('reuses the rejected cue request id after resuming and advances exactly once', async () => {
    const plan = [7, 8, 9];
    const { id } = await createPlanned('暂停后重试', plan, 2);
    await start(id, 1);
    await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'paused',
      expectedVersion: 2,
      requestId: rid('p'),
    });

    const envelope = {
      command: 'registerCue' as const,
      performanceId: id,
      cue: 42,
      expectedVersion: 3,
      requestId: 'paused-retry-id',
    };
    const refused = await sendCommand(envelope);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('NOT_RUNNING');

    await sendCommand({
      command: 'transition',
      performanceId: id,
      status: 'running',
      expectedVersion: 3,
      requestId: rid('r'),
    });
    envelope.expectedVersion = 4;
    const committed = await sendCommand(envelope);
    expect(committed.statusCode).toBe(200);
    const p = (committed.json() as { performance: Performance }).performance;
    expect(p.cues).toEqual([42]);
    expect(p.version).toBe(5);
    // Exactly one advance: distance to the best prefix of [7,8,9] for [42]
    // is deleting 42 + inserting the chosen prefix... best is delete only
    // (align to empty prefix) = 1.
    expect(p.deviation!.prefix).toEqual({ status: 'ok', distance: 1 });

    // Id now spent: replay does not double-advance.
    const replay = await sendCommand(envelope);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.reason).toBe('DUPLICATE_REQUEST');
    const again = (await getPerformance(id)).json().performance as Performance;
    expect(again.cues).toEqual([42]);
    expect(again.version).toBe(5);
    expect(again.deviation!.prefix).toEqual({ status: 'ok', distance: 1 });
  });
});

describe('planned sessions — version conflicts, replays and rejects never advance the DP', () => {
  it('stale-version cue leaves version, cues and boundary exactly unchanged', async () => {
    const plan = [1, 2, 3];
    const { id } = await createPlanned('版本冲突不推进', plan, 1);
    await start(id, 1);
    await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 1,
      expectedVersion: 2,
      requestId: rid('c1'),
    });

    const stale = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 999,
      expectedVersion: 2, // current is 3
      requestId: rid('stale'),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.reason).toBe('VERSION_CONFLICT');

    const loaded = (await getPerformance(id)).json().performance as Performance;
    expect(loaded.version).toBe(3);
    expect(loaded.cues).toEqual([1]);
    expect(loaded.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });
    expect(loaded.deviation!.plan).toEqual(plan);
  });

  it('replaying a committed cue request id appends no second cue and moves no boundary', async () => {
    const plan = [5, 6];
    const { id } = await createPlanned('重放不推进', plan, 2);
    await start(id, 1);
    const committed = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 5,
      expectedVersion: 2,
      requestId: 'replay-cue-id',
    });
    expect(committed.statusCode).toBe(200);

    const replay = await sendCommand({
      command: 'registerCue',
      performanceId: id,
      cue: 5,
      expectedVersion: 3,
      requestId: 'replay-cue-id',
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.reason).toBe('DUPLICATE_REQUEST');

    const loaded = (await getPerformance(id)).json().performance as Performance;
    expect(loaded.cues).toEqual([5]);
    expect(loaded.version).toBe(3);
  });

  it('invalid cue envelopes are rejected before adjudication and never reach the DP', async () => {
    const { id } = await createPlanned('信封非法', [1], 1);
    await start(id, 1);
    for (const cue of [1.5, '7', null]) {
      const res = await sendCommand({
        command: 'registerCue',
        performanceId: id,
        cue,
        expectedVersion: 2,
        requestId: rid('bad-cue'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CUE');
    }
    const loaded = (await getPerformance(id)).json().performance as Performance;
    expect(loaded.version).toBe(2);
    expect(loaded.cues).toEqual([]);
    expect(loaded.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });
  });
});

describe('planned sessions — cross-session independence', () => {
  it('two planned sessions keep separate fixed plans and independent boundaries', async () => {
    const a = await createPlanned('场次甲', [1, 2, 3], 1);
    const b = await createPlanned('场次乙', [7, 8, 9], 1);
    await start(a.id, 1);
    await start(b.id, 1);

    // Cue into A while the request flow interleaves with B.
    const cueA = await sendCommand({
      command: 'registerCue',
      performanceId: a.id,
      cue: 1,
      expectedVersion: 2,
      requestId: 'cross-a-cue-id',
    });
    expect((cueA.json() as any).performance.deviation.plan).toEqual([1, 2, 3]);

    // A wrong cue lands in B and already exceeds k=1 (best prefix = empty,
    // one deletion = 1, still recoverable); the second wrong cue exceeds it.
    await sendCommand({
      command: 'registerCue',
      performanceId: b.id,
      cue: 99,
      expectedVersion: 2,
      requestId: rid('b-cue1'),
    });
    const cueB2 = await sendCommand({
      command: 'registerCue',
      performanceId: b.id,
      cue: 98,
      expectedVersion: 3,
      requestId: rid('b-cue2'),
    });
    const pB = (cueB2.json() as { performance: Performance }).performance;
    expect(pB.deviation!.prefix).toEqual({ status: 'exceeded' });

    // A is unaffected by B going off the rails.
    const pA = ((await getPerformance(a.id)).json() as { performance: Performance }).performance;
    expect(pA.deviation!.plan).toEqual([1, 2, 3]);
    expect(pA.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });

    // The fixed plan survives a later page-draft-shaped attempt: there is no
    // command to mutate it; a create replay is rejected as a duplicate and
    // creates nothing new.
    const replayCreate = await sendCommand({
      command: 'create',
      name: '伪装改计划',
      plan: [100, 200],
      k: 0,
      requestId: 'cross-a-cue-id', // A's already-committed cue id
    });
    expect(replayCreate.statusCode).toBe(409);
    expect(replayCreate.json().error.reason).toBe('DUPLICATE_REQUEST');

    const pA2 = ((await getPerformance(a.id)).json() as { performance: Performance }).performance;
    expect(pA2.deviation!.plan).toEqual([1, 2, 3]);
  });
});

describe('planned sessions — create envelope validation and legacy compatibility', () => {
  it('rejects malformed plan/k pairs without creating a session', async () => {
    const bad: Array<{ payload: unknown; code: string }> = [
      { payload: { command: 'create', name: 'x', k: 2, requestId: rid('v1') }, code: 'INVALID_BODY' },
      { payload: { command: 'create', name: 'x', plan: [1], requestId: rid('v2') }, code: 'INVALID_BODY' },
      { payload: { command: 'create', name: 'x', plan: [1.5], k: 1, requestId: rid('v3') }, code: 'INVALID_ELEMENT' },
      { payload: { command: 'create', name: 'x', plan: 'x', k: 1, requestId: rid('v4') }, code: 'INVALID_BODY' },
      { payload: { command: 'create', name: 'x', plan: [], k: 501, requestId: rid('v5') }, code: 'INVALID_K' },
      { payload: { command: 'create', name: 'x', plan: [], k: -1, requestId: rid('v6') }, code: 'INVALID_K' },
    ];
    for (const { payload, code } of bad) {
      const res = await sendCommand(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(code);
    }

    // An empty plan with k = 0 is a legitimate fixed plan.
    const res = await sendCommand({
      command: 'create',
      name: '空计划',
      plan: [],
      k: 0,
      requestId: rid('empty-plan'),
    });
    expect(res.statusCode).toBe(200);
    const p = (res.json() as { performance: Performance }).performance;
    expect(p.deviation).toMatchObject({ k: 0, planLength: 0, plan: [] });
    expect(p.deviation!.prefix).toEqual({ status: 'ok', distance: 0 });
  });

  it('plan longer than 50 000 is rejected as ARRAY_TOO_LONG', async () => {
    const res = await sendCommand({
      command: 'create',
      name: '超长计划',
      plan: new Array(50_001).fill(0),
      k: 500,
      requestId: rid('too-long'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ARRAY_TOO_LONG');
  });

  it('legacy sessions created without plan/k keep deviation null and the old flow exactly', async () => {
    const res = await sendCommand({
      command: 'create',
      name: '旧场次',
      requestId: rid('legacy'),
    });
    expect(res.statusCode).toBe(200);
    const created = (res.json() as { performance: Performance }).performance;
    expect(created.deviation).toBeNull();
    expect(created).toMatchObject({ status: 'pending', version: 1, cues: [] });

    await start(created.id, 1);
    const cue = await sendCommand({
      command: 'registerCue',
      performanceId: created.id,
      cue: 123,
      expectedVersion: 2,
      requestId: rid('legacy-cue'),
    });
    const live = (cue.json() as { performance: Performance }).performance;
    expect(live.cues).toEqual([123]);
    expect(live.deviation).toBeNull();

    const end = await sendCommand({
      command: 'transition',
      performanceId: created.id,
      status: 'ended',
      expectedVersion: 3,
      requestId: rid('legacy-end'),
    });
    const sealed = (end.json() as { performance: Performance }).performance;
    expect(sealed.status).toBe('ended');
    expect(sealed.deviation).toBeNull();

    // GET keeps serving the legacy shape (refresh / reload path).
    const reloaded = (await getPerformance(created.id)).json().performance as Performance;
    expect(reloaded.deviation).toBeNull();
    expect(reloaded.cues).toEqual([123]);
  });
});
