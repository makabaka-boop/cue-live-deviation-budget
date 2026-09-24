/**
 * Incremental insertion/deletion distance from a growing *live* cue sequence
 * to a fixed *planned* cue sequence.
 *
 * A plan tracker is created once when the session is created and is the only
 * distance state the session owns. Every cue that actually commits appends
 * exactly one DP row (O(k) work, two rolling rows of O(m) ints); rejected
 * commands never reach this code, so replays, version conflicts and refused
 * cues cannot move the distance boundary by a single cell.
 *
 * Two readings come out of row i (live prefix A[0..i)):
 *
 *   - prefix reading: min over j of D(A[0..i), P[0..j)) — the cheapest plan
 *     prefix the show-so-far can still be aligned to. While this is <= k the
 *     deviation is "still recoverable"; above k it has left the allowed band
 *     for every prefix at once.
 *
 *   - final reading: D(A[0..i), P) against the FULL plan. This is the
 *     end-of-show comparison; it is reported alongside every snapshot so the
 *     sealed verdict needs no extra computation.
 *
 * The same banded DP as `distance.ts` applies: cells with |i - j| > k have
 * distance > k and are never on an in-budget optimal path, so only the stripe
 * |i - j| <= k is computed. Values above k collapse to the sentinel INF.
 *
 * Monotonicity of the prefix reading: appending one observed cue can never
 * lower min_j D(A_i, P_j). For any alignment script witnessing
 * D(A_{i+1}, P_j) = t, deleting the last live element from that script costs
 * at most one extra edit and yields a script from A_i to some P_{j'} with
 * cost <= t + 1; equivalently the optimum over prefixes obeys
 * m_i <= m_{i+1} (the prefix minimum is non-decreasing). A show that has
 * once exceeded k can therefore never return to "recoverable".
 */

export type DeviationReading =
  | { status: 'ok'; distance: number }
  | { status: 'exceeded' };

export interface DeviationView {
  /** Tolerance fixed at creation time. */
  k: number;
  /** The fixed plan, copied into every snapshot so views render one version. */
  plan: number[];
  planLength: number;
  /** min_j distance to the plan prefixes — the recoverable/exceeded verdict. */
  prefix: DeviationReading;
  /** Distance to the FULL plan — the end-of-show comparison. */
  final: DeviationReading;
}

export class PlanDeviation {
  private readonly plan: number[];
  private readonly k: number;
  private readonly INF: number;
  private prev: Int32Array;
  private curr: Int32Array;
  /** Number of committed live cues (= number of DP rows computed). */
  private observed = 0;
  /** Finite prefix minimum for the current row, or INF when exceeded. */
  private bound: number;
  /** Finite distance to the full plan for the current row, or INF. */
  private final: number;

  constructor(plan: number[], k: number) {
    this.plan = plan;
    this.k = k;
    this.INF = k + 1;

    const m = plan.length;
    this.prev = new Int32Array(m + 1).fill(this.INF);
    this.curr = new Int32Array(m + 1).fill(this.INF);

    // Row 0 (no live cues): aligning the empty sequence with P[0..j) costs j.
    for (let j = 0; j <= Math.min(m, k); j++) this.prev[j] = j;

    this.bound = 0; // min_j D(empty, P_j) = D(empty, empty) = 0
    this.final = m <= k ? m : this.INF; // D(empty, P) = m
  }

  /**
   * Commit one live cue: append the next DP row and return the refreshed
   * readings. Called exactly once per successfully committed registerCue.
   */
  advance(cue: number): DeviationView {
    const { plan, k, INF } = this;
    const m = plan.length;

    // Write the new row into `curr` reading from `prev`; the buffers are
    // swapped only after the row is complete. `curr` is the row from two
    // steps ago, and the sentinel resets below make its stale entries
    // unreachable to the recurrence and to the band scan.
    const prev = this.prev;
    const curr = this.curr;

    const i = this.observed + 1;
    const lo = Math.max(0, i - k);
    const hi = Math.min(m, i + k);

    // Sentinels just outside the band.
    if (lo === 0) {
      curr[0] = i; // deleting i live cues costs i (<= k inside the band)
    } else {
      curr[lo - 1] = INF;
    }
    if (hi < m) curr[hi + 1] = INF;

    for (let j = Math.max(1, lo); j <= hi; j++) {
      let best = prev[j - 1] + (cue === plan[j - 1] ? 0 : 2); // match / substitute
      const del = prev[j] + 1; // delete the new live cue
      if (del < best) best = del;
      const ins = curr[j - 1] + 1; // insert the planned cue
      if (ins < best) best = ins;
      curr[j] = best > INF ? INF : best;
    }

    // The minimum is taken over the band only: every true cell outside the
    // band is > k, and the recycled buffers may hold stale finite values
    // there that must never leak into the reading.
    let bound = INF;
    for (let j = lo; j <= hi; j++) {
      if (curr[j] < bound) bound = curr[j];
    }
    this.bound = bound;

    // The full-plan cell is read straight from the band when it lies in it;
    // otherwise the recycled slot is stale and has to be pinned to INF.
    if (m < lo || m > hi) {
      curr[m] = INF;
      this.final = INF;
    } else {
      this.final = curr[m];
    }

    this.observed = i;
    const swap = this.prev;
    this.prev = this.curr;
    this.curr = swap;

    return this.view();
  }

  /** Readings for the rows computed so far (zero rows before the first cue). */
  view(): DeviationView {
    const { k, bound, final } = this;
    return {
      k,
      // The plan is immutable: it is fixed at construction and no command
      // can edit it, so snapshots share the one array instead of copying it
      // once per registered cue (which would make a 50k-cue show O(n*m)).
      plan: this.plan,
      planLength: this.plan.length,
      prefix: bound <= k ? { status: 'ok', distance: bound } : { status: 'exceeded' },
      final: final <= k ? { status: 'ok', distance: final } : { status: 'exceeded' },
    };
  }
}
