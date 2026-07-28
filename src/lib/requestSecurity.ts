import { NextRequest, NextResponse } from "next/server";

/** Require browser mutations to originate from this exact host. */
export function sameOriginDenied(req: NextRequest): NextResponse | null {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json({ error: "Cross-origin mutation denied." }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (!origin) {
    return NextResponse.json({ error: "Origin header required." }, { status: 403 });
  }
  try {
    if (new URL(origin).origin !== req.nextUrl.origin) {
      return NextResponse.json({ error: "Cross-origin mutation denied." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid Origin header." }, { status: 403 });
  }
  return null;
}

/** Same-origin guard for state-changing top-level navigations such as facility switching. */
export function navigationOriginDenied(req: NextRequest): NextResponse | null {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json({ error: "Cross-origin navigation denied." }, { status: 403 });
  }
  return null;
}
