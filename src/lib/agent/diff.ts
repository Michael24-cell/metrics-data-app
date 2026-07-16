/**
 * Report diff (pure, client-safe).
 *
 * Claims match on their deterministic identity (claimId is derived from
 * type + metric + window + sorted evidence source ids), with a secondary
 * match on the coarser type|metric|window key so wording OR evidence-set
 * changes both surface as "changed" rather than add+remove noise.
 */

import { Claim, ClaimChange, Confidence, EvidenceRef, GeneratedReport, ReportDiff } from "./schemas";

const coarseKey = (c: Claim) => `${c.claimType}|${c.metricKey ?? ""}|${c.comparisonWindow ?? ""}`;

const refIds = (c: Claim) => new Set(c.evidenceRefs.map((r) => r.id));

function evidenceDelta(before: Claim, after: Claim): { added: EvidenceRef[]; dropped: EvidenceRef[] } {
  const b = refIds(before);
  const a = refIds(after);
  return {
    added: after.evidenceRefs.filter((r) => !b.has(r.id)),
    dropped: before.evidenceRefs.filter((r) => !a.has(r.id)),
  };
}

export function diffReports(before: GeneratedReport, after: GeneratedReport): ReportDiff {
  const beforeByExact = new Map(before.claims.map((c) => [c.claimId, c]));
  const afterByExact = new Map(after.claims.map((c) => [c.claimId, c]));
  const beforeByCoarse = new Map<string, Claim[]>();
  for (const c of before.claims) {
    const k = coarseKey(c);
    beforeByCoarse.set(k, [...(beforeByCoarse.get(k) ?? []), c]);
  }

  const added: Claim[] = [];
  const changed: ClaimChange[] = [];
  const matchedBefore = new Set<string>();

  for (const a of after.claims) {
    if (beforeByExact.has(a.claimId)) {
      const b = beforeByExact.get(a.claimId)!;
      matchedBefore.add(b.claimId);
      if (b.text !== a.text || b.confidence !== a.confidence) {
        const delta = evidenceDelta(b, a);
        changed.push({
          identityKey: a.claimId,
          before: b,
          after: a,
          textChanged: b.text !== a.text,
          confidenceChanged: b.confidence !== a.confidence,
          newEvidence: delta.added,
          droppedEvidence: delta.dropped,
        });
      }
      continue;
    }
    // same subject, different evidence set (new session arrived, window moved)
    const candidates = (beforeByCoarse.get(coarseKey(a)) ?? []).filter((b) => !matchedBefore.has(b.claimId));
    if (candidates.length > 0) {
      const b = candidates[0];
      matchedBefore.add(b.claimId);
      const delta = evidenceDelta(b, a);
      changed.push({
        identityKey: coarseKey(a),
        before: b,
        after: a,
        textChanged: b.text !== a.text,
        confidenceChanged: b.confidence !== a.confidence,
        newEvidence: delta.added,
        droppedEvidence: delta.dropped,
      });
      continue;
    }
    added.push(a);
  }

  const removed = before.claims.filter((c) => !matchedBefore.has(c.claimId) && !afterByExact.has(c.claimId));

  const confidenceShift: { from: Confidence; to: Confidence } | null =
    before.confidence === after.confidence ? null : { from: before.confidence, to: after.confidence };

  const bits: string[] = [];
  if (added.length) bits.push(`${added.length} claim(s) added (${added.map((c) => c.claimType).join(", ")})`);
  if (removed.length) bits.push(`${removed.length} removed (${removed.map((c) => c.claimType).join(", ")})`);
  if (changed.length) {
    const withNewEvidence = changed.filter((c) => c.newEvidence.length > 0).length;
    bits.push(`${changed.length} changed${withNewEvidence ? ` — ${withNewEvidence} driven by new evidence` : ""}`);
  }
  if (confidenceShift) bits.push(`overall confidence ${confidenceShift.from} → ${confidenceShift.to}`);
  const summaryText = bits.length
    ? `Between report ${before.reportId.slice(0, 8)} and ${after.reportId.slice(0, 8)}: ${bits.join("; ")}.`
    : "No substantive claim changes between the two reports.";

  return {
    fromReportId: before.reportId,
    toReportId: after.reportId,
    added,
    removed,
    changed,
    confidenceShift,
    summaryText,
  };
}
