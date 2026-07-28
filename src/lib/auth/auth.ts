/**
 * Authentication core (server-only).
 *
 * In-repo session auth chosen deliberately: the stack (Next.js + node:sqlite,
 * no existing auth dependency) is best served by scrypt password hashing and
 * DB-backed opaque sessions — zero new vendor dependencies, offline-testable,
 * and an SSO provider can later sit behind the same context helpers.
 *
 * Modes (TRACELAB_AUTH_MODE):
 *  - "demo" (default): the existing controlled demo — no login; requests act
 *    as a synthetic admin. Clearly separated from production behavior.
 *  - "required": every request must carry a valid session cookie; the active
 *    facility is derived from the user's memberships server-side. A browser-
 *    supplied facility id is only honored when the user is a MEMBER of it.
 *
 * Secrets: session tokens are 256-bit random values; only their sha256 is
 * stored. Password hashes use scrypt (N=16384) with per-user salt.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb, newId, nowIso } from "../db/db";
import { Role, isRole } from "./roles";

export type AuthMode = "demo" | "required";

type AuthEnvironment = {
  NODE_ENV?: string;
  NEXT_PHASE?: string;
  TRACELAB_AUTH_MODE?: string;
  TRACELAB_SESSION_SECRET?: string;
};

export function validateAuthConfiguration(env: AuthEnvironment = process.env): void {
  const configured = env.TRACELAB_AUTH_MODE;
  if (configured && configured !== "demo" && configured !== "required") {
    throw new Error(`Invalid TRACELAB_AUTH_MODE '${configured}'. Expected 'demo' or 'required'.`);
  }
  if (env.NODE_ENV === "production") {
    if (configured === "demo") throw new Error("TRACELAB_AUTH_MODE=demo is forbidden in production.");
    // Next evaluates route modules while compiling. Runtime requests still fail
    // closed when the production secret is absent.
    if (env.NEXT_PHASE !== "phase-production-build" && (!env.TRACELAB_SESSION_SECRET || env.TRACELAB_SESSION_SECRET.length < 32)) {
      throw new Error("Production requires TRACELAB_SESSION_SECRET with at least 32 characters.");
    }
  } else if (env.NODE_ENV !== "test" && !configured) {
    throw new Error("Set TRACELAB_AUTH_MODE explicitly to 'demo' or 'required'.");
  }
}

export function authMode(env: AuthEnvironment = process.env): AuthMode {
  validateAuthConfiguration(env);
  if (env.NODE_ENV === "production") return "required";
  return env.TRACELAB_AUTH_MODE === "required" ? "required" : "demo";
}

export const SESSION_COOKIE = "tl_session";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const tokenDigest = (token: string) => {
  const secret = process.env.TRACELAB_SESSION_SECRET;
  return secret ? createHmac("sha256", secret).update(token).digest("hex") : sha256(token);
};

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const DUMMY_PASSWORD_HASH = `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:00000000000000000000000000000000:${
  scryptSync("__tracelab_invalid_account__", "00000000000000000000000000000000", SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }).toString("hex")
}`;

/* ---------------- passwords ---------------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  const legacy = parts.length === 4;
  const [scheme, nStr, rStr, pStr, salt, hash] = legacy
    ? [parts[0], parts[1], String(SCRYPT_R), String(SCRYPT_P), parts[2], parts[3]]
    : parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (
    scheme !== "scrypt" || !salt || !hash ||
    !Number.isInteger(N) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) || r < 1 || r > 32 ||
    !Number.isInteger(p) || p < 1 || p > 16 ||
    !/^[a-f0-9]{128}$/i.test(hash)
  ) return false;
  try {
    const candidate = scryptSync(password, salt, SCRYPT_KEYLEN, { N, r, p, maxmem: 256 * N * r });
    const expected = Buffer.from(hash, "hex");
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/* ---------------- users / sessions ---------------- */

export interface AppUser {
  id: string;
  email: string;
  display_name: string;
  status: string;
}

export function createUser(email: string, displayName: string, password?: string): AppUser {
  const db = getDb();
  const id = newId();
  db.prepare(
    `INSERT INTO app_user (id, email, display_name, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email.toLowerCase(), displayName, password ? hashPassword(password) : null, password ? "active" : "invited", nowIso());
  return { id, email: email.toLowerCase(), display_name: displayName, status: password ? "active" : "invited" };
}

export function addMembership(userId: string, facilityId: string, role: Role): void {
  const db = getDb();
  db
    .prepare(
      `INSERT INTO facility_membership (id, user_id, facility_id, role, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, facility_id) DO UPDATE SET role = excluded.role`
    )
    .run(newId(), userId, facilityId, role, nowIso());
  // Membership creation and role changes are privilege changes. Existing
  // bearer sessions are invalidated so the caller must authenticate again.
  db.prepare(`DELETE FROM user_session WHERE user_id = ?`).run(userId);
}

/** Returns the raw bearer token (set it as an httpOnly cookie); only its hash is stored. */
export function createSession(userId: string, now = Date.now()): string {
  const token = randomBytes(32).toString("hex");
  const db = getDb();
  db.prepare(`DELETE FROM user_session WHERE user_id = ?`).run(userId);
  db
    .prepare(`INSERT INTO user_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(tokenDigest(token), userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
  return token;
}

export function destroySession(token: string): void {
  getDb().prepare(`DELETE FROM user_session WHERE id = ?`).run(tokenDigest(token));
}

/** Validates token, expiry, and user status. Null on any failure — never throws. */
export function sessionUser(token: string | undefined | null, now = Date.now()): AppUser | null {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.status, s.expires_at
       FROM user_session s JOIN app_user u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(tokenDigest(token)) as (AppUser & { expires_at: string }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now) return null;
  if (row.status !== "active") return null; // disabled / not-yet-activated users are denied
  return { id: row.id, email: row.email, display_name: row.display_name, status: row.status };
}

export function membershipsOf(userId: string): { facility_id: string; role: Role }[] {
  const rows = getDb()
    .prepare(`SELECT facility_id, role FROM facility_membership WHERE user_id = ? ORDER BY created_at`)
    .all(userId) as { facility_id: string; role: string }[];
  return rows.filter((r) => isRole(r.role)) as { facility_id: string; role: Role }[];
}

export function authenticate(email: string, password: string): AppUser | null {
  const row = getDb()
    .prepare(`SELECT id, email, display_name, status, password_hash FROM app_user WHERE email = ?`)
    .get(email.toLowerCase()) as (AppUser & { password_hash: string | null }) | undefined;
  // Always perform one bounded scrypt verification so unknown, invited, and
  // disabled accounts do not take a fast path that enables enumeration.
  const passwordOk = verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || row.status !== "active" || !passwordOk) return null;
  return { id: row.id, email: row.email, display_name: row.display_name, status: row.status };
}

/* ---------------- invitations (activation flow) ---------------- */

/** Returns the raw invitation token to deliver out-of-band. */
export function createInvitation(email: string, facilityId: string, role: Role, invitedBy: string | null, ttlDays = 14): string {
  const token = randomBytes(24).toString("hex");
  getDb()
    .prepare(
      `INSERT INTO invitation (id, email, facility_id, role, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sha256(token), email.toLowerCase(), facilityId, role, invitedBy, nowIso(), new Date(Date.now() + ttlDays * 86400000).toISOString());
  return token;
}

/** Accepts an invitation: activates (or creates) the user with the given password and grants membership. */
export function acceptInvitation(token: string, displayName: string, password: string, now = Date.now()): AppUser | null {
  const db = getDb();
  const inv = db.prepare(`SELECT * FROM invitation WHERE id = ?`).get(sha256(token)) as
    | { id: string; email: string; facility_id: string; role: string; expires_at: string; accepted_at: string | null }
    | undefined;
  if (!inv || inv.accepted_at || new Date(inv.expires_at).getTime() <= now || !isRole(inv.role)) return null;
  let user = db.prepare(`SELECT id, email, display_name, status FROM app_user WHERE email = ?`).get(inv.email) as AppUser | undefined;
  if (!user) {
    user = createUser(inv.email, displayName, password);
  } else {
    db.prepare(`UPDATE app_user SET password_hash = ?, status = 'active', display_name = ? WHERE id = ?`).run(
      hashPassword(password), displayName, user.id
    );
    user = { ...user, status: "active", display_name: displayName };
  }
  addMembership(user.id, inv.facility_id, inv.role);
  db.prepare(`UPDATE invitation SET accepted_at = ? WHERE id = ?`).run(nowIso(), inv.id);
  return user;
}

export function setUserStatus(userId: string, status: "active" | "disabled"): void {
  getDb().prepare(`UPDATE app_user SET status = ? WHERE id = ?`).run(status, userId);
  if (status === "disabled") getDb().prepare(`DELETE FROM user_session WHERE user_id = ?`).run(userId);
}
