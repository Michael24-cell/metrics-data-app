import { currentFacility } from "@/lib/facility";
import { listAthletes } from "@/lib/db/dal";
import { listAlerts, coachDigest } from "@/lib/services/alerts";
import { listMonitoringResults } from "@/lib/services/monitoringEngine";
import { effectivePolicy } from "@/lib/services/monitoringPolicy";
import { METRICS } from "@/lib/config/metrics";
import AlertActions from "./AlertActions";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, { label: string; tone?: string; icon: string }> = {
  within_expected_range: { label: "Within expected range", tone: "ok", icon: "●" },
  review_suggested: { label: "Review suggested", tone: "watch", icon: "▲" },
  repeated_low_signal: { label: "Repeated low signal", tone: "alert", icon: "■" },
  collecting_baseline: { label: "Collecting baseline", icon: "◔" },
  insufficient_reliable_data: { label: "Insufficient reliable data", icon: "◇" },
};

const ALERT_LABEL: Record<string, string> = {
  review_suggested: "Review suggested",
  repeated_low_signal: "Repeated low signal",
  new_pr: "New PR",
  asymmetry_crossing: "Asymmetry threshold crossed",
  reliability_concern: "Metric reliability concern",
  monitoring_data_gap: "Monitoring data gap",
  baseline_completed: "Baseline completed",
};

/** Team monitoring rollup + alert center + coach digest. */
export default async function MonitoringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const facility = await currentFacility();
  const athletes = listAthletes(facility.id, sp.team);
  const athleteName = new Map(athletes.map((a) => [a.id, a.display_name]));

  // per-athlete latest monitoring state on their monitored metrics
  const rollup = athletes.map((a) => {
    const eff = effectivePolicy(facility.id, a.id);
    const latestByMetric = eff.policy.metricKeys.map((mk) => {
      const rows = listMonitoringResults(facility.id, a.id, mk, eff.fingerprint);
      return rows.length ? { metricKey: mk, row: rows[rows.length - 1] } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const rank = (s: string) =>
      s === "repeated_low_signal" ? 0 : s === "review_suggested" ? 1 : s === "insufficient_reliable_data" ? 2 : s === "collecting_baseline" ? 3 : 4;
    latestByMetric.sort((x, y) => rank(x.row.monitoring_state) - rank(y.row.monitoring_state));
    return { athlete: a, top: latestByMetric[0] ?? null, all: latestByMetric };
  }).filter((r) => r.top);
  rollup.sort((a, b) => {
    const rank = (s: string) => (s === "repeated_low_signal" ? 0 : s === "review_suggested" ? 1 : s === "collecting_baseline" ? 3 : 2);
    return rank(a.top!.row.monitoring_state) - rank(b.top!.row.monitoring_state);
  });

  const statusFilter = (sp.status as "new" | "acknowledged" | "resolved" | "dismissed" | undefined) ?? "new";
  const alerts = listAlerts(facility.id, { status: statusFilter });
  const digest = coachDigest(facility.id, sp.window === "1" ? 1 : 7);

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">{facility.name}</div>
        <h1>Monitoring &amp; Alerts</h1>
        <div className="sub">
          Individualized monitoring against each athlete&apos;s own reference window. Labels describe measured
          performance for coach review — never readiness, injury status, or train/no-train decisions.
        </div>
      </div>

      <div className="panel">
        <h2>Team rollup</h2>
        <p className="panel-sub">Athletes ordered by attention: repeated low signals, then review suggested, then the rest.</p>
        <div style={{ overflowX: "auto" }}>
          <table className="data">
            <thead>
              <tr><th>Athlete</th><th>Team</th><th>Status</th><th>Metric</th><th className="num">Latest</th><th className="num">Reference band</th><th>Session</th><th></th></tr>
            </thead>
            <tbody>
              {rollup.map(({ athlete, top }) => {
                const s = STATE_LABEL[top!.row.monitoring_state];
                const def = METRICS[top!.metricKey];
                return (
                  <tr key={athlete.id}>
                    <td><a href={`/athletes/${athlete.id}/monitoring`} style={{ fontWeight: 600, color: "var(--ink)" }}>{athlete.display_name}</a></td>
                    <td style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>{athlete.team}</td>
                    <td><span className="chip" data-tone={s.tone}>{s.icon} {s.label}</span></td>
                    <td>{def?.shortLabel ?? top!.metricKey}</td>
                    <td className="num">{top!.row.current_value.toFixed(def?.precision ?? 1)} {def?.unit}</td>
                    <td className="num">
                      {top!.row.band_low != null ? `${top!.row.band_low.toFixed(def?.precision ?? 1)}–${top!.row.band_high!.toFixed(def?.precision ?? 1)}` : "—"}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{top!.row.session_date}</td>
                    <td><a href={`/athletes/${athlete.id}/monitoring`} style={{ color: "var(--accent)", fontSize: 12.5 }}>open →</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rollup.length === 0 && <div className="callout">No monitoring results yet — run the monitoring job or record sessions.</div>}
      </div>

      <div className="panel">
        <div className="chart-head">
          <h2 style={{ marginRight: "auto" }}>Alert center</h2>
          <div className="toggle no-print">
            {(["new", "acknowledged", "resolved", "dismissed"] as const).map((st) => (
              <a key={st} href={`?status=${st}`}><button data-on={statusFilter === st}>{st}</button></a>
            ))}
          </div>
        </div>
        <p className="panel-sub">Persistent, explainable, auditable. Each alert carries the policy version that generated it.</p>
        {alerts.length === 0 && <div className="callout" data-tone="ok">No {statusFilter} alerts.</div>}
        <div style={{ display: "grid", gap: 8 }}>
          {alerts.slice(0, 30).map((a) => {
            const def = a.metric_key ? METRICS[a.metric_key] : null;
            const ev = JSON.parse(a.evidence_json) as Record<string, number | string | null>;
            return (
              <div key={a.id} className="finding" data-sev={a.severity === "high" ? "flag" : a.severity === "review" ? "watch" : "info"}>
                <div className="f-head">
                  <span className="f-title">
                    {ALERT_LABEL[a.alert_type] ?? a.alert_type} — {athleteName.get(a.athlete_id) ?? "athlete"}
                    {def ? ` · ${def.shortLabel}` : ""}
                  </span>
                  <span className="f-date">{a.session_date ?? a.created_at.slice(0, 10)}</span>
                </div>
                <div className="f-detail">
                  {a.alert_type === "new_pr" && typeof ev.value === "number" && (
                    <>New best: {ev.value.toFixed(def?.precision ?? 1)} {def?.unit} (previous best {typeof ev.previousBest === "number" ? ev.previousBest.toFixed(def?.precision ?? 1) : ev.previousBest} {def?.unit}).</>
                  )}
                  {(a.alert_type === "review_suggested" || a.alert_type === "repeated_low_signal") && typeof ev.value === "number" && (
                    <>Value {ev.value.toFixed(def?.precision ?? 1)} {def?.unit} vs expected range {typeof ev.bandLow === "number" ? ev.bandLow.toFixed(def?.precision ?? 1) : ev.bandLow}–{typeof ev.bandHigh === "number" ? ev.bandHigh.toFixed(def?.precision ?? 1) : ev.bandHigh} {def?.unit}.</>
                  )}
                  {a.alert_type === "asymmetry_crossing" && <>Asymmetry {ev.asymmetryPct}% crossed the {ev.flagPct}% flag threshold ({ev.strongerSide} stronger).</>}
                  {a.alert_type === "reliability_concern" && <>{ev.warnThresholdNote}</>}
                  {a.alert_type === "baseline_completed" && <>Baseline of {ev.baselineSessions} eligible sessions completed — monitoring is now active.</>}
                  {a.alert_type === "monitoring_data_gap" && <>{ev.detail}</>}
                  {a.coach_note && <div style={{ marginTop: 4, color: "var(--ink-dim)" }}>Note: {a.coach_note}</div>}
                  {a.close_reason && <div style={{ marginTop: 4, color: "var(--ink-mute)" }}>{a.status}: {a.close_reason}</div>}
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <AlertActions alertId={a.id} status={a.status} />
                  <a href={`/agent?athlete=${a.athlete_id}&q=${encodeURIComponent("Why was this athlete surfaced for review?")}${def ? `&metric=${a.metric_key}` : ""}`} style={{ color: "var(--accent)", fontSize: 12.5 }}>
                    Ask the agent →
                  </a>
                  <span style={{ fontSize: 11, color: "var(--ink-mute)", fontFamily: "var(--font-mono)" }}>{a.policy_fingerprint ?? ""}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="chart-head">
          <h2 style={{ marginRight: "auto" }}>Coach digest</h2>
          <div className="toggle no-print">
            <a href="?window=1"><button data-on={digest.windowDays === 1}>Daily</button></a>
            <a href="?window=7"><button data-on={digest.windowDays === 7}>Weekly</button></a>
          </div>
        </div>
        <p className="panel-sub">{digest.totals.created} alert(s) in the last {digest.windowDays} day(s); {digest.totals.open} still open. In-app digest — email/SMS/push delivery is a deferred provider-neutral interface.</p>
        <div className="statrow">
          {[
            ["New review items", digest.newReview.length],
            ["Repeated low signals", digest.repeatedLow.length],
            ["New PRs", digest.newPrs.length],
            ["Asymmetry crossings", digest.asymmetryCrossings.length],
            ["Reliability concerns", digest.reliabilityConcerns.length],
            ["Resolved/closed", digest.resolved.length],
          ].map(([label, n]) => (
            <div className="stat" key={label as string}><div className="k">{label}</div><div className="v">{n as number}</div></div>
          ))}
        </div>
      </div>
    </main>
  );
}
