import { describe, it, expect } from "vitest";
import {
  AttemptRecord,
  classifyAttempts,
  alignAttempt,
  averageAlignedCurves,
  parseCurveSelection,
  prepareCurve,
} from "./curveWorkspace";
import { CmjEventMarkers, ImtpEventMarkers } from "./curve";

const cmjMarkers = (movementStartMs: number, takeoffMs = movementStartMs + 800): CmjEventMarkers => ({
  kind: "cmj",
  methodVersion: "1.0.0",
  movementStartMs,
  takeoffMs,
});

const imtpMarkers = (onsetMs: number): ImtpEventMarkers => ({
  kind: "imtp",
  methodVersion: "1.0.0",
  onsetMs,
  peakForceMs: onsetMs + 1500,
});

let seq = 0;
function attempt(partial: Partial<AttemptRecord>): AttemptRecord {
  seq += 1;
  return {
    trialId: `t${seq}`,
    sessionId: `s${seq}`,
    date: "2026-03-01",
    trialNumber: 1,
    qualityFlag: null,
    // 1 s ramp at 250 Hz: force[i] = i (easy to check interpolation)
    waveform: { hz: 250, force: Array.from({ length: 251 }, (_, i) => i) },
    markers: cmjMarkers(200),
    ...partial,
  };
}

describe("attempt validity classification", () => {
  it("excludes quality-flagged, waveform-less, marker-less and kind-mismatched attempts with reasons", () => {
    const good = attempt({});
    const flagged = attempt({ qualityFlag: "clipped signal" });
    const noWave = attempt({ waveform: null });
    const noMarkers = attempt({ markers: null });
    const wrongKind = attempt({ markers: imtpMarkers(200) });
    const { valid, excluded } = classifyAttempts("cmj", [good, flagged, noWave, noMarkers, wrongKind]);
    expect(valid.map((a) => a.trialId)).toEqual([good.trialId]);
    const reasons = Object.fromEntries(excluded.map((e) => [e.trialId, e.reason]));
    expect(reasons[flagged.trialId]).toContain("quality flag: clipped signal");
    expect(reasons[noWave.trialId]).toContain("no stored waveform");
    expect(reasons[noMarkers.trialId]).toContain("no alignment markers");
    expect(reasons[wrongKind.trialId]).toContain("does not match test 'cmj'");
  });
});

describe("alignment to detected onset with −20 ms lead", () => {
  it("anchors time 0 at the onset and starts 20 ms before it", () => {
    const c = alignAttempt(attempt({ markers: cmjMarkers(200) }));
    expect(c.startMs).toBe(-20);
    expect(c.stepMs).toBe(4); // 250 Hz
    // grid point at t=0 is absolute 200 ms → sample index 50 → value 50 (ramp)
    const k0 = Math.round(-c.startMs / c.stepMs);
    expect(c.force[k0]).toBeCloseTo(50, 6);
    // first grid sample at −20 ms → absolute 180 ms → value 45
    expect(c.force[0]).toBeCloseTo(45, 6);
  });

  it("clamps the lead at the start of the recording instead of extrapolating", () => {
    const c = alignAttempt(attempt({ markers: cmjMarkers(8) }));
    // only 8 ms of pre-onset signal exists → start there, not at −20
    expect(c.startMs).toBe(-8);
    expect(c.force[0]).toBeCloseTo(0, 6);
  });

  it("interpolates between stored samples for off-grid onsets", () => {
    const c = alignAttempt(attempt({ markers: cmjMarkers(202) })); // between samples 50 and 51
    const k0 = Math.round(-c.startMs / c.stepMs);
    expect(c.force[k0]).toBeCloseTo(50.5, 6); // ramp lerp
  });
});

describe("averaging aligned curves", () => {
  it("averages point-wise over the overlapping window only — no extrapolation", () => {
    // onset 200 ms → pre-onset lead 20 ms; onset 8 ms → lead 8 ms only
    const a = alignAttempt(attempt({ markers: cmjMarkers(200) })); // t ∈ [−20, 800]
    const b = alignAttempt(attempt({ markers: cmjMarkers(8) })); // t ∈ [−8, 992]
    const avg = averageAlignedCurves([a, b]);
    expect(avg.startMs).toBe(-8); // intersection, not the widest window
    const endMs = avg.startMs + (avg.force.length - 1) * avg.stepMs;
    expect(endMs).toBe(800); // shorter post-onset domain wins
    // at t=0: a=50 (abs 200ms), b=2 (abs 8ms) → mean 26
    const k0 = Math.round(-avg.startMs / avg.stepMs);
    expect(avg.force[k0]).toBeCloseTo(26, 6);
    expect(avg.included).toHaveLength(2);
  });

  it("refuses mixed sample rates rather than resampling silently", () => {
    const a = alignAttempt(attempt({}));
    const b = alignAttempt(
      attempt({ waveform: { hz: 100, force: Array.from({ length: 101 }, (_, i) => i) } })
    );
    expect(() => averageAlignedCurves([a, b])).toThrow(/uniform sample rate/);
  });

  it("produces per-side averages only when every included attempt has bilateral data", () => {
    const bilat = () => ({
      hz: 250,
      force: Array.from({ length: 251 }, (_, i) => i),
      left: Array.from({ length: 251 }, (_, i) => i / 2),
      right: Array.from({ length: 251 }, (_, i) => i / 2),
    });
    const both = averageAlignedCurves([
      alignAttempt(attempt({ waveform: bilat() })),
      alignAttempt(attempt({ waveform: bilat() })),
    ]);
    expect(both.left).toBeDefined();
    expect(both.right).toBeDefined();
    const mixed = averageAlignedCurves([
      alignAttempt(attempt({ waveform: bilat() })),
      alignAttempt(attempt({})), // total-only
    ]);
    expect(mixed.left).toBeUndefined();
    expect(mixed.right).toBeUndefined();
  });
});

describe("selection parsing and resolution", () => {
  it("parses the three token forms and rejects junk", () => {
    expect(parseCurveSelection("alltime")).toEqual({ mode: "alltime" });
    expect(parseCurveSelection("rolling:10")).toEqual({ mode: "rolling", window: 10 });
    expect(parseCurveSelection("attempt:abc123")).toEqual({ mode: "attempt", trialId: "abc123" });
    expect(parseCurveSelection("rolling:7")).toBeNull(); // not an offered window
    expect(parseCurveSelection("attempt:")).toBeNull();
    expect(parseCurveSelection("nonsense")).toBeNull();
    expect(parseCurveSelection(undefined)).toBeNull();
  });

  it("rolling window takes the LATEST N valid attempts", () => {
    const attempts = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"].map(
      (date) => attempt({ date })
    );
    const curve = prepareCurve(attempts, { mode: "rolling", window: 5 })!;
    expect(curve.includedCount).toBe(5);
    expect(curve.included.map((i) => i.date)).toEqual([
      "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01",
    ]);
    expect(curve.insufficient).toBe(false);
    expect(curve.kind).toBe("average");
  });

  it("labels an undersized rolling window honestly instead of silently substituting", () => {
    const attempts = [attempt({ date: "2026-01-01" }), attempt({ date: "2026-02-01" })];
    const curve = prepareCurve(attempts, { mode: "rolling", window: 10 })!;
    expect(curve.insufficient).toBe(true);
    expect(curve.requestedCount).toBe(10);
    expect(curve.includedCount).toBe(2);
    expect(curve.label).toContain("fewer than the 10 requested");
  });

  it("excludes rate-incompatible attempts from an average with a reason", () => {
    const odd = attempt({
      date: "2026-01-01",
      waveform: { hz: 100, force: Array.from({ length: 101 }, (_, i) => i) },
    });
    const attempts = [odd, attempt({ date: "2026-02-01" }), attempt({ date: "2026-03-01" })];
    const curve = prepareCurve(attempts, { mode: "alltime" })!;
    expect(curve.includedCount).toBe(2);
    expect(curve.excluded).toHaveLength(1);
    expect(curve.excluded[0].trialId).toBe(odd.trialId);
    expect(curve.excluded[0].reason).toContain("100 Hz differs from 250 Hz");
  });

  it("individual attempt selection returns that attempt; unknown trial returns null", () => {
    const a = attempt({ date: "2026-02-01", trialNumber: 2 });
    const curve = prepareCurve([a], { mode: "attempt", trialId: a.trialId })!;
    expect(curve.kind).toBe("individual");
    expect(curve.label).toBe("2026-02-01 · attempt 2");
    expect(curve.includedCount).toBe(1);
    expect(prepareCurve([a], { mode: "attempt", trialId: "missing" })).toBeNull();
    expect(prepareCurve([], { mode: "alltime" })).toBeNull();
  });
});
