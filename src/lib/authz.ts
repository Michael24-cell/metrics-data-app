/**
 * Centralized authorization + tenant scoping (server-only).
 *
 * Every page and API handler resolves ONE authorized context through here:
 *   { user, facility, role } — the facility is derived from the session's
 * memberships, never trusted from the browser. The `flid` cookie is only a
 * PREFERENCE among the facilities the user actually belongs to.
 *
 * Demo mode (TRACELAB_AUTH_MODE unset/"demo") preserves the existing
 * controlled demo: a synthetic admin context over the cookie-selected
 * facility, clearly separated from production behavior.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { listFacilities } from "./db/dal";
import { getDb } from "./db/db";
import { authMode, membershipsOf, sessionUser, SESSION_COOKIE, AppUser } from "./auth/auth";
import { can, Capability, Role } from "./auth/roles";
import { recordAudit } from "./audit";

export interface AuthContext {
  mode: "demo" | "required";
  user: AppUser | null; // null only in demo mode
  facility: { id: string; name: string; short_name: string };
  role: Role;
  memberships: { facility_id: string; role: Role }[];
}

export class AuthzError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthzError";
  }
}

/** Resolve the authorized context, or throw AuthzError. */
export async function resolveContext(): Promise<AuthContext> {
  const jar = await cookies();
  const preferred = jar.get("flid")?.value;
  const facilities = listFacilities();
  if (facilities.length === 0) throw new AuthzError(401, "No facilities exist — run the seed first.");

  if (authMode() === "demo") {
    const facility = facilities.find((f) => f.id === preferred) ?? facilities[0];
    return {
      mode: "demo",
      user: null,
      facility,
      role: "admin",
      memberships: facilities.map((f) => ({ facility_id: f.id, role: "admin" as Role })),
    };
  }

  const user = sessionUser(jar.get(SESSION_COOKIE)?.value);
  if (!user) throw new AuthzError(401, "Sign in required.");
  const memberships = membershipsOf(user.id);
  if (memberships.length === 0) throw new AuthzError(403, "No facility memberships for this account.");
  const active = selectActiveFacility(memberships, preferred);
  const facility = facilities.find((f) => f.id === active.facility_id);
  if (!facility) throw new AuthzError(403, "Membership references a missing facility.");
  return { mode: "required", user, facility, role: active.role, memberships };
}

/**
 * The tenant rule, isolated for testing: a browser-preferred facility id is
 * honored ONLY when the user is a member of it; anything else falls back to
 * the first membership. A cookie can pick, never grant.
 */
export function selectActiveFacility(
  memberships: { facility_id: string; role: Role }[],
  preferred: string | undefined
): { facility_id: string; role: Role } {
  return memberships.find((m) => m.facility_id === preferred) ?? memberships[0];
}

/** Assert a capability on an already-resolved context. */
export function assertCan(ctx: AuthContext, cap: Capability): void {
  if (!can(ctx.role, cap)) {
    recordAudit({
      facilityId: ctx.facility.id,
      userId: ctx.user?.id ?? null,
      action: `denied.${cap}`,
      outcome: "denied",
    });
    throw new AuthzError(403, `Role '${ctx.role}' is not permitted to ${cap}.`);
  }
}

/** Assert an athlete belongs to the context facility (tenant isolation). */
export function assertAthleteInFacility(ctx: AuthContext, athleteId: string): void {
  const row = getDb()
    .prepare(`SELECT id FROM athlete WHERE facility_id = ? AND id = ?`)
    .get(ctx.facility.id, athleteId);
  if (!row) {
    recordAudit({
      facilityId: ctx.facility.id,
      userId: ctx.user?.id ?? null,
      action: "denied.athlete_access",
      resourceType: "athlete",
      resourceId: athleteId,
      outcome: "denied",
    });
    throw new AuthzError(403, "Athlete not found in the authorized facility.");
  }
}

/** API wrapper: resolve context (+ optional capability) or return a JSON error response. */
export async function apiContext(cap?: Capability): Promise<AuthContext | NextResponse> {
  try {
    const ctx = await resolveContext();
    if (cap) assertCan(ctx, cap);
    return ctx;
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

export function isDenied(v: AuthContext | NextResponse): v is NextResponse {
  return v instanceof NextResponse;
}

/* ---------------- operational protections ---------------- */

/** In-memory fixed-window rate limiter (per-process; fronting infra adds more). */
const buckets = new Map<string, { windowStart: number; count: number }>();
export function rateLimit(key: string, maxPerMinute: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || now - b.windowStart > 60_000) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= maxPerMinute;
}

/**
 * Idempotency for critical submissions: the first execution's result is
 * stored under the caller-scoped key; duplicates return the stored result
 * without re-executing.
 */
export async function withIdempotency<T>(key: string, fn: () => Promise<T> | T): Promise<{ result: T; replayed: boolean }> {
  const db = getDb();
  const existing = db.prepare(`SELECT result_json FROM idempotency_key WHERE key = ?`).get(key) as
    | { result_json: string }
    | undefined;
  if (existing) return { result: JSON.parse(existing.result_json) as T, replayed: true };
  const result = await fn();
  db.prepare(`INSERT OR IGNORE INTO idempotency_key (key, result_json, created_at) VALUES (?, ?, ?)`).run(
    key, JSON.stringify(result ?? null), new Date().toISOString()
  );
  return { result, replayed: false };
}
