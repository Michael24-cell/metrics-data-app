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
