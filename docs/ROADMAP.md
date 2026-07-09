# Roadmap

## Now shipping (V1 — this build)

- Facility-scoped canonical schema (all V1 entities, ExternalTestResult schema-only)
- Deterministic calculation engine with tests: CMJ (impulse–momentum height, mRSI, eccentric braking impulse), IMTP (peak force, relative force, RFD windows), DJ RSI, asymmetry/LSI, baseline-deviation monitoring
- Findings engine (5 categories) with evidence references and version stamps
- Adapters: synthetic signal, generic CSV mapper, manual entry, demo dataset; vendor API stubs (interface only)
- Surfaces: Roster/Triage, Athlete Overview, Session Detail with trial drill-down, athlete Progress view, Practitioner Report (print-ready), Case Study, Import workbench, Docs
- Provisional scaffolding: load–velocity progression, force–velocity profile

## Next (requires real-world inputs)

| Item | Blocked on |
|---|---|
| Live vendor force-plate adapters (2 target vendors) | API agreements + customer credentials; the `Adapter` interface and batch runner are ready |
| VBT device ingestion | Vendor export samples to map into `velocity_rep` |
| F–V profiling with prescription-free reporting | A validated multi-load jump protocol per facility |
| Report sharing links + `report_sharing` permission enforcement | Auth model (V1 is single-operator per facility) |
| Threshold management UI | Design review with practitioner partners (data model already versioned) |
| Athlete accounts for the Progress view | Auth + consent flows |

## Later / deliberately deferred

- ExternalTestResult ingestion and any correlation/proxy engine — deferred until a defensible methodology and review process exists; the schema is ready so no migration will be needed.
- Multi-user roles and audit logs per facility.
- Postgres migration for multi-tenant hosting (DAL is the single seam).

## Explicit non-goals (product boundaries, not gaps)

- No live AI agent/chatbot in the product.
- No injury prediction, risk scores, or clearance recommendations — ever, per governance.
- No computer-vision consumer app, golf-specific product, sports-agent product, wearable/video sync, or experimental sensor protocols.
