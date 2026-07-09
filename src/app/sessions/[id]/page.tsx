import { notFound } from "next/navigation";
import { currentFacility } from "@/lib/facility";
import { sessionDetail } from "@/lib/services/queries";
import { METRICS, TEST_TYPES } from "@/lib/config/metrics";
import ForceTrace from "@/components/charts/ForceTrace";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facility = await currentFacility();
  const detail = sessionDetail(facility.id, id);
  if (!detail || !detail.athlete) notFound();
  const { session, athlete, trials, metrics, batch, device } = detail;

  const byTrial = new Map<string | null, typeof metrics>();
  for (const m of metrics) {
    const arr = byTrial.get(m.trial_id) ?? [];
    arr.push(m);
    byTrial.set(m.trial_id, arr);
  }
  const derived = byTrial.get(null) ?? [];

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">
          {facility.name} · Session Detail
        </div>
        <h1>
          {TEST_TYPES[session.test_type]?.label ?? session.test_type} — {session.session_date}
        </h1>
        <div className="sub">
          <a href={`/athletes/${athlete.id}`} style={{ color: "var(--accent)" }}>{athlete.display_name}</a>
          {" "}· {athlete.team}
          {session.notes && <> · {session.notes}</>}
        </div>
      </div>

      <div className="statrow" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="k">Provenance</div>
          <div className="v" style={{ fontSize: 14 }}>{batch?.source_label ?? "direct"}</div>
          <div className="d">{batch ? `batch ${batch.id.slice(0, 8)} · ${batch.adapter_key}` : ""}</div>
        </div>
        <div className="stat">
          <div className="k">Device</div>
          <div className="v" style={{ fontSize: 14 }}>{device ? `${device.make} ${device.model}` : "—"}</div>
          <div className="d">{device?.sampling_hz ? `${device.sampling_hz} Hz capture` : ""}</div>
        </div>
        <div className="stat">
          <div className="k">Trials</div>
          <div className="v">{trials.length}</div>
          <div className="d">{trials.filter((t) => t.quality_flag).length} quality-flagged</div>
        </div>
      </div>

      {derived.length > 0 && (
        <div className="panel">
          <h2>Session-level derived metrics</h2>
          <p className="panel-sub">Computed across trials (e.g. asymmetry index from session-best per side).</p>
          <table className="data">
            <thead>
              <tr><th>Metric</th><th className="num">Value</th><th>Unit</th><th>Method</th></tr>
            </thead>
            <tbody>
              {derived.map((m) => {
                const src = m.method_version.includes(":") ? m.method_version.split(":")[1] : null;
                return (
                  <tr key={m.id}>
                    <td>
                      {METRICS[m.metric_type]?.label ?? m.metric_type}
                      {src && <span style={{ color: "var(--ink-mute)", fontSize: 11.5 }}> — {METRICS[src]?.shortLabel ?? src}</span>}
                    </td>
                    <td className="num">{m.value.toFixed(METRICS[m.metric_type]?.precision ?? 2)}</td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{m.unit}</td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-mute)" }}>{m.method_version}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {trials.map((t) => {
        const trialMetrics = byTrial.get(t.id) ?? [];
        const rfdKeys = ["imtp_rfd_0_50", "imtp_rfd_50_150", "imtp_rfd_150_250"] as const;
        const rfdPresent = rfdKeys.filter((k) => trialMetrics.some((m) => m.metric_type === k));
        const waveform = t.waveform_json
          ? (JSON.parse(t.waveform_json) as { hz: number; force: number[]; left?: number[]; right?: number[] })
          : null;
        return (
          <div className="panel" key={t.id}>
            <h2>
              Trial {t.trial_number}
              {t.quality_flag && (
                <span className="chip" data-tone="alert" style={{ marginLeft: 10 }}>{t.quality_flag}</span>
              )}
            </h2>
            {waveform ? (
              <ForceTrace hz={waveform.hz} force={waveform.force} left={waveform.left} right={waveform.right} />
            ) : (
              <div className="callout">
                No waveform stored for this trial — values below were {trialMetrics[0]?.source === "manual" ? "entered manually" : "imported as metric values"} and are labeled with their source.
              </div>
            )}
            {trialMetrics.length > 0 && (
              <table className="data" style={{ marginTop: 12 }}>
                <thead>
                  <tr><th>Metric</th><th>Side</th><th className="num">Value</th><th>Unit</th><th>Method</th><th>Source</th><th>Quality</th></tr>
                </thead>
                <tbody>
                  {trialMetrics.map((m) => (
                    <tr key={m.id}>
                      <td>{METRICS[m.metric_type]?.shortLabel ?? m.metric_type}</td>
                      <td>
                        {m.side !== "bilateral" ? (
                          <span style={{ color: m.side === "left" ? "var(--left)" : "var(--right)", fontWeight: 600, fontSize: 12 }}>
                            {m.side}
                          </span>
                        ) : (
                          <span style={{ color: "var(--ink-mute)", fontSize: 12 }}>bilateral</span>
                        )}
                      </td>
                      <td className="num">{m.value.toFixed(METRICS[m.metric_type]?.precision ?? 2)}</td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{m.unit}</td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-mute)" }}>{m.method_version}</td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>{m.source}</td>
                      <td style={{ fontSize: 11.5 }}>
                        {m.quality_flag ? <span className="chip" data-tone="watch">{m.quality_flag}</span> : <span style={{ color: "var(--ok)" }}>ok</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {rfdPresent.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {rfdPresent.map((k) => (
                  <div key={k} className="interpret-note">
                    <strong style={{ color: "var(--ink)" }}>{METRICS[k].shortLabel}: </strong>
                    {METRICS[k].interpretation}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </main>
  );
}
