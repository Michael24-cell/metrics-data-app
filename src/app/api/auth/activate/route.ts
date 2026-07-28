import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { acceptInvitation, authMode, createSession, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth/auth";
import { rateLimit } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { sameOriginDenied } from "@/lib/requestSecurity";

const Body = z.object({
  token: z.string().min(16).max(120),
  displayName: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
}).strict();

export async function POST(req: NextRequest) {
  authMode(); // validates the fail-closed deployment contract on direct API access
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!rateLimit(`activate:${ip}`, 10)) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "token, displayName, and password (min 8) required." }, { status: 400 });
  const user = acceptInvitation(parsed.data.token, parsed.data.displayName, parsed.data.password);
  recordAudit({ userId: user?.id ?? null, action: "auth.activate", outcome: user ? "ok" : "denied" });
  if (!user) return NextResponse.json({ error: "Invitation is invalid, expired, or already used." }, { status: 400 });
  const token = createSession(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
