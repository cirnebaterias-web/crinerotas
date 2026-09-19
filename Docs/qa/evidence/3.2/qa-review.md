# QA Review — Story 3.2

- Story: `3.2 — Estoque observado da visita com salvamento offline`
- Reviewer: Quinn (`@qa`, Codex)
- Date: 2026-09-18
- Decision: **PASS**
- Reviewed revision: `working-tree-sha256:f30f2b4b7a60380a8c32c5b1e8ac758ad56a8fc95a1925a6f9bb29849a3af1c9`
- Review depth: deep; the change crosses authentication/authorization, IndexedDB transactions, PostgreSQL/RLS/ACL, idempotent sync and mobile UI.

## Outcome

All nine acceptance criteria are implemented and covered by automated evidence. The review found and corrected two user-visible race conditions and added a direct PostgreSQL atomicity proof. The final full-tree CodeRabbit pass completed with zero findings. No waiver is active.

This gate approves the story implementation only. It does not authorize deployment or replace Android/TalkBack/zoom/privacy/performance validation required before a pilot.

## Risk assessment

| Area | Probability | Impact | Result |
| --- | --- | --- | --- |
| Offline draft/outbox atomicity | Medium | High | Mitigated by one Dexie transaction, failure-path tests and retained form state. |
| Authorization and non-enumeration | Low | High | Mitigated by actor resolution, ownership checks, RLS/ACL and negative pgTAP cases. |
| Idempotency and event ordering | Medium | High | Mitigated by stable hashes, sequence checks, advisory locks and replay/conflict tests. |
| Snapshot/audit atomicity | Low | High | Mitigated by a forced audit-permission failure test proving full rollback. |
| UI transition/sync races | Medium | Medium | Corrected during QA and covered by controller and E2E tests. |
| Upgrade/rollback compatibility | Low | High | Expand-only IndexedDB migration and guarded rollback are covered by regression tests. |

## Acceptance-criteria trace

| AC | Given / When / Then evidence | Result |
| --- | --- | --- |
| 1 | Given shared stock input, when zero, empty, negative, decimal, invalid IDs or extra fields are parsed, then only the strict versioned contract is accepted. Covered in contract/domain/HTTP tests. | PASS |
| 2 | Given AB-01 is unresolved, when stock is captured, then only observed Heliar/Moura integers and an optional normalized note are stored; no unit, estimate or SKU detail is introduced. Verified in contract and UI review. | PASS |
| 3 | Given valid stock, when local save succeeds or fails, then draft and outbox commit together before navigation, or the form remains without false confirmation. Covered by repository/controller/E2E failure tests and the synchronous deep-link guard added in QA. | PASS |
| 4 | Given an authorized stored visit, when reopened, refreshed, edited offline or hidden after identity loss, then exact values including zero are restored and durable work is preserved. Covered by offline repository, revocation and Playwright suites. | PASS |
| 5 | Given a stock event, when it is replayed, changed with a new sequence or conflicts with an existing key, then the server returns the canonical prior result, updates once, or rejects deterministically. Snapshot and audit are transactional. Covered by pgTAP and integration tests. | PASS |
| 6 | Given different actor/role/state/order combinations, when stock is saved or acknowledged, then only the active owning seller succeeds and premature stock remains pending as `EVENT_OUT_OF_ORDER` without enumeration. Covered by pgTAP, service and E2E tests. | PASS |
| 7 | Given retry, transport loss, `401`, recoverable failure or terminal `403/409/422`, when sync runs, then event identity is stable, only individual confirmation acknowledges it and local values remain available. The in-flight post-stock race was corrected and unit-tested in QA. | PASS |
| 8 | Given the mobile stock step, when validation/save/status changes occur, then fields have associated errors, controls meet the 44 px target, progress is truthful and status is not color-only. Prices remains an unavailable destination. Covered by UI review and controlled/real E2E. | PASS |
| 9 | Given IndexedDB v1–v6 data and existing visit-start behavior, when upgraded or rolled back, then data remains readable and destructive rollback refuses existing stock/events. All mandatory automated suites pass with synthetic data. | PASS |

## Refactoring and tests performed by QA

1. `visit-start-screen.tsx`: prevents a `?step=prices` deep link without stock from briefly rendering a false `Salvo no aparelho` state.
2. `visit-start-controller.ts`: queues a fresh synchronization after stock save when another sync snapshot is already in flight.
3. `visit-start-controller.test.ts`: proves the queued post-stock synchronization race.
4. `visit_stock.test.sql`: forces audit insertion failure and proves snapshot, idempotency and audit rollback as one PostgreSQL transaction.
5. `20260917140000_visit_start.rollback.sql`: documents the required schema-owner context for temporary `CREATE` grant/revoke. This clarified and eliminated a false-positive CodeRabbit suggestion; changing the order would make the rollback invalid.

## Verification evidence

| Gate | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 204 tests |
| `npm run build` | PASS |
| `npm run db:test` / pgTAP within integration gate | PASS — 334 tests |
| `npm run test:integration` | PASS — 16 integration tests plus 334 pgTAP tests |
| `npm run test:e2e` | PASS — 41 controlled E2E tests |
| `npm run test:e2e:real` | PASS — 4 real-stack E2E tests |
| `git diff --check` | PASS |
| CodeRabbit full uncommitted tree, final pass | PASS — 0 findings |

Total automated assertions reported across the final suites: **599** (204 unit + 334 pgTAP + 16 integration + 41 controlled E2E + 4 real E2E).

## NFR assessment

- Security: PASS. Actor/ownership checks, RLS, least-privilege ACL, non-enumerating failures and revocation behavior are covered.
- Reliability: PASS. Local and server atomicity, replay, response loss, retries, ordering, lock order, refresh and upgrades are covered.
- Performance: PASS for this story gate. Bounded payloads, indexed lookup paths and non-blocking synchronization show no regression; physical-device p95 remains a pilot measurement.
- Maintainability: PASS. Contract boundaries are shared, migrations are expand-only, rollback is guarded and race intent now has focused regression tests.
- Testability: PASS. Failures can be injected at local commit, transport, authorization and audit persistence boundaries with observable deterministic outcomes.

## Residual recommendations

- Add a dedicated two-session test that contends direct stock `PUT` against stock sync-batch processing. Existing lock-order, idempotency and concurrency evidence is sufficient for this story, but the explicit cross-path regression would strengthen future changes.
- Complete physical Android, TalkBack, 200% zoom, privacy and p95 measurements before pilot authorization. These are release-readiness activities, not blockers for Story 3.2 acceptance.
