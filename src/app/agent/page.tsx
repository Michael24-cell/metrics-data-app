import { currentFacility } from "@/lib/facility";
import { listAthletes, getActiveProtocol, listMilestones } from "@/lib/db/dal";
import { getDb } from "@/lib/db/db";
import { runAgent, resolveMode } from "@/lib/agent/runner";
import AgentClient from "./AgentClient";

export const dynamic = "force-dynamic";

/**
 * Athlete Intelligence Agent — demo-ready on load: the page executes one
 * report run server-side for the default athlete so metrics, report,
 * safety/eval status, and the Action & Evidence Trace are visible with zero
 * clicks. Facility scoping here is the controlled-demo cookie scope, not
 * authentication.
 */
export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const facility = await currentFacility();
  const athletes = listAthletes(facility.id);

  // default: the athlete with the most recently created active staged plan, else first
  const flagged = getDb()
    .prepare(`SELECT athlete_id FROM rts_protocol WHERE facility_id = ? AND status = 'active' ORDER BY rowid DESC LIMIT 1`)
    .get(facility.id) as { athlete_id: string } | undefined;
  const requested = sp.athlete && athletes.find((a) => a.id === sp.athlete) ? sp.athlete : undefined;
  const athlete = athletes.find((a) => a.id === (requested ?? flagged?.athlete_id)) ?? athletes[0];

  if (!athlete) {
    return (
      <main className="page">
        <div className="page-head">
          <h1>Athlete Intelligence Agent</h1>
        </div>
        <div className="callout">No athletes in this facility — run `npm run db:seed` first.</div>
      </main>
    );
  }

  const initialRun = await runAgent({
    facilityId: facility.id,
    athleteId: athlete.id,
    athleteName: athlete.display_name,
    task: "report",
  });

  const milestones = listMilestones(facility.id, athlete.id).map((m) => ({
    date: m.milestone_date,
    label: m.label,
  }));
  const protocol = getActiveProtocol(facility.id, athlete.id);
  const lastTest = getDb()
    .prepare(`SELECT MAX(session_date) as d FROM session WHERE facility_id = ? AND athlete_id = ?`)
    .get(facility.id, athlete.id) as { d: string | null };

  return (
    <AgentClient
      facility={{ id: facility.id, name: facility.name }}
      athletes={athletes.map((a) => ({ id: a.id, name: a.display_name, team: a.team ?? "" }))}
      athlete={{ id: athlete.id, name: athlete.display_name, sport: athlete.sport, hasPlan: !!protocol }}
      lastTestDate={lastTest.d}
      checkpoints={milestones}
      initialRun={initialRun}
      configuredMode={resolveMode()}
      initialQuestionKey={sp.ask}
      initialFindingId={sp.finding}
      initialQuestion={sp.q}
      initialContext={{ testType: sp.test, metricKey: sp.metric }}
    />
  );
}
