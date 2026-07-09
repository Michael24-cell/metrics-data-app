/**
 * Stage/criteria status — always evidence (met / not met / insufficient data),
 * never a verdict or readiness score.
 */

import { FindingRefs } from "@/lib/findings/engine";

export default function StageCriteria({ criteria }: { criteria: NonNullable<FindingRefs["criteria"]> }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Practitioner-defined criterion</th>
          <th>Observed (latest data)</th>
          <th>Target</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {criteria.map((c) => (
          <tr key={c.id}>
            <td>{c.label}</td>
            <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{c.observed}</td>
            <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{c.target}</td>
            <td>
              {c.met === null ? (
                <span className="chip">insufficient data</span>
              ) : c.met ? (
                <span className="chip" data-tone="ok">criterion met</span>
              ) : (
                <span className="chip" data-tone="watch">not yet met</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
