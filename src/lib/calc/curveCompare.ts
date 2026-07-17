/**
 * Force-time curve comparison — pure, deterministic.
 *
 * Compares two PREPARED curves (already selected, validated, onset-aligned
 * and averaged by calc/curveWorkspace.ts). Produces trainer-meaningful
 * differences without ever re-deriving official values:
 *
 *  - OFFICIAL differences (peak force, time to peak, time to takeoff, force
 *    at the fixed IMTP time points) exist only when BOTH curves are
 *    individual attempts carrying persisted official annotations.
 *  - DISPLAY-RESOLUTION differences (peak of the prepared display curve,
 *    mean force difference over the overlapping window) are always
 *    computed but explicitly labeled display-resolution — they come from
 *    the downsampled display copy, not the full-rate signal.
 *  - Curves with different display sample rates or no overlapping aligned
 *    window are reported NOT comparable with reasons, never stretched.
 */

export interface ComparableCurve {
  token: string;
  label: string;
  kind: "individual" | "average";
  hz: number;
  stepMs: number;
  startMs: number;
  force: number[];
  includedCount: number;
  annotations: {
    takeoffRelMs?: number;
    peakForceRelMs?: number;
    officialTimeToTakeoffMs?: number;
    officialPeakForceN?: number;
    officialTimeToPeakMs?: number;
    officialForcePoints?: { ms: number; forceN: number }[];
  };
}

export interface ValuePair {
  a: number;
  b: number;
  /** a − b */
  diff: number;
}

export interface CurveComparison {
  comparable: boolean;
  reasons: string[];
  a: { label: string; kind: "individual" | "average"; includedCount: number };
  b: { label: string; kind: "individual" | "average"; includedCount: number };
  /** overlapping aligned window (ms relative to onset); null when none */
  overlapStartMs: number | null;
  overlapEndMs: number | null;
  /** display-resolution: max of each prepared display curve */
  displayPeakN: ValuePair | null;
  /** display-resolution: mean of (a − b) over the overlapping window */
  meanDiffOverOverlapN: number | null;
  /** official values — both curves individual attempts only */
  officialPeakForceN: ValuePair | null;
  officialTimeToPeakMs: ValuePair | null;
  officialTimeToTakeoffMs: ValuePair | null;
  officialForcePointDiffs: { ms: number; a: number; b: number; diff: number }[] | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

const pair = (a: number | undefined, b: number | undefined): ValuePair | null =>
  a == null || b == null ? null : { a: round1(a), b: round1(b), diff: round1(a - b) };

export function compareCurves(a: ComparableCurve, b: ComparableCurve): CurveComparison {
  const reasons: string[] = [];
  if (a.hz !== b.hz) {
    reasons.push(`display sample rates differ (${a.hz} Hz vs ${b.hz} Hz) — curves are never resampled to force a comparison`);
  }

  const endOf = (c: ComparableCurve) => c.startMs + (c.force.length - 1) * c.stepMs;
  const overlapStart = Math.max(a.startMs, b.startMs);
  const overlapEnd = Math.min(endOf(a), endOf(b));
  const hasOverlap = overlapEnd > overlapStart;
  if (!hasOverlap) reasons.push("curves share no overlapping aligned window");

  const comparable = reasons.length === 0;

  /* display-resolution peak (always available, labeled by the caller) */
  const displayPeakN = pair(Math.max(...a.force), Math.max(...b.force));

  /* mean(a − b) over the shared grid — only when comparable */
  let meanDiff: number | null = null;
  if (comparable) {
    const step = a.stepMs;
    const kMin = Math.round(overlapStart / step);
    const kMax = Math.round(overlapEnd / step);
    const kMinA = Math.round(a.startMs / step);
    const kMinB = Math.round(b.startMs / step);
    let sum = 0;
    let n = 0;
    for (let k = kMin; k <= kMax; k++) {
      const va = a.force[k - kMinA];
      const vb = b.force[k - kMinB];
      if (va != null && vb != null) {
        sum += va - vb;
        n++;
      }
    }
    meanDiff = n > 0 ? round1(sum / n) : null;
  }

  /* official values only when BOTH sides are individual attempts */
  const bothIndividual = a.kind === "individual" && b.kind === "individual";
  let forcePointDiffs: CurveComparison["officialForcePointDiffs"] = null;
  if (bothIndividual && a.annotations.officialForcePoints && b.annotations.officialForcePoints) {
    const byMsB = new Map(b.annotations.officialForcePoints.map((p) => [p.ms, p.forceN]));
    const rows = a.annotations.officialForcePoints
      .filter((p) => byMsB.has(p.ms))
      .map((p) => ({ ms: p.ms, a: round1(p.forceN), b: round1(byMsB.get(p.ms)!), diff: round1(p.forceN - byMsB.get(p.ms)!) }));
    forcePointDiffs = rows.length > 0 ? rows : null;
  }

  return {
    comparable,
    reasons,
    a: { label: a.label, kind: a.kind, includedCount: a.includedCount },
    b: { label: b.label, kind: b.kind, includedCount: b.includedCount },
    overlapStartMs: hasOverlap ? round1(overlapStart) : null,
    overlapEndMs: hasOverlap ? round1(overlapEnd) : null,
    displayPeakN,
    meanDiffOverOverlapN: meanDiff,
    officialPeakForceN: bothIndividual ? pair(a.annotations.officialPeakForceN, b.annotations.officialPeakForceN) : null,
    officialTimeToPeakMs: bothIndividual ? pair(a.annotations.officialTimeToPeakMs, b.annotations.officialTimeToPeakMs) : null,
    officialTimeToTakeoffMs: bothIndividual ? pair(a.annotations.officialTimeToTakeoffMs, b.annotations.officialTimeToTakeoffMs) : null,
    officialForcePointDiffs: forcePointDiffs,
  };
}
