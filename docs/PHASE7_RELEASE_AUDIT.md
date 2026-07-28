# Phase 7 release-hardening audit

Audit date: 2026-07-27. Source: repository at Phase 7 plus the separate
release-hardening commit. This is a repository gate, not an independent
penetration test or an approval to host sensitive production data.

| System | Implementation evidence | Test evidence | Security or integrity concerns | Status | Required fix |
|---|---|---|---|---|---|
| Authentication | `src/lib/auth/auth.ts`, auth routes, DB sessions | `test:security` | SQLite sessions are single-instance; secret rotation expires sessions | Ready with deployment controls | Provide a 32+ character production session secret and proxy rate limiting |
| Tenant isolation and roles | `src/lib/authz.ts`, facility-scoped DAL, route capabilities | Security, Agent, monitoring isolation tests | Direct SQL remains an audit-sensitive seam | Ready | Preserve facility predicates and capability checks |
| Agent V2.1 | Canonical router, tools, eval/repair, server run/review/feedback tables | Default suite plus `agent:smoke` | Live-provider smoke remains a credentialed deployment check | Ready offline | Run `agent:smoke:live` in the target environment |
| Reliability and monitoring | Versioned CV/TE/SWC/MDC, walk-forward results, policy snapshots | `test:monitoring` and default suite | Statistical policy changes require a new version and replay review | Ready | None for repository release |
| Alerts and digest | Stable dedupe key, tenant-scoped atomic transitions, policy/evidence retention | Alert lifecycle/isolation tests | Scheduler and retry orchestration are deployment responsibilities | Ready | Add external job monitoring before production |
| Imports and exports | Import pipeline and admin-only write route | Default suite and seed verification | No production export endpoint or deletion workflow is complete | Conditional | Do not claim complete retention/deletion operations |
| Database and migrations | WAL SQLite, explicit additive migration initializer | `db:migrate:verify`, seed | SQLite limits concurrency and horizontal scale; backups are external | Demo/single-node only | Move to managed Postgres before multi-instance production |
| Browser/UI | Required-auth and explicit demo banners, role-filtered nav, mobile appbar | Manual browser sweep required per release | Automated browser coverage is not yet in the repository | Conditional | Complete target-browser sweep before deployment |
| Documentation | Security, architecture, this audit, protocol-platform design | Manual review | Older phase language can drift | Ready | Update docs with every security contract change |

## Reproducible gate

```bash
npm test
npm run typecheck
npm run build
npm run test:security
npm run test:monitoring
npm run agent:smoke
npm run db:seed
npm run db:migrate:verify
```

The live Agent provider is intentionally separate:
`ANTHROPIC_API_KEY=... npm run agent:smoke:live`.

## Deployment limitations

- The in-process rate limiter and duplicate-run cache are per instance.
- SQLite WAL is appropriate for a controlled demo or one application node,
  not horizontally scaled writes. Back up the database and WAL consistently,
  verify restores, serialize schema changes, and stop application writes
  during migration/restore operations.
- Production needs TLS, trusted proxy configuration, infrastructure rate
  limits, secret management, monitoring, backup/restore drills, a retention
  policy, and an independent security review.
- Physical deletion capability exists in the role model, but a complete
  reviewed deletion workflow and retention scheduler do not. Do not represent
  those operations as complete.
