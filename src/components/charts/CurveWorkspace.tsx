"use client";

/**
 * Force-time curve workspace — display only. All selection, validity,
 * alignment, interpolation and averaging decisions are made server-side in
 * calc/curveWorkspace.ts + services/curves.ts; this component draws the
 * prepared curves, official annotations, and honest metadata (what's shown,
 * what was averaged, what was excluded and why).
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { linearScale, niceTicks } from "./scale";
import type { CurveWorkspaceData } from "@/lib/services/curves";

const SLOT_PARAMS = ["c1", "c2", "c3"] as const;
const COLORS = ["var(--accent)", "var(--stage)", "var(--watch)"];
const IMTP_POINT_TIMES = [50, 100, 150, 200, 250, 300];

export default function CurveWorkspace(data: CurveWorkspaceData) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setSlot = useCallback(
    (slot: number, token: string) => {
      const next = new URLSearchParams(params.toString());
      if (token) next.set(SLOT_PARAMS[slot], token);
      else next.delete(SLOT_PARAMS[slot]);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  const { testType, options, excluded, curves, resolvedTokens } = data;
  const onsetLabel = testType === "cmj" ? "movement onset" : "force onset";

  /* ---- geometry ---- */
  const W = 720;
  const H = 300;
  const PAD = { l: 56, r: 14, t: 14, b: 30 };

  let geom: {
    x: (v: number) => number;
    y: (v: number) => number;
    xMin: number;
    xMax: number;
    yTicks: number[];
    xTicks: number[];
  } | null = null;

  if (curves.length > 0) {
    const xMin = Math.min(...curves.map((c) => c.startMs));
    const xMax = Math.max(...curves.map((c) => c.startMs + (c.force.length - 1) * c.stepMs));
    let yMax = 0;
    let yMin = 0;
    for (const c of curves) {
      for (const v of c.force) {
        if (v > yMax) yMax = v;
        if (v < yMin) yMin = v;
      }
      if (c.annotations.officialPeakForceN != null) yMax = Math.max(yMax, c.annotations.officialPeakForceN);
    }
    yMax *= 1.06;
    const x = linearScale([xMin, xMax], [PAD.l, W - PAD.r]);
    const y = linearScale([yMin, yMax], [H - PAD.b, PAD.t]);
    geom = { x, y, xMin, xMax, yTicks: niceTicks(yMin, yMax, 5), xTicks: niceTicks(xMin, xMax, 7) };
  }

  const line = (c: (typeof curves)[number], series: number[]) =>
    series.map((v, i) => `${geom!.x(c.startMs + i * c.stepMs).toFixed(1)},${geom!.y(v).toFixed(1)}`).join(" ");

  return (
    <div>
      {/* ---- selection controls ---- */}
      <div className="filterbar no-print" style={{ marginBottom: 10 }}>
        {SLOT_PARAMS.map((p, slot) => (
          <label key={p}>
            {`Curve ${slot + 1}`}
            <select value={resolvedTokens[slot] ?? ""} onChange={(e) => setSlot(slot, e.target.value)}>
              <option value="">{slot === 0 ? "Latest valid attempt" : "None"}</option>
              <optgroup label="Individual attempts">
                {options.map((o) => (
                  <option key={o.trialId} value={`attempt:${o.trialId}`}>
                    {o.date} · attempt {o.trialNumber}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Averages (valid attempts only)">
                <option value="rolling:5">Rolling avg — last 5</option>
                <option value="rolling:10">Rolling avg — last 10</option>
                <option value="rolling:30">Rolling avg — last 30</option>
                <option value="alltime">All-time average</option>
              </optgroup>
            </select>
          </label>
        ))}
      </div>

      {curves.length === 0 ? (
        <div className="callout">
          No valid {testType === "cmj" ? "CMJ" : "IMTP"} attempts with stored waveform and alignment markers are
          available{excluded.length > 0 ? ` (${excluded.length} attempts excluded — see below)` : ""}.
        </div>
      ) : (
        <>
          <div className="legend" style={{ marginBottom: 6, flexWrap: "wrap" }}>
            {curves.map((c, i) => (
              <span className="li" key={c.token}>
                <span className="sw" style={{ background: COLORS[i] }} /> {c.label}
              </span>
            ))}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img"
            aria-label={`Aligned force-time curves, time zero at detected ${onsetLabel}`}>
            {/* pre-onset baseline region */}
            {geom!.xMin < 0 && (
              <rect x={geom!.x(geom!.xMin)} y={PAD.t} width={geom!.x(0) - geom!.x(geom!.xMin)} height={H - PAD.t - PAD.b}
                fill="var(--ink-mute)" opacity="0.06" />
            )}
            {geom!.yTicks.map((t) => (
              <g key={`y${t}`}>
                <line x1={PAD.l} x2={W - PAD.r} y1={geom!.y(t)} y2={geom!.y(t)}
                  stroke="var(--line)" strokeWidth="1" strokeDasharray={t === 0 ? undefined : "0"} />
                <text x={PAD.l - 8} y={geom!.y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
                  {Math.round(t)}
                </text>
              </g>
            ))}
            {/* zero-force reference */}
            <line x1={PAD.l} x2={W - PAD.r} y1={geom!.y(0)} y2={geom!.y(0)} stroke="var(--ink-mute)" strokeWidth="1" opacity="0.55" />
            {geom!.xTicks.map((t) => (
              <text key={`x${t}`} x={geom!.x(t)} y={H - 9} textAnchor="middle" fontSize="10" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
                {Math.round(t)}ms
              </text>
            ))}
            {/* onset line at time 0 */}
            <line x1={geom!.x(0)} x2={geom!.x(0)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-dim)" strokeWidth="1" strokeDasharray="4 3" />
            <text x={geom!.x(0) + 4} y={PAD.t + 10} fontSize="9.5" fill="var(--ink-dim)" fontFamily="var(--font-mono)">
              0 = {onsetLabel}
            </text>

            {/* IMTP fixed-time gridlines */}
            {testType === "imtp" &&
              IMTP_POINT_TIMES.filter((t) => t <= geom!.xMax).map((t) => (
                <g key={`fp${t}`}>
                  <line x1={geom!.x(t)} x2={geom!.x(t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--accent)" strokeWidth="0.75" strokeDasharray="2 4" opacity="0.5" />
                  <text x={geom!.x(t)} y={H - PAD.b + 10} textAnchor="middle" fontSize="8.5" fill="var(--accent)" opacity="0.8" fontFamily="var(--font-mono)">
                    {t}
                  </text>
                </g>
              ))}

            {/* curves */}
            {curves.map((c, i) => (
              <polyline key={c.token} points={line(c, c.force)} fill="none" stroke={COLORS[i]} strokeWidth="1.6" opacity="0.92" />
            ))}
            {/* single bilateral individual curve: show side traces */}
            {curves.length === 1 && curves[0].left && curves[0].right && (
              <>
                <polyline points={line(curves[0], curves[0].left)} fill="none" stroke="var(--left)" strokeWidth="1.1" opacity="0.75" />
                <polyline points={line(curves[0], curves[0].right)} fill="none" stroke="var(--right)" strokeWidth="1.1" opacity="0.75" />
              </>
            )}

            {/* official annotations per individual curve */}
            {curves.map((c, i) => {
              const a = c.annotations;
              if (c.kind !== "individual") return null;
              return (
                <g key={`ann-${c.token}`}>
                  {testType === "imtp" &&
                    a.officialForcePoints?.map((p) => (
                      <circle key={p.ms} cx={geom!.x(p.ms)} cy={geom!.y(p.forceN)} r="3.2" fill={COLORS[i]} stroke="var(--bg, #fff)" strokeWidth="1" />
                    ))}
                  {testType === "imtp" && a.peakForceRelMs != null && a.officialPeakForceN != null && a.peakForceRelMs <= geom!.xMax && (
                    <g>
                      <circle cx={geom!.x(a.peakForceRelMs)} cy={geom!.y(a.officialPeakForceN)} r="4" fill="none" stroke={COLORS[i]} strokeWidth="1.5" />
                      <text x={geom!.x(a.peakForceRelMs) + 6} y={geom!.y(a.officialPeakForceN) - 5} fontSize="9" fill={COLORS[i]} fontFamily="var(--font-mono)">
                        peak
                      </text>
                    </g>
                  )}
                  {testType === "cmj" && a.takeoffRelMs != null && (
                    <g>
                      <line x1={geom!.x(a.takeoffRelMs)} x2={geom!.x(a.takeoffRelMs)} y1={PAD.t} y2={H - PAD.b} stroke={COLORS[i]} strokeWidth="1" strokeDasharray="5 3" opacity="0.8" />
                      <text x={geom!.x(a.takeoffRelMs) + 4} y={PAD.t + 10} fontSize="9.5" fill={COLORS[i]} fontFamily="var(--font-mono)">
                        takeoff
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

          {curves.length === 1 && curves[0].left && curves[0].right && (
            <div className="legend" style={{ marginTop: 4 }}>
              <span className="li"><span className="sw" style={{ background: "var(--left)" }} /> left plate</span>
              <span className="li"><span className="sw" style={{ background: "var(--right)" }} /> right plate</span>
            </div>
          )}

          {/* ---- per-curve metadata: what exactly is on screen ---- */}
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {curves.map((c, i) => (
              <div key={c.token} style={{ fontSize: 12.5, color: "var(--ink-dim)", borderLeft: `3px solid ${COLORS[i]}`, paddingLeft: 10 }}>
                <strong style={{ color: "var(--ink)" }}>{c.label}</strong>
                {" — "}
                {c.kind === "individual" ? "individual attempt" : `average of ${c.includedCount} valid attempts`}
                {" · aligned at detected "}{onsetLabel}
                {" · display copy at "}{c.hz} Hz
                {c.kind === "individual" && testType === "imtp" && c.annotations.officialPeakForceN != null && (
                  <> · peak force {Math.round(c.annotations.officialPeakForceN)} N
                    {c.annotations.officialTimeToPeakMs != null && <> · time to peak {Math.round(c.annotations.officialTimeToPeakMs)} ms</>} (official values)</>
                )}
                {c.kind === "individual" && testType === "cmj" && c.annotations.officialTimeToTakeoffMs != null && (
                  <> · time to takeoff {Math.round(c.annotations.officialTimeToTakeoffMs)} ms (official value)</>
                )}
                {c.insufficient && (
                  <span className="chip" data-tone="watch" style={{ marginLeft: 8 }}>
                    fewer valid attempts than the {c.requestedCount} requested
                  </span>
                )}
                {c.excluded.length > 0 && (
                  <div style={{ marginTop: 2 }}>
                    Excluded from this average: {c.excluded.map((e) => `${e.date} attempt ${e.trialNumber} (${e.reason})`).join("; ")}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 10 }}>
            Curves are aligned so time 0 is the detected {onsetLabel}; display starts 20 ms earlier (shaded
            pre-onset baseline). Event positions and annotated values come from the full-rate-derived markers and
            official metric records — never re-measured from this downsampled display copy. Averages combine only
            valid, rate-compatible attempts over their overlapping window.
          </div>
        </>
      )}

      {excluded.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--ink-dim)" }}>
            {excluded.length} attempt{excluded.length === 1 ? "" : "s"} excluded from curve analysis
          </summary>
          <ul style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 6 }}>
            {excluded.map((e) => (
              <li key={e.trialId}>
                {e.date} · attempt {e.trialNumber} — {e.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
