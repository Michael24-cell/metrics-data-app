/**
 * Renders one finding with its evidence references and any training-context
 * annotations (which annotate, never replace, the finding).
 */

import { FindingRow } from "@/lib/db/dal";
import { FindingRefs } from "@/lib/findings/engine";

const CATEGORY_LABEL: Record<string, string> = {
  baseline_deviation: "Baseline deviation",
  rts_stage_status: "Stage criteria status",
  asymmetry_flag: "Asymmetry",
  training_context_note: "Training context",
  data_gap: "Data gap",
};

export default function FindingCard({
  finding,
  annotations = [],
  showRefs = true,
}: {
  finding: FindingRow;
  annotations?: FindingRow[];
  showRefs?: boolean;
}) {
  const refs = JSON.parse(finding.refs_json) as FindingRefs;
  const refBits: string[] = [];
  if (refs.metricType) refBits.push(`metric ${refs.metricType}`);
  if (refs.methodVersion) refBits.push(`method v${refs.methodVersion}`);
  if (refs.thresholdKey) refBits.push(`${refs.thresholdKey}=${refs.thresholdValue} (v${refs.thresholdVersion})`);
  if (refs.protocolId) refBits.push(`protocol v${refs.protocolVersion}`);
  if (refs.sessionIds?.length) refBits.push(`${refs.sessionIds.length} session${refs.sessionIds.length > 1 ? "s" : ""}`);
  refBits.push(`engine v${finding.engine_version}`);

  return (
    <div className="finding" data-sev={finding.severity}>
      <div className="f-head">
        <span className="sev" data-sev={finding.severity}>{CATEGORY_LABEL[finding.category] ?? finding.category}</span>
        <span className="f-title">{finding.headline}</span>
        {finding.session_date && <span className="f-date">{finding.session_date}</span>}
      </div>
      <div className="f-detail">{finding.detail}</div>
      {annotations.map((a) => (
        <div key={a.id} className="f-annotation">
          <strong style={{ color: "var(--ink)" }}>Training context — </strong>
          {a.detail}
        </div>
      ))}
      {showRefs && <div className="f-refs">{refBits.join(" · ")}</div>}
    </div>
  );
}
