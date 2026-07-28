import { NextRequest, NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/auth/auth";
import { recordAudit } from "@/lib/audit";
import { sameOriginDenied } from "@/lib/requestSecurity";

export async function POST(req: NextRequest) {
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) destroySession(token);
  recordAudit({ action: "auth.signout", outcome: "ok" });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
  return res;
}
