# QA Review — Story 3.3

- Review date: 2026-09-23
- Reviewer: Quinn (Test Architect)
- Reviewed revision: `product-files-sha256:ad8ba99b397b3e986c69b7281cf0ba6072c90b86532397594397b0efab8de857`
- Decision: PASS

## Requirements traceability

| AC | Given / When / Then evidence | Result |
| --- | --- | --- |
| 1 | Given a visit in progress, when the seller submits quotations or explicit unavailability, then empty, invalid-price and missing-reason responses are rejected while later edits remain possible. Covered by contract/domain, pgTAP and Playwright scenarios. | PASS |
| 2 | Given one or more quotations, when they are saved, then every catalog field and a positive decimal string are preserved as separate rows without implicit rounding. Decimal comma is normalized only at the UI boundary to the canonical dot format. | PASS |
| 3 | Given a catalog bound to a visit, when a newer catalog is published before delayed synchronization, then the historical set is resolved, confirmed and persisted; IDs from another set/category are rejected. No operational values are seeded. | PASS |
| 4 | Given a local draft, when the prices section commits or IndexedDB fails, then draft and outbox change atomically; failures keep screen values and offline hard refresh restores durable work. | PASS |
| 5 | Given repeated saves, when the same idempotency key is replayed or a new edit is sent, then the original receipt is returned without duplication and the new event updates report, rows and audit atomically. | PASS |
| 6 | Given ordered visit events and scoped identities, when events arrive out of order, lose a response or come from another actor, then work is preserved/retried or denied without enumeration. | PASS |
| 7 | Given CLI, BFF, sync and mobile UI entry points, when the synthetic flow runs, then the same contract is honored and navigation advances only after durable commit; labels, focus, repeated-row announcements and 44 px targets are covered. | PASS |
| 8 | Given prior IndexedDB/database state, when additive migrations, rollback/reapply and the complete regression suite run, then existing facts remain and rollback refuses destructive history removal. | PASS |

## Risk assessment

| Risk | Initial P×I | Mitigation / residual |
| --- | --- | --- |
| Wrong catalog after delayed offline sync | 3×3 | Exact parameter-set confirmation, retired historical lookup and pgTAP/service/E2E coverage; residual low. |
| Cross-set/category reference corruption | 2×3 | Composite FKs, server validation and negative pgTAP cases; residual low. |
| Partial local or server persistence | 3×3 | IndexedDB and PostgreSQL transactions plus failure injection; residual low. |
| Duplicate/out-of-order synchronization | 3×3 | Aggregate sequence, payload hash, receipts, advisory locks and replay tests; residual low. |
| Unauthorized cross-seller access | 2×3 | Identity/capability checks, least-privilege grants, forced RLS and negative tests; residual low. |
| Destructive rollback | 2×3 | Guarded rollback and lifecycle test with history; residual low. |
| Mobile/accessibility regression | 2×2 | 390 px, keyboard/focus, labels, live status and complete Playwright suite; residual low. |
| Use before commercial approval | 2×3 | No operational seed and explicit AB-02 field-use block; organizational residual remains outside technical completion. |

No residual score is 6 or greater, and no P0 security/data-loss test gap remains.

## Quality evidence

- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: 36 files / 224 tests PASS.
- `npm run build`: PASS.
- `npm run db:reset`: PASS.
- `npm run test:integration`: 8 files / 392 pgTAP plus 4 files / 18 integration tests PASS.
- `npm run test:e2e`: 46 Playwright tests PASS.
- Post-review focused Playwright: decimal comma/canonical price and repeated-error focus, 2/2 PASS.
- `git diff --check`: PASS.
- CodeRabbit: first pass 2 minor findings, both corrected; second pass 0 findings.

## NFR assessment

- Security: PASS — authorization in depth, forced RLS, least privilege, non-enumerating denial and synthetic negative coverage.
- Reliability: PASS — local/server atomicity, ordering, replay, late synchronization, upgrade, recovery and guarded rollback are exercised.
- Maintainability: PASS — shared runtime contracts, pure domain rules, separated adapters and focused regression coverage.
- Performance: PASS within story scope — bounded 25-row payload, indexed catalog/report access and no new runtime dependency; production p95 remains a pilot gate.

## Review fixes

- Hardened published catalog value immutability across both OLD and NEW parameter sets.
- Persisted the server-confirmed `parameterSetId` locally and required it for start confirmations.
- Resolved retired historical catalogs for delayed offline starts without rewriting an applied migration.
- Added predictable focus/live announcements for repeated quotations and associated the observation hint.
- Accepted pt-BR decimal comma at the UI boundary while preserving canonical dot serialization.
- Re-aligned E2E fixtures so the confirmed set exactly matches the cached catalog.

## Remaining release gates

Technical story completion does not authorize field use. AB-02 catalog approval and the documented Android/Chrome physical, TalkBack, 200% zoom, privacy and p95 pilot gates remain required before production rollout.
