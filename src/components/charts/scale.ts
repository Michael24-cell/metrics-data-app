/** Shared helpers for the hand-rolled SVG charts. */

export interface XY {
  x: number;
  y: number;
}

export const dateMs = (iso: string) => new Date(iso + "T00:00:00Z").getTime();

export function linearScale(domain: [number, number], rangePx: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = rangePx;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (count * step) / span;
  const mult = err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1;
  const niceStep = step * mult;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9; v += niceStep) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export function dateTicks(minMs: number, maxMs: number, count = 5): number[] {
  if (maxMs <= minMs) return [minMs];
  const step = (maxMs - minMs) / (count - 1);
  return Array.from({ length: count }, (_, i) => minMs + i * step);
}

export function fmtDateShort(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDateTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs > 200 * 86400000)
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtValue(v: number, precision: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** Centered moving average for DISPLAY smoothing only. */
export function smooth(values: number[], window = 5): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    let acc = 0;
    for (let j = from; j < to; j++) acc += values[j];
    return acc / (to - from);
  });
}
