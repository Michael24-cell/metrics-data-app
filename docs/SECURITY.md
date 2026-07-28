# TraceLab Security Foundation

Repository-level security foundation. **This document does not claim the
system is production-secure**: external deployment configuration and an
independent security review are still required (see "Still required" below).

## Authentication

- In-repo session auth: bounded, versioned scrypt parameters (N=16384, r=8,
  p=1, per-user salt) and constant-work unknown-account verification;
  256-bit opaque session tokens stored only as an HMAC-SHA256 digest in production; httpOnly, sameSite=lax
  cookies (secure in production); 7-day expiry; disabled users lose all
  sessions immediately.
- Chosen because the stack (Next.js + node:sqlite) had no existing auth
  dependency; this is offline-testable and vendor-neutral. SSO/OIDC can later
  sit behind the same `resolveContext()` helper without touching data access.
- Activation is invitation-based (`invitation` table, hashed tokens, expiry,
  single-use). No self-serve registration.
- Modes must be explicit outside tests. Production always requires
  `TRACELAB_AUTH_MODE=required` and a 32+ character
  `TRACELAB_SESSION_SECRET`; missing, misspelled, or demo configuration fails
  closed. Demo mode is visibly labeled and forbidden in production.

## Tenancy and authorization

- `organization → facility → facility_membership(user, role)`.
- `authz.resolveContext()` is the single source of the active facility: the
  `flid` cookie is a *preference* honored only when the user is a member.
- Roles: admin / coach / analyst / readonly with an explicit capability map
  (`src/lib/auth/roles.ts`). Enforcement is server-side (`assertCan`);
  UI hiding is presentation only.
- All data access flows through the facility-scoped DAL; every new table
  (agent_run_record, audit_event, monitoring/alerts) carries facility_id and
  every reader takes facilityId first.
- Browser mutations require an exact-host Origin and same-origin fetch
  metadata. Facility-switch navigation rejects cross-site requests.
- Authentication and privilege changes rotate/revoke existing sessions.

## Audit events

`audit_event`: user, facility, action, resource, outcome, version identifiers,
safe metadata, timestamp. Recorded for authentication (success and denial),
facility switches, capability denials, athlete-access denials, agent
questions (with tool-call counts and eval status). Never stores secrets,
session tokens, password material, or unrestricted raw model prompts.

## Operational protections

- Rate limiting: in-process fixed-window limiter on sign-in, activation, and
  agent runs. Production should ADD infrastructure-level limiting (per-IP at
  the proxy) — the in-process limiter is per-instance.
- Idempotency: `idempotency_key` table + `withIdempotency()` for critical
  submissions (alert acknowledgement, monitoring recomputation).
- Request deadlines: the agent enforces per-request timeouts and a total
  wall-clock deadline (see `src/lib/agent/live.ts`).
- Error monitoring: audit failures are swallowed (never take a request down)
  at a single hook point in `src/lib/audit.ts`; wire an APM/error vendor there.
- Secrets: `ANTHROPIC_API_KEY` and future secrets are read from env at call
  time, never persisted or logged. Separate env files per environment.
- Exports: gated by the `exports.create` capability; every export must be
  audited (`export.*` actions).
- Retention/deletion: `data.delete` capability (admin only). Deletion must go
  through a facility-scoped workflow that audits `data.delete` actions;
  physical deletion of athlete data cascades sessions → trials → metrics →
  findings → monitoring records. (Workflow surface is deliberately minimal in
  this phase; the capability, audit action, and scoping rules are in place.)

Agent runs, reviews, feedback, monitoring results/settings, alerts/actions,
and audit events are server-side records. Browser storage is a transient UI
cache only.

## Still required before production (external to this repository)

- TLS termination, proxy-level rate limits, WAF/CDN configuration.
- Secret management (vault/KMS) and key rotation.
- Backup/restore and disaster recovery for the database.
- Independent penetration test and security review.
- Privacy/compliance review of retention defaults per jurisdiction.
