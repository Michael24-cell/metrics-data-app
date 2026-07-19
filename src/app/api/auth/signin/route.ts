import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, createSession, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth/auth";
import { rateLimit } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

const Body = z.object({ email: z.string().email().max(200), password: z.string().min(8).max(200) }).strict();

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!rateLimit(`signin:${ip}`, 10)) {
    return NextResponse.json({ error: "Too many sign-in attempts — try again in a minute." }, { status: 429 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Email and password (min 8 chars) required." }, { status: 400 });
  const user = authenticate(parsed.data.email, parsed.data.password);
  recordAudit({ userId: user?.id ?? null, action: "auth.signin", outcome: user ? "ok" : "denied", metadata: { email: parsed.data.email } });
  if (!user) return NextResponse.json({ error: "Invalid credentials or inactive account." }, { status: 401 });
  const token = createSession(user.id);
  const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.display_name } });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
