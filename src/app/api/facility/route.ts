import { NextRequest, NextResponse } from "next/server";
import { listFacilities } from "@/lib/db/dal";

/** Facility switcher: sets the scope cookie and returns to the app. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("set");
  const valid = listFacilities().some((f) => f.id === id);
  const res = NextResponse.redirect(new URL("/", req.url));
  if (id && valid) {
    res.cookies.set("flid", id, { path: "/", sameSite: "lax" });
  }
  return res;
}
