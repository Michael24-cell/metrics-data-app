"use client";

/**
 * Monitoring policy editor (facility template or one athlete's override).
 * Inherited values are shown; only fields the user changes are saved as
 * overrides — the server versions every save and preserves history.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface PolicyFormProps {
  scope: "facility" | "athlete";
  athleteId?: string;
  /** the currently-effective policy (merged) for display */
  effective: {
    baselineSessions: number;
    rollingWindow: number;
    noiseGate: string;
    bandSdMultiplier: number;
    consecutiveLowCount: number;
    requireReliabilityEligible: boolean;
    metricKeys: string[];
  };
  /** which fields the CURRENT layer already overrides */
  ownOverrides: Record<string, unknown>;
  metricOptions: { key: string; label: string }[];
}

export default function PolicyForm({ scope, athleteId, effective, ownOverrides, metricOptions }: PolicyFormProps) {
  const router = useRouter();
  const [form, setForm] = useState({
    baselineSessions: effective.baselineSessions,
    rollingWindow: effective.rollingWindow,
    noiseGate: effective.noiseGate,
    consecutiveLowCount: effective.consecutiveLowCount,
    requireReliabilityEligible: effective.requireReliabilityEligible,
    metricKeys: effective.metricKeys,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const overriddenBadge = (field: string) =>
    field in ownOverrides ? <span className="chip" data-tone="stage" style={{ marginLeft: 6 }}>override</span> : <span className="chip" style={{ marginLeft: 6 }}>inherited</span>;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/monitoring/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, athleteId, overrides: form }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMsg("Saved — a new policy version is active; historical results keep their original version.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleMetric = (key: string) =>
    setForm((p) => ({
      ...p,
      metricKeys: p.metricKeys.includes(key) ? p.metricKeys.filter((k) => k !== key) : [...p.metricKeys, key],
    }));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="filterbar">
        <label>
          Baseline length {overriddenBadge("baselineSessions")}
          <select value={form.baselineSessions} onChange={(e) => setForm((p) => ({ ...p, baselineSessions: Number(e.target.value) }))}>
            <option value={15}>15 eligible sessions (default)</option>
            <option value={30}>30 eligible sessions</option>
          </select>
        </label>
        <label>
          Rolling window {overriddenBadge("rollingWindow")}
          <select value={form.rollingWindow} onChange={(e) => setForm((p) => ({ ...p, rollingWindow: Number(e.target.value) }))}>
            <option value={5}>Previous 5 sessions (default)</option>
            <option value={7}>Previous 7 sessions</option>
            <option value={10}>Previous 10 sessions</option>
          </select>
        </label>
        <label>
          Noise gate {overriddenBadge("noiseGate")}
          <select value={form.noiseGate} onChange={(e) => setForm((p) => ({ ...p, noiseGate: e.target.value }))}>
            <option value="none">None configured — range only (default)</option>
            <option value="te">Typical Error</option>
            <option value="mdc">Minimal Detectable Change</option>
            <option value="swc">Smallest Worthwhile Change</option>
          </select>
        </label>
        <label>
          Consecutive lows {overriddenBadge("consecutiveLowCount")}
          <select value={form.consecutiveLowCount} onChange={(e) => setForm((p) => ({ ...p, consecutiveLowCount: Number(e.target.value) }))}>
            {[2, 3, 4].map((n) => <option key={n} value={n}>{n} consecutive</option>)}
          </select>
        </label>
        <label style={{ alignItems: "center", display: "flex", gap: 6 }}>
          <input type="checkbox" checked={form.requireReliabilityEligible}
            onChange={(e) => setForm((p) => ({ ...p, requireReliabilityEligible: e.target.checked }))} />
          Require reliability eligibility {overriddenBadge("requireReliabilityEligible")}
        </label>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Monitored metrics {overriddenBadge("metricKeys")}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {metricOptions.map((m) => (
            <button key={m.key} type="button" className="chip"
              data-tone={form.metricKeys.includes(m.key) ? "ok" : undefined}
              style={{ cursor: "pointer" }}
              onClick={() => toggleMetric(m.key)}>
              {form.metricKeys.includes(m.key) ? "✓ " : ""}{m.label}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 6 }}>
          Any number of monitoring-eligible metrics may be selected. Unsupported or incomparable metrics are not offered.
        </p>
      </div>

      {msg && <div className="callout">{msg}</div>}
      <div>
        <button className="btn" disabled={busy || form.metricKeys.length === 0} onClick={save}>
          {busy ? "Saving…" : scope === "facility" ? "Save facility template" : "Save athlete override"}
        </button>
      </div>
    </div>
  );
}
