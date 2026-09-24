import { describe, expect, it } from 'vitest';
import { PlanDeviation } from '../src/plan-deviation.js';

/** Full O(n*m) oracle for the prefix minimum AND the full-plan distance. */
function oracle(plan: number[], live: number[]): { prefix: number[]; final: number[] } {
  const n = live.length;
  const m = plan.length;
  const d: number[][] = [Array.from({ length: m + 1 }, (_, j) => j)];
  const prefix: number[] = [];
  const final: number[] = [];
  for (let i = 1; i <= n; i++) {
    const row = new Array<number>(m + 1);
    row[0] = i;
    let bound = i;
    for (let j = 1; j <= m; j++) {
      row[j] = Math.min(
        d[i - 1][j] + 1,
        row[j - 1] + 1,
        d[i - 1][j - 1] + (live[i - 1] === plan[j - 1] ? 0 : 2),
      );
      if (row[j] < bound) bound = row[j];
    }
    d.push(row);
    prefix.push(bound);
    final.push(row[m]);
  }
  return { prefix, final };
}

function check(plan: number[], live: number[], k: number): void {
  const tracker = new PlanDeviation(plan, k);
  const expected = oracle(plan, live);
  for (let i = 0; i < live.length; i++) {
    const view = tracker.advance(live[i]);
    const p = expected.prefix[i];
    const f = expected.final[i];
    expect(view.prefix).toEqual(p <= k ? { status: 'ok', distance: p } : { status: 'exceeded' });
    expect(view.final).toEqual(f <= k ? { status: 'ok', distance: f } : { status: 'exceeded' });
    expect(view.plan).toEqual(plan);
    expect(view.k).toBe(k);
  }
}

describe('PlanDeviation — agreement with the full-DP oracle', () => {
  it('matches on hand-built cases (match/insert/delete/substitution)', () => {
    check([101, 102, 103, 104], [101, 102, 103, 104], 0);
    check([101, 102, 103, 104], [101, 103, 104], 1);
    check([101, 102, 103], [101, 102, 103, 104], 1);
    check([1, 2, 3], [1, 9, 3], 2);
    check([7, 8, 9], [99, 98], 2);
    check([1, 2, 3, 4, 5], [9, 8, 7, 6, 5], 8);
    check([], [1, 2, 3], 3);
    check([1, 2, 3], [], 3);
    check([], [], 0);
  });

  it('k = 0 only tolerates the exact plan prefix walk', () => {
    check([5, 5, 5], [5, 5, 5], 0);
    check([5, 5, 5], [5, 9, 5], 0);
  });

  it('once exceeded it stays exceeded (prefix-minimum monotonicity)', () => {
    const tracker = new PlanDeviation([1, 2], 1);
    tracker.advance(9); // bound = 1 (delete 9 vs empty prefix): still recoverable
    let view = tracker.advance(8); // two stray cues => 2 > 1: exceeded
    expect(view.prefix).toEqual({ status: 'exceeded' });
    view = tracker.advance(1);
    expect(view.prefix).toEqual({ status: 'exceeded' });
    view = tracker.advance(2);
    expect(view.prefix).toEqual({ status: 'exceeded' });
    // Full plan is recoverable at the end ([9,8,1,2] -> [1,2] costs 2) but the
    // mid-show prefix reading already declared the show unrecoverable: the
    // two readings are independent and both stay truthful.
    expect(view.final).toEqual({ status: 'exceeded' }); // 2 > k = 1
  });

  it('randomised short cases: every row matches the oracle', () => {
    let seed = 1234;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    for (let t = 0; t < 1000; t++) {
      const alphabet = 1 + Math.floor(rand() * 4);
      const m = Math.floor(rand() * 8);
      const n = Math.floor(rand() * 10);
      const k = Math.floor(rand() * 5);
      const plan = Array.from({ length: m }, () => Math.floor(rand() * alphabet));
      const live = Array.from({ length: n }, () => Math.floor(rand() * alphabet));
      check(plan, live, k);
    }
  });
});

describe('PlanDeviation — scale', () => {
  it('handles a 50 000-cue plan and show at k = 500', () => {
    const N = 50_000;
    const plan = Array.from({ length: N }, (_, i) => i + 1);
    const live = plan.slice();
    live[0] = 999_999; // one substitution => distance 2

    const tracker = new PlanDeviation(plan, 500);
    let last = tracker.view();
    const start = Date.now();
    for (let i = 0; i < live.length; i++) last = tracker.advance(live[i]);
    expect(Date.now() - start).toBeLessThan(30_000);
    expect(last.final).toEqual({ status: 'ok', distance: 2 });
    // Boundary flips as the substitution passes (distance 2 to the prefix
    // ending at the changed element is the worst point; k=500 covers it).
    expect(last.prefix).toEqual({ status: 'ok', distance: 2 });
  }, 40_000);

  it('large length gap pins the full-plan cell to exceeded without crashing', () => {
    const plan = new Array(5000).fill(7);
    const tracker = new PlanDeviation(plan, 3);
    for (const cue of [1, 2, 3, 4]) {
      const view = tracker.advance(cue);
      expect(view.planLength).toBe(5000);
      if (cue >= 1) expect(view.final).toEqual({ status: 'exceeded' });
    }
  });
});
