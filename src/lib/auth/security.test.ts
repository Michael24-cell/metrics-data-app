/**
 * Phase 1 security gate — authentication, roles, tenant isolation,
 * idempotency, rate limiting. DB-backed (seeded demo database), no network.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getDb, newId, nowIso } from "../db/db";
import {
  acceptInvitation,
  addMembership,
  authenticate,
  authMode,
  createInvitation,
  createSession,
  createUser,
  sessionUser,
  setUserStatus,
  verifyPassword,
  hashPassword,
  SESSION_TTL_MS,
} from "./auth";
import { can } from "./roles";
import { assertAthleteInFacility, AuthzError, selectActiveFacility, withIdempotency, rateLimit, AuthContext } from "../authz";
import { getAgentRunRecord } from "../agent/runs";

let facA: string; // Ridgeline
let facB: string; // Harbor City
let athleteA: string;
let athleteB: string;

const ctxFor = (facilityId: string, role: "admin" | "coach" | "analyst" | "readonly" = "coach"): AuthContext => ({
  mode: "required",
  user: { id: "u_test", email: "t@t", display_name: "T", status: "active" },
  facility: { id: facilityId, name: "f", short_name: "f" },
  role,
  memberships: [{ facility_id: facilityId, role }],
});

beforeAll(() => {
  const db = getDb();
  const facs = db.prepare(`SELECT id, name FROM facility ORDER BY created_at`).all() as { id: string; name: string }[];
  facA = facs.find((f) => f.name.includes("Ridgeline"))!.id;
  facB = facs.find((f) => f.name.includes("Harbor"))!.id;
  athleteA = (db.prepare(`SELECT id FROM athlete WHERE facility_id = ? LIMIT 1`).get(facA) as { id: string }).id;
  athleteB = (db.prepare(`SELECT id FROM athlete WHERE facility_id = ? LIMIT 1`).get(facB) as { id: string }).id;
});

describe("authentication", () => {
  it("rejects invalid, expired, and disabled sessions", () => {
    expect(sessionUser("not-a-real-token")).toBeNull();
    expect(sessionUser(undefined)).toBeNull();
    const u = createUser(`sec-${newId()}@t.demo`, "Sec Test", "password-123");
    const token = createSession(u.id);
    expect(sessionUser(token)?.id).toBe(u.id);
    // expired
    expect(sessionUser(token, Date.now() + SESSION_TTL_MS + 1000)).toBeNull();
  });

  it("disabled users are denied and their sessions are destroyed", () => {
    const u = createUser(`sec-${newId()}@t.demo`, "Disable Test", "password-123");
    const token = createSession(u.id);
    setUserStatus(u.id, "disabled");
    expect(sessionUser(token)).toBeNull();
    expect(authenticate(u.email, "password-123")).toBeNull();
  });

  it("passwords verify only with the right secret and never store plaintext", () => {
    const stored = hashPassword("correct-horse-battery");
    expect(stored).not.toContain("correct-horse-battery");
    expect(verifyPassword("correct-horse-battery", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
    expect(verifyPassword("anything", null)).toBe(false);
  });

  it("invitation activation grants exactly the invited role, once", () => {
    const email = `inv-${newId()}@t.demo`;
    const token = createInvitation(email, facA, "analyst", null);
    const user = acceptInvitation(token, "Invited Analyst", "password-123");
    expect(user).not.toBeNull();
    expect(user!.status).toBe("active");
    const membership = getDb()
      .prepare(`SELECT role FROM facility_membership WHERE user_id = ? AND facility_id = ?`)
      .get(user!.id, facA) as { role: string };
    expect(membership.role).toBe("analyst");
    // reuse is denied
    expect(acceptInvitation(token, "Again", "password-456")).toBeNull();
  });

  it("expired invitations are denied", () => {
    const token = createInvitation(`exp-${newId()}@t.demo`, facA, "coach", null, 1);
    expect(acceptInvitation(token, "Late", "password-123", Date.now() + 2 * 86400000)).toBeNull();
  });

  it("defaults to demo mode unless explicitly required", () => {
    expect(authMode()).toBe("demo");
  });
});

describe("tenant isolation", () => {
  it("a browser-supplied facility id cannot escape the user's memberships", () => {
    const memberships = [{ facility_id: facA, role: "coach" as const }];
    // preferred = another facility the user does NOT belong to → falls back
    expect(selectActiveFacility(memberships, facB).facility_id).toBe(facA);
    expect(selectActiveFacility(memberships, undefined).facility_id).toBe(facA);
    // multi-facility user: the cookie may pick among memberships only
    const multi = [
      { facility_id: facA, role: "coach" as const },
      { facility_id: facB, role: "coach" as const },
    ];
    expect(selectActiveFacility(multi, facB).facility_id).toBe(facB);
  });

  it("cross-facility athlete access is denied", () => {
    expect(() => assertAthleteInFacility(ctxFor(facA), athleteB)).toThrow(AuthzError);
    expect(() => assertAthleteInFacility(ctxFor(facA), athleteA)).not.toThrow();
  });

  it("cross-facility agent-run access resolves to nothing, never to data", () => {
    const runId = `run_sec_${newId()}`;
    getDb()
      .prepare(
        `INSERT INTO agent_run_record (run_id, facility_id, athlete_id, user_id, task, question, eval_status, mode, run_json, created_at)
         VALUES (?, ?, ?, NULL, 'question', 'q', 'pass', 'scripted', '{}', ?)`
      )
      .run(runId, facA, athleteA, nowIso());
    expect(getAgentRunRecord(facA, runId)?.run_id).toBe(runId);
    expect(getAgentRunRecord(facB, runId)).toBeNull();
  });
});

describe("roles and capabilities", () => {
  it("read-only users cannot mutate anything", () => {
    for (const cap of ["alerts.acknowledge", "monitoring.configure", "imports.write", "members.manage", "settings.manage", "notes.write", "data.delete"] as const) {
      expect(can("readonly", cap)).toBe(false);
    }
    expect(can("readonly", "athletes.view")).toBe(true);
  });

  it("analysts have no user or security management", () => {
    expect(can("analyst", "members.manage")).toBe(false);
    expect(can("analyst", "settings.manage")).toBe(false);
    expect(can("analyst", "agent.ask")).toBe(true);
    expect(can("analyst", "reports.create")).toBe(true);
  });

  it("coaches can configure monitoring and acknowledge alerts; admins manage members", () => {
    expect(can("coach", "monitoring.configure")).toBe(true);
    expect(can("coach", "alerts.acknowledge")).toBe(true);
    expect(can("coach", "members.manage")).toBe(false);
    expect(can("admin", "members.manage")).toBe(true);
    expect(can("admin", "audit.view")).toBe(true);
  });
});

describe("operational protections", () => {
  it("duplicate critical submissions are idempotent (executed once, replayed after)", async () => {
    let executions = 0;
    const key = `test:${newId()}`;
    const first = await withIdempotency(key, () => {
      executions += 1;
      return { value: 42 };
    });
    const second = await withIdempotency(key, () => {
      executions += 1;
      return { value: 99 };
    });
    expect(executions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ value: 42 });
  });

  it("rate limiting caps a fixed window", () => {
    const key = `rl:${newId()}`;
    expect(rateLimit(key, 2)).toBe(true);
    expect(rateLimit(key, 2)).toBe(true);
    expect(rateLimit(key, 2)).toBe(false);
    // new window resets
    expect(rateLimit(key, 2, Date.now() + 61_000)).toBe(true);
  });

  it("membership upsert changes the role without duplicating rows", () => {
    const u = createUser(`role-${newId()}@t.demo`, "Role Test", "password-123");
    addMembership(u.id, facA, "readonly");
    addMembership(u.id, facA, "coach");
    const rows = getDb()
      .prepare(`SELECT role FROM facility_membership WHERE user_id = ? AND facility_id = ?`)
      .all(u.id, facA) as { role: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("coach");
  });
});
