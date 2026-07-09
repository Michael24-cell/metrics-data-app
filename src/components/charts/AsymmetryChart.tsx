"use client";

/**
 * Asymmetry-over-time chart. Bars colored by the stronger side using the
 * product-wide Left (blue) / Right (amber) convention, with facility
 * watch/flag thresholds drawn as reference lines (threshold version shown
 * by the caller alongside).
 */

import { useState } from "react";
import { dateMs, linearScale, dateTicks, fmtDateTick, fmtDateShort, fmtValue } from "./scale";

export interface AsymmetryChartProps {
  points: { date: string; value: number; strongerSide: "left" | "right" | "equal"; sessionId?: string }[];
  watchPct: number;
  flagPct: number;
  sourceLabel: string;
  height?: number;
}

const SIDE_COLOR: Record<string, string> = {
  left: "var(--left)",
  right: "var(--right)",
  equal: "var(--ink-mute)",
};

export default function AsymmetryChart({ points, watchPct, flagPct, sourceLabel, height }: AsymmetryChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height ?? 210;
  const PAD = { l: 46, r: 14, t: 16, b: 30 };

  if (points.length === 0) {
    return <div className="callout">No per-side data available — asymmetry is not assessable for this metric.</div>;
  }

  const xs = points.map((p) => dateMs(p.date));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(flagPct * 1.3, ...points.map((p) => p.value)) * 1.1;
  const x = linearScale([xMin, xMax], [PAD.l, W - PAD.r]);
  const y = linearScale([0, yMax], [H - PAD.b, PAD.t]);
  const barW = Math.max(2.5, Math.min(10, (W - PAD.l - PAD.r) / (points.length * 1.8)));
  const xTicks = dateTicks(xMin, xMax, Math.min(6, points.length));
  const hoverPt = hover != null ? points[hover] : null;

  return (
    <div>
      <div className="chart-head">
        <span className="chart-title">Asymmetry over time — {sourceLabel}</span>
        <span className="chart-unit">% · |stronger−weaker| ÷ mean of sides</span>
      </div>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span className="li"><span className="sw" style={{ background: "var(--left)" }} /> left stronger</span>
        <span className="li"><span className="sw" style={{ background: "var(--right)" }} /> right stronger</span>
        <span className="li"><span className="sw" style={{ background: "var(--watch)", height: 1 }} /> watch {watchPct}%</span>
        <span className="li"><span className="sw" style={{ background: "var(--alert)", height: 1 }} /> flag {flagPct}%</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0, bestD = Infinity;
          xs.forEach((v, i) => {
            const d = Math.abs(x(v) - mx);
            if (d < bestD) { bestD = d; best = i; }
          });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 5, 10, 15, 20].filter((t) => t <= yMax).map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 7} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">{t}%</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
            {fmtDateTick(t, xMax - xMin)}
          </text>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(watchPct)} y2={y(watchPct)} stroke="var(--watch)" strokeWidth="1" strokeDasharray="5 4" opacity="0.8" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(flagPct)} y2={y(flagPct)} stroke="var(--alert)" strokeWidth="1" strokeDasharray="5 4" opacity="0.8" />
        {points.map((p, i) => (
          <rect
            key={i}
            x={x(xs[i]) - barW / 2}
            y={y(p.value)}
            width={barW}
            height={Math.max(1, y(0) - y(p.value))}
            fill={SIDE_COLOR[p.strongerSide]}
            opacity={hover === i ? 1 : 0.82}
            rx="1.5"
          />
        ))}
        {hoverPt && (
          <g pointerEvents="none" transform={`translate(${Math.min(x(dateMs(hoverPt.date)) + 8, W - 180)}, ${PAD.t})`}>
            <rect width="172" height="40" rx="5" fill="var(--bg3)" stroke="var(--line-strong)" />
            <text x="9" y="16" fontSize="10.5" fill="var(--ink-mute)" fontFamily="var(--font-mono)">{fmtDateShort(dateMs(hoverPt.date))}</text>
            <text x="9" y="31" fontSize="12.5" fill="var(--ink)" fontFamily="var(--font-mono)" fontWeight="600">
              {fmtValue(hoverPt.value, 1)}% · {hoverPt.strongerSide === "equal" ? "sides equal" : `${hoverPt.strongerSide} stronger`}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
