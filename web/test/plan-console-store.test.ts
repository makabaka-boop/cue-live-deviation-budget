import { describe, expect, it } from 'vitest';
import { ConsoleStore } from '../src/stores';
import {
  controlledConsoleDeps,
  FakeApiError,
  flush,
  perf,
} from './helpers';
import type { Performance, PerformanceDeviation } from '../src/api';

function dev(over: Partial<PerformanceDeviation> & { plan: number[]; k: number }): PerformanceDeviation {
  return {
    planLength: over.plan.length,
    prefix: over.prefix ?? { status: 'ok', distance: 0 },
    final: over.final ?? { status: 'ok', distance: over.plan.length },
    ...over,
  };
}

describe('ConsoleStore — optional fixed plan at creation', () => {
  it('sends plan+k on create and consumes the plan drafts on commit', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('晚场');
    store.setPlanDraft('[101, 102]');
    store.setPlanKDraft('3');
    store.create();
    await flush();

    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toMatchObject({
      command: 'create',
      name: '晚场',
      plan: [101, 102],
      k: 3,
    });

    commands[0].resolve(
      perf({
        id: 'P',
        status: 'pending',
        version: 1,
        deviation: dev({ plan: [101, 102], k: 3, final: { status: 'ok', distance: 2 } }),
      }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.id).toBe('P');
    // The frozen plan drafts are cleared only once the create commits; the
    // name stays for the stage manager's record.
    expect(s.planDraft).toBe('');
    expect(s.planKDraft).toBe('');
    expect(s.nameDraft).toBe('晚场');
  });

  it('creates a legacy session with no plan/k when both drafts are blank', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('旧场次');
    store.create();
    await flush();
    const payload = commands[0].payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('plan');
    expect(payload).not.toHaveProperty('k');
  });

  it('rejects client-side malformed plan drafts without sending', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    store.setName('晚场');

    store.setPlanDraft('not-json');
    store.setPlanKDraft('1');
    store.create();
    expect(commands).toHaveLength(0);
    expect(store.getSnapshot().error?.code).toBe('INVALID_JSON');

    store.setPlanDraft('[1]');
    store.setPlanKDraft('');
    store.create();
    expect(commands).toHaveLength(0);
    expect(store.getSnapshot().error?.code).toBe('INVALID_BODY');

    store.setPlanDraft('');
    store.setPlanKDraft('2');
    store.create();
    expect(commands).toHaveLength(0);
    expect(store.getSnapshot().error?.code).toBe('INVALID_BODY');

    store.setPlanDraft('[1.5]');
    store.setPlanKDraft('1');
    store.create();
    expect(commands).toHaveLength(0);
    expect(store.getSnapshot().error?.code).toBe('INVALID_ELEMENT');

    store.setPlanDraft('[1]');
    store.setPlanKDraft('501');
    store.create();
    expect(commands).toHaveLength(0);
    expect(store.getSnapshot().error?.code).toBe('INVALID_K');

    // Drafts remain for correction; the fixed-plan rule means editing after a
    // failed attempt changes only the next create, never an existing show.
    expect(store.getSnapshot().planDraft).toBe('[1]');
  });

  it('a superseded create response does not wipe the plan drafts of a newer action', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);

    store.setName('第一场');
    store.setPlanDraft('[1]');
    store.setPlanKDraft('1');
    store.create();
    await flush();
    const first = commands.shift()!;

    // Stage manager starts a second create before the first answers.
    store.setPlanDraft('[2, 3]');
    store.setPlanKDraft('2');
    store.create();
    await flush();
    const second = commands.shift()!;

    second.resolve(perf({ id: 'B', status: 'pending', version: 1 }));
    await flush();
    first.resolve(perf({ id: 'A', status: 'pending', version: 1 }));
    await flush();

    const s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    // The late first answer must not clear the drafts (already consumed by B).
    expect(s.planDraft).toBe('');
  });
});

async function openPlanned(
  store: ConsoleStore,
  commands: ReturnType<typeof controlledConsoleDeps>['commands'],
  plan: number[],
  k: number,
): Promise<void> {
  store.setName('计划场');
  store.setPlanDraft(JSON.stringify(plan));
  store.setPlanKDraft(String(k));
  store.create();
  await flush();
  commands.shift()!.resolve(
    perf({
      id: 'P',
      status: 'pending',
      version: 1,
      deviation: dev({ plan, k, prefix: { status: 'ok', distance: 0 }, final: { status: 'ok', distance: plan.length } }),
    }),
  );
  await flush();
  store.transition('running');
  await flush();
  commands.shift()!.resolve(
    perf({
      id: 'P',
      status: 'running',
      version: 2,
      deviation: dev({ plan, k, prefix: { status: 'ok', distance: 0 }, final: { status: 'ok', distance: plan.length } }),
    }),
  );
  await flush();
}

describe('ConsoleStore — deviation verdict travels with one session version', () => {
  it('every committed cue replaces the verdict as a single-version snapshot', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    const plan = [101, 102];
    await openPlanned(store, commands, plan, 2);

    store.setCueDraft('101');
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      perf({
        id: 'P',
        status: 'running',
        version: 3,
        cues: [101],
        deviation: dev({
          plan,
          k: 2,
          prefix: { status: 'ok', distance: 0 },
          final: { status: 'ok', distance: 1 },
        }),
      }),
    );
    await flush();
    let s = store.getSnapshot();
    expect(s.session?.version).toBe(3);
    expect(s.session?.deviation?.prefix).toEqual({ status: 'ok', distance: 0 });
    expect(s.session?.deviation?.final).toEqual({ status: 'ok', distance: 1 });

    store.setCueDraft('999');
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      perf({
        id: 'P',
        status: 'running',
        version: 4,
        cues: [101, 999],
        deviation: dev({
          plan,
          k: 0,
          prefix: { status: 'exceeded' },
          final: { status: 'exceeded' },
        }),
      }),
    );
    await flush();
    s = store.getSnapshot();
    // Plan, verdict and version all come from the same v4 snapshot object.
    expect(s.session?.version).toBe(4);
    expect(s.session?.deviation?.prefix).toEqual({ status: 'exceeded' });
    expect(s.session?.deviation?.k).toBe(0);
    expect(s.session?.deviation?.plan).toEqual(plan);
  });

  it('a rejected cue leaves the previous version AND its verdict in place', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPlanned(store, commands, [101], 2);

    store.setCueDraft('202');
    store.registerCue();
    await flush();
    commands.shift()!.reject(new FakeApiError('COMMAND_REJECTED', 'VERSION_CONFLICT'));
    await flush();

    const s = store.getSnapshot();
    expect(s.session?.version).toBe(2);
    expect(s.session?.deviation?.prefix).toEqual({ status: 'ok', distance: 0 });
    expect(s.cueDraft).toBe('202');
  });

  it('pause does not change the verdict; resume and end carry their own versioned verdicts', async () => {
    const { deps, commands } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    const plan = [1, 2, 3];
    await openPlanned(store, commands, plan, 3);

    store.setCueDraft('1');
    store.registerCue();
    await flush();
    commands.shift()!.resolve(
      perf({
        id: 'P',
        version: 3,
        cues: [1],
        deviation: dev({
          plan,
          k: 3,
          prefix: { status: 'ok', distance: 0 },
          final: { status: 'ok', distance: 2 },
        }),
      }),
    );
    await flush();

    store.transition('paused');
    await flush();
    commands.shift()!.resolve(
      perf({
        id: 'P',
        status: 'paused',
        version: 4,
        cues: [1],
        deviation: dev({
          plan,
          k: 3,
          prefix: { status: 'ok', distance: 0 },
          final: { status: 'ok', distance: 2 },
        }),
      }),
    );
    await flush();
    // A pause advances the version but never the deviation frontier.
    let s = store.getSnapshot();
    expect(s.session?.status).toBe('paused');
    expect(s.session?.version).toBe(4);
    expect(s.session?.deviation?.prefix).toEqual({ status: 'ok', distance: 0 });

    store.transition('ended');
    await flush();
    commands.shift()!.resolve(
      perf({
        id: 'P',
        status: 'ended',
        version: 5,
        cues: [1],
        deviation: dev({
          plan,
          k: 3,
          prefix: { status: 'ok', distance: 0 },
          final: { status: 'ok', distance: 2 },
        }),
      }),
    );
    await flush();
    s = store.getSnapshot();
    expect(s.session?.status).toBe('ended');
    expect(s.session?.deviation?.final).toEqual({ status: 'ok', distance: 2 });
  });
});

describe('ConsoleStore — session switches never mix plans or verdicts', () => {
  it('loading session B replaces plan, verdict and cues together; a late A cue answer is ignored', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPlanned(store, commands, [1, 2], 1);

    store.setCueDraft('1');
    store.registerCue();
    await flush();
    const cmdA = commands.shift()!;

    // Switch view to a different, already-exceeded planned session B.
    store.setLoadId('B-id');
    store.load();
    await flush();
    loads.shift()!.resolve(
      perf({
        id: 'B',
        name: '另一场',
        status: 'running',
        version: 9,
        cues: [77],
        deviation: dev({
          plan: [9, 8],
          k: 1,
          prefix: { status: 'exceeded' },
          final: { status: 'exceeded' },
        }),
      }),
    );
    await flush();

    let s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    expect(s.session?.deviation?.plan).toEqual([9, 8]);
    expect(s.session?.deviation?.prefix).toEqual({ status: 'exceeded' });
    expect(s.session?.cues).toEqual([77]);

    // Late answer for A commits server-side but cannot replace B's view.
    cmdA.resolve(
      perf({
        id: 'A',
        status: 'running',
        version: 3,
        cues: [1],
        deviation: dev({
          plan: [1, 2],
          k: 1,
          prefix: { status: 'ok', distance: 0 },
          final: { status: 'ok', distance: 1 },
        }),
      }),
    );
    await flush();
    s = store.getSnapshot();
    expect(s.session?.id).toBe('B');
    expect(s.session?.version).toBe(9);
    expect(s.session?.deviation?.plan).toEqual([9, 8]);
    expect(s.session?.deviation?.prefix).toEqual({ status: 'exceeded' });
    expect(s.session?.cues).toEqual([77]);
  });

  it('legacy session shows no deviation verdict even next to a planned session', async () => {
    const { deps, commands, loads } = controlledConsoleDeps();
    const store = new ConsoleStore(deps);
    await openPlanned(store, commands, [1], 1);
    expect(store.getSnapshot().session?.deviation).not.toBeNull();

    store.setLoadId('legacy');
    store.load();
    await flush();
    loads.shift()!.resolve(
      perf({ id: 'L', status: 'running', version: 4, cues: [5], deviation: null }),
    );
    await flush();
    const s = store.getSnapshot();
    expect(s.session?.id).toBe('L');
    expect(s.session?.deviation).toBeNull();
    expect(s.session?.cues).toEqual([5]);
  });
});
