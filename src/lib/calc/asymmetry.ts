/**
 * Asymmetry / Limb Symmetry Index calculations.
 * Method version: asym@1.0.0
 *
 * Default formula (product-wide):
 *   Asymmetry Index (%) = abs(stronger − weaker) / (0.5 × (stronger + weaker)) × 100
 *
 * LSI (%) = (involved / uninvolved) × 100 — used only for athletes with an
 * active injury record where an involved side is defined.
 */

export const ASYM_METHOD_VERSION = "1.0.0";

export interface AsymmetryResult {
  methodVersion: string;
  /** symmetric asymmetry index, % (always ≥ 0) */
  asymmetryIndexPct: number;
  strongerSide: "left" | "right" | "equal";
  left: number;
  right: number;
}

export function asymmetryIndex(left: number, right: number): AsymmetryResult {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) {
    throw new Error("Asymmetry requires finite, non-negative per-side values.");
  }
  const stronger = Math.max(left, right);
  const weaker = Math.min(left, right);
  const denom = 0.5 * (stronger + weaker);
  const pct = denom === 0 ? 0 : (Math.abs(stronger - weaker) / denom) * 100;
  return {
    methodVersion: ASYM_METHOD_VERSION,
    asymmetryIndexPct: pct,
    strongerSide: left === right ? "equal" : left > right ? "left" : "right",
    left,
    right,
  };
}

/**
 * Count how many times the stronger side flips across an ordered series of
 * asymmetry points. "equal" never counts as a side, so equal→left or
 * left→equal are not direction changes — only left↔right transitions are.
 * Shared by the Agent's asymmetry-history tool and any future cohort/roster
 * view so direction-change logic exists in exactly one place.
 */
export function directionChanges(points: { strongerSide: "left" | "right" | "equal" }[]): number {
  let changes = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].strongerSide;
    const cur = points[i].strongerSide;
    if (prev !== cur && prev !== "equal" && cur !== "equal") changes++;
  }
  return changes;
}

export interface LsiResult {
  methodVersion: string;
  /** involved / uninvolved × 100 */
  lsiPct: number;
  involvedSide: "left" | "right";
}

export function limbSymmetryIndex(
  involved: number,
  uninvolved: number,
  involvedSide: "left" | "right"
): LsiResult {
  if (uninvolved <= 0) throw new Error("LSI requires a positive uninvolved-side value.");
  return {
    methodVersion: ASYM_METHOD_VERSION,
    lsiPct: (involved / uninvolved) * 100,
    involvedSide,
  };
}
