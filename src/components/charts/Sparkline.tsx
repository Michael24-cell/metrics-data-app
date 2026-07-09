/**
 * Server-renderable sparkline for roster rows (no interactivity).
 */

export default function Sparkline({
  values,
  width = 110,
  height = 26,
  color = "var(--accent)",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) {
    return <span style={{ color: "var(--ink-mute)", fontSize: 11 }}>—</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const px = (i / (values.length - 1)) * (width - 4) + 2;
      const py = height - 3 - ((v - min) / span) * (height - 6);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1];
  const lastY = height - 3 - ((last - min) / span) * (height - 6);
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" opacity="0.85" />
      <circle cx={width - 2} cy={lastY} r="2.2" fill={color} />
    </svg>
  );
}
