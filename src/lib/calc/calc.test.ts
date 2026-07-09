import { describe, it, expect } from "vitest";
import { computeCmj, computeDropJumpRsi } from "./cmj";
import { computeImtp } from "./imtp";
import { asymmetryIndex, limbSymmetryIndex } from "./asymmetry";
import { monitorBaseline, SessionPoint } from "./baseline";
import { leastSquares, fitLoadVelocityProfile } from "./profiles";
import { generateCmjTrace, generateImtpTrace, generateDjTrace } from "./synthetic";
import { quietStanding, checkSanity, GRAVITY } from "./signal";

describe("CMJ impulse–momentum", () => {
  it("recovers the target takeoff velocity and jump height from a synthetic trace", () => {
    const target = 2.6; // m/s → h = 2.6²/(2·9.80665) ≈ 34.5 cm
    const trace = generateCmjTrace({
      massKg: 78,
      takeoffVelocity: target,
      depthFactor: 1.0,
      leftShare: 0.5,
      seed: 42,
    });
    const r = computeCmj(trace);
    expect(r.takeoffVelocityMs).toBeCloseTo(target, 1);
    const expectedCm = ((target * target) / (2 * GRAVITY)) * 100;
    expect(Math.abs(r.jumpHeightCm - expectedCm)).toBeLessThan(2.0);
    expect(r.methodVersion).toBe("1.0.0");
  });

  it("computes mRSI = height(m) / time-to-takeoff(s)", () => {
    const trace = generateCmjTrace({
      massKg: 78,
      takeoffVelocity: 2.6,
      depthFactor: 1.0,
      leftShare: 0.5,
      seed: 7,
    });
    const r = computeCmj(trace);
    expect(r.mrsi).toBeCloseTo(r.jumpHeightCm / 100 / r.timeToTakeoffS, 6);
    expect(r.mrsi).toBeGreaterThan(0.2);
    expect(r.mrsi).toBeLessThan(1.2);
  });

  it("deeper countermovement (higher depthFactor) lowers mRSI at equal jump height", () => {
    const shallow = computeCmj(
      generateCmjTrace({ massKg: 78, takeoffVelocity: 2.6, depthFactor: 0.85, leftShare: 0.5, seed: 1 })
    );
    const deep = computeCmj(
      generateCmjTrace({ massKg: 78, takeoffVelocity: 2.6, depthFactor: 1.3, leftShare: 0.5, seed: 1 })
    );
    expect(deep.mrsi).toBeLessThan(shallow.mrsi);
    expect(Math.abs(deep.jumpHeightCm - shallow.jumpHeightCm)).toBeLessThan(3);
  });

  it("eccentric braking impulse is positive and split per side reflects asymmetric loading", () => {
    const trace = generateCmjTrace({
      massKg: 78,
      takeoffVelocity: 2.5,
      depthFactor: 1.0,
      leftShare: 0.42, // right-dominant
      seed: 11,
    });
    const r = computeCmj(trace);
    expect(r.eccBrakingImpulseNs).toBeGreaterThan(0);
    expect(r.eccBrakingImpulseLeftNs).toBeDefined();
    expect(r.eccBrakingImpulseRightNs!).toBeGreaterThan(r.eccBrakingImpulseLeftNs!);
  });

  it("is deterministic: same seed → identical result", () => {
    const p = { massKg: 70, takeoffVelocity: 2.4, depthFactor: 1.0, leftShare: 0.5, seed: 99 };
    const a = computeCmj(generateCmjTrace(p));
    const b = computeCmj(generateCmjTrace(p));
    expect(a).toEqual(b);
  });
});

describe("IMTP", () => {
  const trace = () =>
    generateImtpTrace({ massKg: 82, peakNetForceN: 2200, riseTau: 0.25, leftShare: 0.5, seed: 5 });

  it("detects onset and recovers peak force ≈ BW + peak net force", () => {
    const t = trace();
    const r = computeImtp(t);
    const bw = 82 * GRAVITY;
    expect(r.bodyWeightN).toBeCloseTo(bw, -1);
    expect(Math.abs(r.peakForceN - (bw + 2200))).toBeLessThan(40);
  });

  it("computes bodyweight-relative force", () => {
    const r = computeImtp(trace());
    expect(r.relativeForceNkg).toBeCloseTo(r.peakForceN / r.bodyMassKg, 6);
  });

  it("RFD windows are ordered for an exponential rise (early > late)", () => {
    const r = computeImtp(trace());
    expect(r.rfd0_50).toBeGreaterThan(r.rfd50_150);
    expect(r.rfd50_150).toBeGreaterThan(r.rfd150_250);
    expect(r.rfd0_50).toBeGreaterThan(0);
  });

  it("faster rise (smaller tau) → higher early RFD", () => {
    const fast = computeImtp(
      generateImtpTrace({ massKg: 82, peakNetForceN: 2200, riseTau: 0.12, leftShare: 0.5, seed: 5 })
    );
    const slow = computeImtp(
      generateImtpTrace({ massKg: 82, peakNetForceN: 2200, riseTau: 0.4, leftShare: 0.5, seed: 5 })
    );
    expect(fast.rfd0_50).toBeGreaterThan(slow.rfd0_50);
  });

  it("throws on a trial with no pull rather than fabricating values", () => {
    const flat = {
      hz: 1000,
      force: new Array(3000).fill(800).map((v, i) => v + Math.sin(i) * 2),
    };
    expect(() => computeImtp(flat)).toThrow(/onset not detected/);
  });
});

describe("Drop jump RSI", () => {
  it("recovers flight/contact ratio", () => {
    const t = generateDjTrace({ massKg: 75, contactTimeS: 0.21, flightTimeS: 0.48, seed: 3 });
    const r = computeDropJumpRsi(t);
    expect(r.rsi).toBeCloseTo(0.48 / 0.21, 1);
  });
});

describe("Asymmetry / LSI", () => {
  it("matches the product default formula", () => {
    // abs(520-460)/(0.5*(520+460))*100 = 60/490*100 ≈ 12.245%
    const r = asymmetryIndex(460, 520);
    expect(r.asymmetryIndexPct).toBeCloseTo(12.2449, 3);
    expect(r.strongerSide).toBe("right");
  });

  it("is symmetric in its arguments", () => {
    expect(asymmetryIndex(460, 520).asymmetryIndexPct).toBeCloseTo(
      asymmetryIndex(520, 460).asymmetryIndexPct,
      10
    );
  });

  it("returns 0 for equal sides", () => {
    expect(asymmetryIndex(500, 500).asymmetryIndexPct).toBe(0);
  });

  it("LSI = involved/uninvolved × 100", () => {
    expect(limbSymmetryIndex(450, 500, "left").lsiPct).toBeCloseTo(90, 6);
  });

  it("rejects invalid inputs", () => {
    expect(() => asymmetryIndex(NaN, 500)).toThrow();
    expect(() => limbSymmetryIndex(450, 0, "left")).toThrow();
  });
});

describe("Baseline deviation monitoring", () => {
  const mkSessions = (values: number[]): SessionPoint[] =>
    values.map((v, i) => ({
      sessionId: `s${i}`,
      date: new Date(2026, 0, 1 + i * 3).toISOString().slice(0, 10),
      value: v,
    }));

  it("reports insufficient baseline below the minimum benchmark count", () => {
    const r = monitorBaseline(mkSessions([40, 41, 39, 40, 42]));
    expect(r.sufficientBaseline).toBe(false);
    expect(r.baselineMean).toBeNull();
    expect(r.points.every((p) => p.flag === "none")).toBe(true);
  });

  it("escalates 1 → below_band, 2 → mandatory_deload, 3 → elevated_attention", () => {
    // 20 stable sessions at 40, then three sharply low sessions
    const stable = Array.from({ length: 20 }, () => 40);
    const values = [...stable, 33, 33, 33];
    const r = monitorBaseline(mkSessions(values));
    expect(r.sufficientBaseline).toBe(true);
    const last3 = r.points.slice(-3).map((p) => p.flag);
    expect(last3).toEqual(["below_band", "mandatory_deload", "elevated_attention"]);
  });

  it("resets consecutive count when a session returns to band", () => {
    const stable = Array.from({ length: 20 }, () => 40);
    const values = [...stable, 33, 40, 33];
    const r = monitorBaseline(mkSessions(values));
    const flags = r.points.slice(-3).map((p) => p.flag);
    expect(flags[0]).toBe("below_band");
    expect(flags[1]).toBe("none");
    expect(flags[2]).toBe("below_band");
  });

  it("normal band = rolling mean ± 1 SD of the rolling window", () => {
    const stable = Array.from({ length: 25 }, (_, i) => 40 + [0, 0.4, -0.4, 0.2, -0.2][i % 5]);
    const r = monitorBaseline(mkSessions(stable));
    const p = r.points[24];
    expect(p.rollingMean).not.toBeNull();
    expect(p.bandHigh! - p.rollingMean!).toBeCloseTo(p.rollingMean! - p.bandLow!, 8);
  });
});

describe("Profiles (provisional scaffolding)", () => {
  it("least squares recovers a known line", () => {
    const fit = leastSquares([20, 40, 60, 80], [1.0, 0.8, 0.6, 0.4]);
    expect(fit.slope).toBeCloseTo(-0.01, 8);
    expect(fit.intercept).toBeCloseTo(1.2, 8);
    expect(fit.r2).toBeCloseTo(1, 8);
  });

  it("load–velocity profile is explicitly provisional", () => {
    const p = fitLoadVelocityProfile("back_squat", [
      { loadKg: 60, meanVelocityMs: 0.85 },
      { loadKg: 80, meanVelocityMs: 0.68 },
      { loadKg: 100, meanVelocityMs: 0.51 },
    ]);
    expect(p.provisional).toBe(true);
    expect(p.methodVersion).toContain("provisional");
  });
});

describe("Sanity ranges", () => {
  it("flags implausible values instead of accepting them", () => {
    expect(checkSanity(120, 5, 70).ok).toBe(false);
    expect(checkSanity(35, 5, 70).ok).toBe(true);
    expect(checkSanity(NaN, 5, 70).ok).toBe(false);
  });
});

describe("Quiet standing estimation", () => {
  it("estimates body weight from the quiet period", () => {
    const t = generateCmjTrace({ massKg: 90, takeoffVelocity: 2.2, depthFactor: 1, leftShare: 0.5, seed: 2 });
    const { bw } = quietStanding(t, 1.0);
    expect(bw).toBeCloseTo(90 * GRAVITY, -1);
  });
});
