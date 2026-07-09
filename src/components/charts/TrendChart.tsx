"use client";

/**
 * Generic longitudinal trend chart.
 *
 * Fully parameterized by metric config — label, units, precision, sanity/
 * threshold display and formatting all come in as props derived from the
 * metric registry. Nothing metric-specific is hardcoded here.
 *
 * Raw vs smoothed is a display toggle (default RAW). Smoothing is a centered
 * 5-session moving average and never feeds calculations.
 */

import { useMemo, useState } from "react";
import { dateMs, linearScale, niceTicks, dateTicks, fmtDateTick, fmtDateShort, fmtValue, smooth } from "./scale";

export interface TrendChartProps {
  points: { date: string; value: number; sessionId?: string }[];
  label: string;
  unit: string;
  precision: number;
  color?: string;
  height?: number;
  /** rolling normal band (baseline monitoring) */
  band?: { date: string; low: number | null; high: number | null }[];
  baselineMean?: number | null;
  thresholdLines?: { value: number; label: string; tone?: "watch" | "alert" | "ok" }[];
  milestones?: { date: string; label: string; kind: string }[];
  interpretation?: string;
  /** show smaller with no axes labels etc. */
  compact?: boolean;
  sessionLinkBase?: string;
  flaggedDates?: string[];
}

const TONES: Record<string, string> = { watch: "var(--watch)", alert: "var(--alert)", ok: "var(--ok)" };

export default function TrendChart(props: TrendChartProps) {
  const {
    points, label, unit, precision, band, baselineMean, thresholdLines, milestones,
    interpretation, sessionLinkBase, flaggedDates,
  } = props;
  const color = props.color ?? "var(--accent)";
  const [mode, setMode] = useState<"raw" | "smoothed">("raw");
  const [hover, setHover] = useState<number | null>(null);

  const W = 720;
  const H = props.height ?? 240;
  const PAD = { l: 52, r: 14, t: 14, b: 30 };

  const geom = useMemo(() => {
    if (points.length === 0) return null;
    const xs = points.map((p) => dateMs(p.date));
    const rawVals = points.map((p) => p.value);
    const displayVals = mode === "smoothed" ? smooth(rawVals, 5) : rawVals;

    let yMin = Math.min(...rawVals);
    let yMax = Math.max(...rawVals);
    for (const b of band ?? []) {
      if (b.low != null) yMin = Math.min(yMin, b.low);
      if (b.high != null) yMax = Math.max(yMax, b.high);
    }
    for (const t of thresholdLines ?? []) {
      yMin = Math.min(yMin, t.value);
      yMax = Math.max(yMax, t.value);
    }
    const yPad = (yMax - yMin || Math.abs(yMax) || 1) * 0.12;
    yMin -= yPad;
    yMax += yPad;

    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const x = linearScale([xMin, xMax], [PAD.l, W - PAD.r]);
    const y = linearScale([yMin, yMax], [H - PAD.b, PAD.t]);

    const pts = points.map((p, i) => ({ px: x(xs[i]), py: y(displayVals[i]), raw: rawVals[i], display: displayVals[i], date: p.date, sessionId: p.sessionId }));

    let bandPath = "";
    if (band && band.length > 0) {
      const withBand = band.filter((b) => b.low != null && b.high != null);
      if (withBand.length > 1) {
        const up = withBand.map((b) => `${x(dateMs(b.date)).toFixed(1)},${y(b.high!).toFixed(1)}`);
        const down = withBand.slice().reverse().map((b) => `${x(dateMs(b.date)).toFixed(1)},${y(b.low!).toFixed(1)}`);
        bandPath = `M${up.join(" L")} L${down.join(" L")} Z`;
      }
    }

    return { pts, x, y, xMin, xMax, yMin, yMax, bandPath, spanMs: xMax - xMin };
  }, [points, band, thresholdLines, mode, H, PAD.l, PAD.b, PAD.t, PAD.r]);

  if (!geom || points.length === 0) {
    return (
      <div>
        <div className="chart-head">
          <span className="chart-title">{label}</span>
          <span className="chart-unit">{unit}</span>
        </div>
        <div className="callout">No data recorded for this metric yet.</div>
      </div>
    );
  }

  const { pts, x, y, spanMs } = geom;
  const line = pts.map((p) => `${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
  const yTicks = niceTicks(geom.yMin, geom.yMax, 4);
  const xTicks = dateTicks(geom.xMin, geom.xMax, Math.min(6, points.length));
  const hoverPt = hover != null ? pts[hover] : null;
  const flagged = new Set(flaggedDates ?? []);

  return (
    <div>
      <div className="chart-head">
        <span className="chart-title">{label}</span>
        <span className="chart-unit">{unit}</span>
        <div className="toggle" role="group" aria-label="raw or smoothed display">
          <button data-on={mode === "raw"} onClick={() => setMode("raw")}>RAW</button>
          <button data-on={mode === "smoothed"} onClick={() => setMode("smoothed")}>SMOOTHED</button>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          let bestD = Infinity;
          pts.forEach((p, i) => {
            const d = Math.abs(p.px - mx);
            if (d < bestD) { bestD = d; best = i; }
          });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* grid + y axis */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
              {fmtValue(t, precision)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
            {fmtDateTick(t, spanMs)}
          </text>
        ))}

        {/* rolling normal band */}
        {geom.bandPath && <path d={geom.bandPath} fill="rgba(76,195,255,0.07)" stroke="rgba(76,195,255,0.25)" strokeWidth="1" strokeDasharray="2 3" />}

        {/* baseline mean */}
        {baselineMean != null && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(baselineMean)} y2={y(baselineMean)} stroke="var(--ink-mute)" strokeWidth="1" strokeDasharray="6 4" />
            <text x={W - PAD.r - 4} y={y(baselineMean) - 4} textAnchor="end" fontSize="9.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
              BENCHMARK MEAN {fmtValue(baselineMean, precision)}
            </text>
          </g>
        )}

        {/* practitioner thresholds */}
        {(thresholdLines ?? []).map((t) => (
          <g key={t.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t.value)} y2={y(t.value)} stroke={TONES[t.tone ?? "watch"]} strokeWidth="1" strokeDasharray="5 4" opacity="0.75" />
            <text x={PAD.l + 4} y={y(t.value) - 4} fontSize="9.5" fill={TONES[t.tone ?? "watch"]} fontFamily="var(--font-mono)">
              {t.label}
            </text>
          </g>
        ))}

        {/* milestones */}
        {(milestones ?? [])
          .filter((m) => dateMs(m.date) >= geom.xMin && dateMs(m.date) <= geom.xMax)
          .map((m) => (
            <g key={m.date + m.label}>
              <line x1={x(dateMs(m.date))} x2={x(dateMs(m.date))} y1={PAD.t} y2={H - PAD.b} stroke="var(--stage)" strokeWidth="1" strokeDasharray="3 4" opacity="0.8" />
              <text x={x(dateMs(m.date)) + 4} y={PAD.t + 9} fontSize="9" fill="var(--stage)" fontFamily="var(--font-mono)">
                {m.label.toUpperCase().slice(0, 26)}
              </text>
            </g>
          ))}

        {/* series */}
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" opacity={mode === "smoothed" ? 0.95 : 0.9} />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.px}
            cy={p.py}
            r={hover === i ? 4.5 : flagged.has(p.date) ? 3.6 : 2.4}
            fill={flagged.has(p.date) ? "var(--alert)" : color}
            stroke={hover === i ? "var(--ink)" : "none"}
            strokeWidth="1"
          />
        ))}

        {/* hover */}
        {hoverPt && (
          <g pointerEvents="none">
            <line x1={hoverPt.px} x2={hoverPt.px} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-mute)" strokeWidth="0.7" />
            <g transform={`translate(${Math.min(hoverPt.px + 8, W - 170)}, ${Math.max(hoverPt.py - 44, PAD.t)})`}>
              <rect width="162" height="40" rx="5" fill="var(--bg3)" stroke="var(--line-strong)" />
              <text x="9" y="16" fontSize="10.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
                {fmtDateShort(dateMs(hoverPt.date))}{mode === "smoothed" ? " · smoothed" : ""}
              </text>
              <text x="9" y="31" fontSize="12.5" fill="var(--ink)" fontFamily="var(--font-mono)" fontWeight="600">
                {fmtValue(hoverPt.display, precision)} {unit}
                {mode === "smoothed" ? `  (raw ${fmtValue(hoverPt.raw, precision)})` : ""}
              </text>
            </g>
          </g>
        )}
      </svg>
      {hoverPt?.sessionId && sessionLinkBase && (
        <div style={{ fontSize: 11, color: "var(--ink-mute)", fontFamily: "var(--font-mono)" }}>
          <a href={`${sessionLinkBase}/${hoverPt.sessionId}`} style={{ color: "var(--accent)" }}>
            open session {hoverPt.date} →
          </a>
        </div>
      )}
      {interpretation && <div className="interpret-note">{interpretation}</div>}
    </div>
  );
}
