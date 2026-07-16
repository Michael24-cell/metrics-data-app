/**
 * Deterministic claim identity (server-side).
 *
 * Claim IDs are NEVER model-generated. Identity is derived from what the
 * claim is about — type + metric + comparison window + the sorted set of
 * evidence source IDs — so report diffs stay stable when display wording
 * changes, and a re-run over identical data produces identical IDs.
 */

import { createHash } from "node:crypto";
import { Claim, ClaimType, Confidence, EvidenceRef } from "./schemas";

export function claimIdentityKey(
  claimType: ClaimType,
  metricKey: string | undefined,
  comparisonWindow: string | undefined,
  evidence: EvidenceRef[]
): string {
  const ids = [...new Set(evidence.map((e) => e.id))].sort();
  return `${claimType}|${metricKey ?? ""}|${comparisonWindow ?? ""}|${ids.join(",")}`;
}

export function stableClaimId(
  claimType: ClaimType,
  metricKey: string | undefined,
  comparisonWindow: string | undefined,
  evidence: EvidenceRef[]
): string {
  return createHash("sha256")
    .update(claimIdentityKey(claimType, metricKey, comparisonWindow, evidence))
    .digest("hex")
    .slice(0, 16);
}

export interface ClaimDraft {
  text: string;
  claimType: ClaimType;
  metricKey?: string;
  comparisonWindow?: string;
  evidenceRefs: EvidenceRef[];
  confidence: Confidence;
  uncertaintyReason?: string;
}

export function buildClaim(draft: ClaimDraft): Claim {
  return {
    claimId: stableClaimId(draft.claimType, draft.metricKey, draft.comparisonWindow, draft.evidenceRefs),
    ...draft,
  };
}

/** Union of evidence refs across claims, de-duplicated by id. */
export function collectDataUsed(claims: Claim[]): EvidenceRef[] {
  const byId = new Map<string, EvidenceRef>();
  for (const c of claims) for (const e of c.evidenceRefs) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()];
}
