import { runAgent } from "../src/lib/agent/runner";
import { getDb } from "../src/lib/db/db";
const db = getDb();
const omar = db.prepare(`SELECT id, facility_id, display_name FROM athlete WHERE display_name='Omar Haddad'`).get() as { id: string; facility_id: string; display_name: string };
const kai = db.prepare(`SELECT id, facility_id, display_name FROM athlete WHERE display_name='Kai Solari'`).get() as typeof omar;
const QUESTIONS: [typeof omar, string, Record<string, string>?][] = [
  [omar, "What changed in this athlete's IMTP results?"],
  [omar, "Why is Force at 100 ms being monitored?"],
  [omar, "How does this athlete compare with the team?", { metricKey: "cmj_jump_height" }],
  [omar, "How do they compare with other forwards?", { metricKey: "cmj_jump_height" }],
  [omar, "Which side is stronger across the most recent tests?", { testType: "imtp" }],
  [omar, "Compare the latest IMTP curve with the previous session."],
  [omar, "What changed between the rolling-five average and the latest attempt?", { testType: "imtp" }],
  [kai, "Is the load-velocity profile changing?"],
  [omar, "What data is missing before this comparison is reliable?"],
  [omar, "Is he ready to play this weekend?"],
  [omar, "What's the capital of France?"],
  [omar, "How does this athlete compare with the team?"], // no metric anywhere → clarification
];
async function main() {
  for (const [ath, q, ctx] of QUESTIONS) {
    const run = await runAgent({ facilityId: ath.facility_id, athleteId: ath.id, athleteName: ath.display_name, task: "question", question: q, context: ctx, modeOverride: "scripted" });
    if (run.clarification) {
      console.log(`Q: ${q}\n  CLARIFY: ${run.clarification.question} [${run.clarification.options.map((o) => o.label).join(" | ")}]  eval=${run.eval.status}\n`);
      continue;
    }
    const a = run.answer!;
    console.log(`Q: ${q}\n  intent=${run.routedIntent?.kind} eval=${run.eval.status}${run.eval.status !== "pass" ? " [" + run.eval.checks.filter(c => c.status !== "pass").map(c => c.name).join(",") + "]" : ""}\n  A: ${a.directAnswer}\n  KV: ${(a.keyValues ?? []).map((k) => `${k.label}=${k.value}${k.unit ?? ""}`).join(" · ")}\n`);
  }
}
main();
