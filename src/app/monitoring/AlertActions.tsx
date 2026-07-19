"use client";

/** Alert lifecycle buttons — server enforces role; these are presentation. */

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AlertActions({ alertId, status }: { alertId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [showDismiss, setShowDismiss] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (action: string, r?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alertId, action, reason: r }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {status === "new" && (
        <button className="btn secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => act("acknowledge")}>Acknowledge</button>
      )}
      {(status === "new" || status === "acknowledged") && (
        <>
          <button className="btn secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => act("resolve", "Reviewed")}>Resolve</button>
          {!showDismiss ? (
            <button className="btn secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => setShowDismiss(true)}>Dismiss…</button>
          ) : (
            <>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Dismissal reason (required)"
                style={{ padding: "6px 8px", fontSize: 12, borderRadius: 6, border: "1px solid var(--line-strong)", background: "var(--bg2)", color: "var(--ink)" }} />
              <button className="btn secondary" style={{ fontSize: 12 }} disabled={busy || reason.trim().length < 3} onClick={() => act("dismiss", reason)}>Confirm</button>
            </>
          )}
        </>
      )}
      {err && <span style={{ color: "var(--alert)", fontSize: 12 }}>{err}</span>}
    </span>
  );
}
