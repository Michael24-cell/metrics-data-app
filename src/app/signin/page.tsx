"use client";

/**
 * Sign-in (production auth mode). In demo mode this page still works but the
 * app does not require it — the demo banner explains the difference.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" style={{ maxWidth: 420, margin: "60px auto" }}>
      <div className="panel">
        <h2>Sign in to TraceLab</h2>
        <p className="panel-sub">Access is limited to invited facility members.</p>
        <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
          <label style={{ fontSize: 13 }}>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username"
              style={{ width: "100%", marginTop: 4, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--bg2)", color: "var(--ink)" }} />
          </label>
          <label style={{ fontSize: 13 }}>
            Password
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
              style={{ width: "100%", marginTop: 4, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--bg2)", color: "var(--ink)" }} />
          </label>
          {error && <div className="callout" data-tone="alert">{error}</div>}
          <button className="btn" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <p style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 12 }}>
          New here? Activation happens through a facility invitation link. Contact your facility administrator.
        </p>
      </div>
    </main>
  );
}
