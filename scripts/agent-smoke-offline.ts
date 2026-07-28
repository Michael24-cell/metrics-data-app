import { runAgent } from "../src/lib/agent/runner";
import { listAthletes, listFacilities } from "../src/lib/db/dal";

async function main() {
  const facility = listFacilities()[0];
  if (!facility) throw new Error("No facility found; run npm run db:seed first.");
  const athlete = listAthletes(facility.id)[0];
  if (!athlete) throw new Error("No athlete found; run npm run db:seed first.");

  const cases = [
    { task: "report" as const },
    { task: "question" as const, question: "What is this athlete's monitoring status?" },
    { task: "question" as const, question: "What changed in this athlete's CMJ results?" },
  ];

  for (const input of cases) {
    const run = await runAgent({
      facilityId: facility.id,
      athleteId: athlete.id,
      athleteName: athlete.display_name,
      modeOverride: "scripted",
      ...input,
    });
    if (run.eval.status === "fail" || run.answerHidden || (!run.report && !run.answer && !run.clarification)) {
      throw new Error(`Agent smoke failed for ${input.task}: eval=${run.eval.status}`);
    }
    console.log(`${input.task}: ${run.eval.status} (${run.provenance.toolCallCount} tool calls)`);
  }
  console.log("Agent smoke OK: deterministic report and question paths.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
