/**
 * Manual live-mode smoke test (OPTIONAL — never run in CI).
 *
 *   ANTHROPIC_API_KEY=... npm run agent:smoke
 *
 * Runs ONE real model tool-calling pass against the local seeded database,
 * prints the eval verdict, claims, and trace, and exits non-zero if the run
 * (including safe fallback) could not produce output. Costs one small model
 * call. Requires: seeded DB (npm run db:seed) and a server-side API key in
 * the environment — the key is read here from process.env only and never
 * logged or written anywhere.
 */

import { listAthletes, listFacilities } from "../src/lib/db/dal";
import { runAgent } from "../src/lib/agent/runner";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("agent:smoke needs ANTHROPIC_API_KEY in the environment (server-side only; never commit it).");
    process.exit(1);
  }

  const facilities = listFacilities();
  const facility = facilities.find((f) => f.id === process.env.SMOKE_FACILITY_ID) ?? facilities[0];
  if (!facility) {
    console.error("No facilities found — run `npm run db:seed` first.");
    process.exit(1);
  }
  const athletes = listAthletes(facility.id);
  if (athletes.length === 0) {
    console.error(`No athletes in facility ${facility.name} — run \`npm run db:seed\` first.`);
    process.exit(1);
  }
  const athlete = athletes.find((a) => a.status === "rts") ?? athletes[0];
  console.log(`Live smoke test: report for ${athlete.display_name} (${athlete.id}) in ${facility.name}\n`);

  const run = await runAgent({
    facilityId: facility.id,
    athleteId: athlete.id,
    athleteName: athlete.display_name,
    task: "report",
    modeOverride: "live",
  });

  console.log(`mode:        ${run.mode}${run.provenance.fallback ? `  (fell back from ${run.provenance.fallback.from}: ${run.provenance.fallback.reason})` : ""}`);
  console.log(`model:       ${run.provenance.model}`);
  console.log(`eval:        ${run.eval.status.toUpperCase()}`);
  for (const c of run.eval.checks.filter((c) => c.status !== "pass")) {
    console.log(`  - [${c.status}] ${c.name}: ${c.detail}`);
  }
  console.log(`tool calls:  ${run.provenance.toolCallCount} · latency ${run.provenance.latencyMs} ms · tokens ${run.provenance.usage ? `${run.provenance.usage.inputTokens}in/${run.provenance.usage.outputTokens}out` : "n/a"}`);
  console.log(`\nexecutive summary:\n  ${run.report?.executiveSummary}\n`);
  console.log("claims:");
  for (const c of run.report?.claims ?? []) {
    console.log(`  [${c.claimType}/${c.confidence}] ${c.claimId} — ${c.text.slice(0, 160)}${c.text.length > 160 ? "…" : ""}`);
  }
  console.log("\ntrace:");
  for (const t of run.trace) {
    console.log(`  ${t.step}. [${t.stage}] ${t.tool ?? "-"} → ${t.status} (${t.ms} ms)`);
  }

  if (!run.report) {
    console.error("\nSMOKE FAIL: no report produced.");
    process.exit(1);
  }
  console.log(`\nSMOKE ${run.provenance.fallback ? "DEGRADED (scripted fallback ran — check the reason above)" : "OK"} — live adapter ${run.provenance.fallback ? "failed but the workflow stayed safe" : "completed"}.`);
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
