import { redirect } from "next/navigation";
import { AuthzError, resolveContext } from "./authz";

/**
 * Resolves the AUTHORIZED active facility for the request.
 *
 * Every page and API route funnels through this (or authz.apiContext), so
 * tenant scoping has one source of truth: in demo mode the cookie-selected
 * facility (controlled demo, unchanged behavior); in required mode the
 * facility is derived from the authenticated user's memberships — a browser
 * cookie can only PICK among facilities the user belongs to, never grant one.
 *
 * Pages calling this while unauthenticated (required mode) redirect to
 * /signin. API routes use authz.apiContext(), which returns 401/403 JSON.
 */
export async function currentFacility() {
  try {
    const ctx = await resolveContext();
    return ctx.facility;
  } catch (e) {
    if (e instanceof AuthzError) redirect("/signin");
    throw e;
  }
}
