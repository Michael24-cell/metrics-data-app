"use client";

/**
 * Force-time waveform viewer for trial drill-down.
 * Displays the stored (downsampled) trace with total force and optional
 * per-side traces in the product-wide L/R colors. Display only — metrics are
 * computed from the full-rate signal at import time.
 */

import { useState } from "react";
import { linearScale, niceTicks } from "./scale";

export interface ForceTraceProps {
  hz: number;
  force: number[];
  left?: number[];
  right?: number[];
  height?: number;
}

export default function ForceTrace({ hz, force, left, right, height }: ForceTraceProps) {
  const [showSides, setShowSides] = useState(true);
  const W = 720;
  const H = height ?? 230;
  const PAD = { l: 54, r: 12, t: 12, b: 28 };

  const n = force.length;
  const durS = n / hz;
  const yMax = Math.max(...force) * 1.06;
  const x = linearScale([0, durS], [PAD.l, W - PAD.r]);
  const y = linearScale([0, yMax], [H - PAD.b, PAD.t]);

  const toLine = (xs: number[]) =>
    xs.map((v, i) => `${x(i / hz).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const yTicks = niceTicks(0, yMax, 4);
  const xTicks = niceTicks(0, durS, 6);

  return (
    <div>
      <div className="chart-head">
        <span className="chart-title">Force–time trace</span>
        <span className="chart-unit">N vs s · display copy at {hz} Hz</span>
        {left && right && (
          <div className="toggle">
            <button data-on={showSides} onClick={() => setShowSides(true)}>L / R</button>
            <button data-on={!showSides} onClick={() => setShowSides(false)}>TOTAL</button>
          </div>
        )}
      </div>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span className="li"><span className="sw" style={{ background: "var(--accent)" }} /> total vertical force</span>
        {left && right && showSides && (
          <>
            <span className="li"><span className="sw" style={{ background: "var(--left)" }} /> left plate</span>
            <span className="li"><span className="sw" style={{ background: "var(--right)" }} /> right plate</span>
          </>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 9} textAnchor="middle" fontSize="10" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
            {t.toFixed(1)}s
          </text>
        ))}
        <polyline points={toLine(force)} fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity={showSides && left ? 0.55 : 0.95} />
        {showSides && left && <polyline points={toLine(left)} fill="none" stroke="var(--left)" strokeWidth="1.2" opacity="0.9" />}
        {showSides && right && <polyline points={toLine(right)} fill="none" stroke="var(--right)" strokeWidth="1.2" opacity="0.9" />}
      </svg>
    </div>
  );
}
