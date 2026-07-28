"use client";

import { useState } from "react";

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn secondary"
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/auth/signout", { method: "POST" });
        } finally {
          window.location.assign("/signin");
        }
      }}
      style={{ whiteSpace: "nowrap", padding: "6px 10px" }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
