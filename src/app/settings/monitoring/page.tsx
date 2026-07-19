
import { currentFacility } from "@/lib/facility";
import { listAthletes } from "@/lib/db/dal";
import { effectivePolicy } from "@/lib/services/monitoringPolicy";
import { STAT_POLICIES } from "@/lib/config/statPolicies";
import { METRICS } from "@/lib/config/metrics";

import PolicyForm from "./PolicyForm";

export const dynamic = "force-dynamic";

/**
 * Monitoring configuration: facility template + per-athlete override.
 * Inherited values and overrides are labeled; every save is a new version.
 */
export default async function MonitoringSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const facility = await currentFacility();
  const athletes = listAthletes(facility.id);
  const athlete = athletes.find((a) => a.id === sp.athlete) ?? null;

  const metricOptions = Object.keys(STAT_POLICIES)
    .filter((k) => METRICS[k])
    .map((k) => ({ key: k, label: METRICS[k].shortLabel }));

  const facilityEff = effectivePolicy(facility.id, "none");
  const facilityOwn = facilityEff.layers.find((l) => l.scope === "facility")?.overrides ?? {};
  const athleteEff = athlete ? effectivePolicy(facility.id, athlete.id) : null;
  const athleteOwn = athleteEff?.layers.find((l) => l.scope === "athlete")?.overrides ?? {};

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">{facility.name} · Settings</div>
        <h1>Monitoring configuration</h1>
        <div className="sub">
          Baseline length, rolling window, noise gate, and monitored metrics. Effective policy = product default
          ← facility template ← athlete override; every save creates a new version and historical results keep
          the version they were generated with.
        </div>
      </div>

      <div className="panel">
        <h2>Facility template</h2>
        <p className="panel-sub">Applies to every athlete without an override. Changing it never rewrites history.</p>
        <PolicyForm scope="facility" effective={facilityEff.policy} ownOverrides={facilityOwn as Record<string, unknown>} metricOptions={metricOptions} />
      </div>

      <div className="panel">
        <h2>Athlete override</h2>
        <p className="panel-sub">Pick an athlete to override specific fields; unset fields stay inherited.</p>
        <form method="get" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select name="athlete" defaultValue={athlete?.id ?? ""} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--bg2)", color: "var(--ink)" }}>
            <option value="">Select an athlete…</option>
            {athletes.map((a) => (
              <option key={a.id} value={a.id}>{a.display_name}{a.team ? ` — ${a.team}` : ""}</option>
            ))}
          </select>
          <button className="btn secondary" type="submit">Edit override</button>
        </form>
        {athlete && athleteEff ? (
          <>
            <p className="panel-sub" style={{ marginTop: 8 }}>
              Editing override for <strong>{athlete.display_name}</strong> · effective policy: baseline{" "}
              {athleteEff.policy.baselineSessions}, rolling {athleteEff.policy.rollingWindow}, gate {athleteEff.policy.noiseGate}
              {" · layers: "}
              {athleteEff.layers.length ? athleteEff.layers.map((l) => `${l.scope} v${l.version}`).join(" → ") : "product default only"}
            </p>
            <PolicyForm scope="athlete" athleteId={athlete.id} effective={athleteEff.policy} ownOverrides={athleteOwn as Record<string, unknown>} metricOptions={metricOptions} />
          </>
        ) : (
          <p className="quiet-line">Select an athlete above via “Jump to…” to edit their override (URL: ?athlete=&lt;id&gt;).</p>
        )}
      </div>
    </main>
  );
}
