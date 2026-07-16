/**
 * Load–velocity chart: observed points + fitted line. Server-renderable
 * (no hooks). The fitted line is drawn ONLY across the observed load range —
 * never extrapolated toward a hypothetical 1RM or zero load.
 */

import { linearScale, niceTicks } from "./scale";
import type { LiveLoadVelocityProfile } from "@/lib/calc/loadVelocity";

export default function LoadVelocityChart({ profile, height }: { profile: LiveLoadVelocityProfile; height?: number }) {
  const { points, slope, intercept } = profile;
  if (points.length === 0) return null;

  const W = 460;
  const H = height ?? 220;
  const PAD = { l: 46, r: 14, t: 12, b: 30 };

  const loads = points.map((p) => p.loadKg);
  const vels = points.map((p) => p.meanVelocityMs);
  const xMin = Math.min(...loads);
  const xMax = Math.max(...loads);
  const xPad = (xMax - xMin || 10) * 0.08;
  let yMin = Math.min(...vels);
  let yMax = Math.max(...vels);
  const yPad = (yMax - yMin || 0.2) * 0.15;
  yMin -= yPad;
  yMax += yPad;

  const x = linearScale([xMin - xPad, xMax + xPad], [PAD.l, W - PAD.r]);
  const y = linearScale([yMin, yMax], [H - PAD.b, PAD.t]);
  const xTicks = niceTicks(xMin - xPad, xMax + xPad, 5);
  const yTicks = niceTicks(yMin, yMax, 4);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 560, height: "auto", display: "block" }} role="img"
      aria-label="Observed load-velocity points with fitted line over the observed load range">
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
          <text x={PAD.l - 7} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={`x${t}`} x={x(t)} y={H - 9} textAnchor="middle" fontSize="10" fill="var(--ink-mute)" fontFamily="var(--font-mono)">
          {Math.round(t)}kg
        </text>
      ))}
      {/* fitted line, observed range only */}
      {slope != null && intercept != null && (
        <line
          x1={x(xMin)} y1={y(intercept + slope * xMin)}
          x2={x(xMax)} y2={y(intercept + slope * xMax)}
          stroke="var(--accent)" strokeWidth="1.6"
        />
      )}
      {points.map((p) => (
        <g key={p.loadKg}>
          <circle cx={x(p.loadKg)} cy={y(p.meanVelocityMs)} r="4" fill="var(--accent)" stroke="var(--bg, #fff)" strokeWidth="1.2" />
          <text x={x(p.loadKg)} y={y(p.meanVelocityMs) - 8} textAnchor="middle" fontSize="9" fill="var(--ink-dim)" fontFamily="var(--font-mono)">
            {p.repCount} rep{p.repCount === 1 ? "" : "s"}
          </text>
        </g>
      ))}
    </svg>
  );
}
