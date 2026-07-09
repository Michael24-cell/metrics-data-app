/**
 * Baseline deviation / rolling-window monitoring.
 * Method version: baseline@1.0.0
 *
 * Rules (config-driven, defaults per product spec):
 * - Benchmark window: first `benchmarkSessions` sessions (15–30 allowed; default 20)
 *   establish baseline mean + SD. Fewer than the minimum → insufficient baseline
 *   (callers should emit a data_gap finding, not a deviation).
 * - Rolling window: last `rollingWindow` sessions (default 5), recalculated each session.
 * - Normal band: rolling mean ± 1 SD (SD from the rolling window; baseline SD is
 *   used until the rolling window is full).
 * - Flags: 1 session below band → review / autoregulate volume (not intensity);
 *   2 consecutive below → deload recommendation (mandatory deload flag);
 *   3+ consecutive below → elevated-attention / review flag (a plain flag —
 *   no risk multiplier, no injury-probability claim).
 */

import { mean, sd } from "./signal";

export const BASELINE_METHOD_VERSION = "1.0.0";

export interface BaselineConfig {
  benchmarkSessions: number; // default 20, valid 15–30
  minBenchmarkSessions: number; // default 15
  rollingWindow: number; // default 5
  bandSdMultiplier: number; // default 1
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  benchmarkSessions: 20,
  minBenchmarkSessions: 15,
  rollingWindow: 5,
  bandSdMultiplier: 1,
};

export type DeviationFlag =
  | "none"
  | "below_band" // 1 session below → volume autoregulation
  | "mandatory_deload" // 2 consecutive below
  | "elevated_attention"; // 3+ consecutive below

export interface SessionPoint {
  sessionId: string;
  date: string; // ISO date
  value: number;
}

export interface BaselinePoint extends SessionPoint {
  rollingMean: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  belowBand: boolean;
  consecutiveBelow: number;
  flag: DeviationFlag;
}

export interface BaselineResult {
  methodVersion: string;
  config: BaselineConfig;
  sufficientBaseline: boolean;
  baselineMean: number | null;
  baselineSd: number | null;
  points: BaselinePoint[];
}

/**
 * `sessions` must be ordered oldest → newest, one value per session.
 * `higherIsBetter=false` metrics flag on values ABOVE the band instead.
 */
export function monitorBaseline(
  sessions: SessionPoint[],
  higherIsBetter = true,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG
): BaselineResult {
  const n = sessions.length;
  const sufficient = n >= config.minBenchmarkSessions;
  const benchCount = Math.min(config.benchmarkSessions, n);
  const benchValues = sessions.slice(0, benchCount).map((s) => s.value);
  const baselineMean = sufficient ? mean(benchValues) : null;
  const baselineSd = sufficient ? sd(benchValues) : null;

  const points: BaselinePoint[] = [];
  let consecutive = 0;

  for (let i = 0; i < n; i++) {
    const s = sessions[i];
    let rollingMean: number | null = null;
    let bandLow: number | null = null;
    let bandHigh: number | null = null;
    let belowBand = false;
    let flag: DeviationFlag = "none";

    if (sufficient && i >= config.minBenchmarkSessions) {
      // rolling window over the previous `rollingWindow` sessions (excluding current)
      const from = Math.max(0, i - config.rollingWindow);
      const windowVals = sessions.slice(from, i).map((x) => x.value);
      rollingMean = mean(windowVals);
      const windowSd =
        windowVals.length >= config.rollingWindow ? sd(windowVals) : (baselineSd as number);
      bandLow = rollingMean - config.bandSdMultiplier * windowSd;
      bandHigh = rollingMean + config.bandSdMultiplier * windowSd;

      belowBand = higherIsBetter ? s.value < bandLow : s.value > bandHigh;
      consecutive = belowBand ? consecutive + 1 : 0;

      if (consecutive >= 3) flag = "elevated_attention";
      else if (consecutive === 2) flag = "mandatory_deload";
      else if (consecutive === 1) flag = "below_band";
    } else {
      consecutive = 0;
    }

    points.push({
      ...s,
      rollingMean,
      bandLow,
      bandHigh,
      belowBand,
      consecutiveBelow: consecutive,
      flag,
    });
  }

  return {
    methodVersion: BASELINE_METHOD_VERSION,
    config,
    sufficientBaseline: sufficient,
    baselineMean,
    baselineSd,
    points,
  };
}
