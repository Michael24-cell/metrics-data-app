import { NextRequest, NextResponse } from "next/server";
import { listFacilities } from "@/lib/db/dal";
import { authMode, membershipsOf, sessionUser, SESSION_COOKIE } from "@/lib/auth/auth";
import { recordAudit } from "@/lib/audit";

/**
 * Facility switcher: sets the scope cookie and returns to the app.
 *
 * Guarded, not self-serve: this app has no user authentication, so a bare
 * link or bookmark must not be able to silently flip facility context.
 * Without `confirm=1`, this returns a warning interstitial instead of
 * switching — the confirm step is the only guard standing between "anyone
 * with this URL" and "the currently viewed facility." Does not touch
 * facility-scoped query logic (src/lib/facility.ts, the DAL) at all.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("set");
  const confirmed = req.nextUrl.searchParams.get("confirm") === "1";
  const facilities = listFacilities();
  const target = facilities.find((f) => f.id === id);

  if (!target) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Production auth mode: the cookie is only a PREFERENCE — switching is
  // allowed solely between facilities the signed-in user belongs to, and the
  // demo interstitial is skipped (membership, not a confirm click, is the guard).
  if (authMode() === "required") {
    const user = sessionUser(req.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return NextResponse.redirect(new URL("/signin", req.url));
    const member = membershipsOf(user.id).some((m) => m.facility_id === target.id);
    recordAudit({ userId: user.id, facilityId: target.id, action: "facility.switch", outcome: member ? "ok" : "denied" });
    if (!member) {
      return NextResponse.json({ error: "You are not a member of that facility." }, { status: 403 });
    }
    const res = NextResponse.redirect(new URL("/", req.url));
    res.cookies.set("flid", target.id, { path: "/", sameSite: "lax" });
    return res;
  }

  if (!confirmed) {
    const confirmUrl = `/api/facility?set=${encodeURIComponent(target.id)}&confirm=1`;
    return new NextResponse(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Confirm facility switch — TraceLab controlled demo</title>
<style>
  body { background:#0a0e13; color:#e7edf4; font-family:system-ui,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .box { max-width:440px; border:1px solid #2a3646; border-radius:10px; background:#10151c; padding:28px; }
  h1 { font-size:18px; margin:0 0 12px; }
  p { color:#9daab8; font-size:13.5px; line-height:1.6; }
  a.btn { display:inline-block; margin-top:16px; background:#3fd8c2; color:#0a0e13; font-weight:600; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:13.5px; }
  a.cancel { display:inline-block; margin-top:16px; margin-left:10px; color:#9daab8; font-size:13.5px; text-decoration:none; }
</style>
</head>
<body>
  <div class="box">
    <h1>Switch active facility to “${target.name}”?</h1>
    <p>
      This is a controlled demo instance with no user login. Anyone with this link can currently
      switch between facilities, so this confirmation step is the only guard in place. Only continue
      if you intend to change which facility's data is being viewed right now.
    </p>
    <a class="btn" href="${confirmUrl}">Yes, switch to ${target.short_name}</a>
    <a class="cancel" href="/">Cancel</a>
  </div>
</body>
</html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set("flid", target.id, { path: "/", sameSite: "lax" });
  return res;
}
