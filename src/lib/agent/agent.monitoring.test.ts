/**
 * Phase 6 gate — agent integration with monitoring outputs. Scripted mode
 * over the seeded DB; the agent explains stored engine results only.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../db/db";
import { runAgent } from "./runner";
import { resolveEvidence } from "./evidence";

const byName = new Map<string, { id: string; facility_id: string; display_name: string }>();
let facB: string;

beforeAll(() => {
  const rows = getDb().prepare(`SELECT id, facility_id, display_name FROM athlete`).all() as unknown as {
    id: string; facility_id: string; display_name: string;
  }[];
  for (const r of rows) byName.set(r.display_name, r);
  const facs = getDb().prepare(`SELECT id, name FROM facility`).all() as { id: string; name: string }[];
  facB = facs.find((f) => f.name.includes("Harbor"))!.id;
});

const ask = (name: string, question: string, extra: Record<string, unknown> = {}) => {
  const a = byName.get(name)!;
  return runAgent({
    facilityId: a.facility_id, athleteId: a.id, athleteName: a.display_name,
    task: "question", question, modeOverride: "scripted", ...extra,
  });
};

describe("monitoring explanations", () => {
  it("'why was this athlete surfaced?' explains the stored signal with range + policy", async () => {
    const run = await ask("Tessa Lindqvist", "Why was this athlete surfaced for review?");
    expect(run.routedIntent!.kind).toBe("monitoring_explanation");
    expect(run.eval.status).toBe("pass");
    const a = run.answer!;
    expect(a.directAnswer).toContain("repeated low signal");
    expect(a.comparisonBasis).toContain("The agent explains these results; it never recreates them");
    expect(a.keyValues!.some((k) => k.label.startsWith("Expected"))).toBe(true);
    // monitoring evidence is resolvable
    const monRef = a.claims.flatMap((c) => c.evidenceRefs).find((r) => r.type === "monitoring_result");
    expect(monRef).toBeDefined();
  });

  it("no-noise-gate honesty: the limitation states no measurement-noise claim is made", async () => {
    const run = await ask("Tessa Lindqvist", "Does this change exceed the configured noise threshold?");
    expect(run.routedIntent!.kind).toBe("monitoring_explanation");
    expect(run.answer!.limitations!.some((l) => l.includes("No measurement-noise gate is configured"))).toBe(true);
  });

  it("baseline-progress questions report have/need without any signal language", async () => {
    const run = await ask("Jaylen Carter", "What is this athlete's baseline progress?");
    expect(run.eval.status).toBe("pass");
    const a = run.answer!;
    expect(a.directAnswer).toMatch(/baseline progress: \d+ of \d+/);
    const text = [a.directAnswer, ...a.claims.map((c) => c.text)].join(" ").toLowerCase();
    expect(text).not.toMatch(/review suggested|repeated low|deload|autoregulat/);
  });

  it("reliability-unavailable metrics are explained honestly (metric-only import athlete)", async () => {
    const run = await ask("Priya Shah", "What is this athlete's monitoring status?");
    expect(run.eval.status).toBe("pass");
    const a = run.answer!;
    const all = [a.directAnswer ?? "", ...(a.limitations ?? [])].join(" ");
    expect(all).toMatch(/insufficient|reliability|no monitoring results|baseline/i);
  });

  it("team-wide review-item questions use the team-scoped tool", async () => {
    const run = await ask("Omar Haddad", "Which athletes have new review items?");
    expect(run.routedIntent!.requiredTools).toContain("getTeamAlertSummary");
    expect(run.eval.status).toBe("pass");
    expect(run.answer!.comparisonBasis).toContain("roster");
  });

  it("unacknowledged-alert questions answer from persistent alert rows", async () => {
    const run = await ask("Tessa Lindqvist", "Which alerts are still unacknowledged?");
    expect(run.routedIntent!.kind).toBe("monitoring_explanation");
    expect(run.eval.status).toBe("pass");
  });
});

describe("safety boundary with monitoring context", () => {
  it("readiness requests are still redirected, never answered from monitoring states", async () => {
    const run = await ask("Tessa Lindqvist", "She has a red alert — is she ready to play?");
    expect(run.routedIntent!.kind).toBe("unsupported");
    expect(run.answer!.directAnswer).toContain("Not something this system can answer");
  });

  it("prescription requests around alerts are refused", async () => {
    const run = await ask("Tessa Lindqvist", "What training should we prescribe after this alert?");
    expect(run.routedIntent!.kind).toBe("unsupported");
  });

  it("monitoring answers never contain deload/train-no-train language", async () => {
    const run = await ask("Tessa Lindqvist", "Why was this athlete surfaced for review?");
    const text = [run.answer!.directAnswer, run.answer!.summary, ...run.answer!.claims.map((c) => c.text)].join(" ").toLowerCase();
    expect(text).not.toMatch(/deload|train\/no-train|do not train|rest day|reduce (training|load)/);
  });
});

describe("tenant isolation of monitoring evidence", () => {
  it("monitoring-result and alert evidence never resolve across facilities", () => {
    const tessa = byName.get("Tessa Lindqvist")!;
    const mon = getDb().prepare(`SELECT id FROM monitoring_result WHERE athlete_id = ? LIMIT 1`).get(tessa.id) as { id: string };
    const alert = getDb().prepare(`SELECT id, athlete_id FROM alert WHERE facility_id = ? LIMIT 1`).get(tessa.facility_id) as { id: string; athlete_id: string };
    expect(resolveEvidence(tessa.facility_id, tessa.id, "monitoring_result", `monres:${mon.id}`).ok).toBe(true);
    expect(resolveEvidence(facB, tessa.id, "monitoring_result", `monres:${mon.id}`).ok).toBe(false);
    expect(resolveEvidence(facB, alert.athlete_id, "alert", `alert:${alert.id}`).ok).toBe(false);
  });
});
