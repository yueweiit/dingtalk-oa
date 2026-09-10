# Financial source discovery and historical coverage

Apply `20260910010000_financial_source_scope.cjs` and then `20260910020000_financial_source_projection.cjs` after the two settlement migrations described in [the existing archive contract](logistics-settlement-archive.md). It broadens the earlier purchase-only policy. The cost application still reads PostgreSQL and MinIO locally; all DingTalk requests remain in this service. No AI call or document download is performed by discovery/backfill itself.

## Scope and evidence

Metadata naming is a discovery hint: purchase, operating expenditure, expenses/reimbursements, monthly payment, payment/settlement, Chinese/English/Spanish financial names, and historical names ending in `-BU`, `_BU` or ` BU`. Exact historical names can also be supplied explicitly as financial scope inputs. The registry is keyed by corporation and process code; it includes disabled/deleted metadata and survives later name changes and physical metadata deletion. Current template lists do not prove the absence of historical templates. Newly discovered current-list templates start enabled; existing disabled metadata is preserved, and newly discovered historical-only metadata starts disabled while the dedicated archive and daily overlap still include it.

Financial templates expose complete source snapshots, including their original statuses and individual deletion tombstones. A form under a different template name can also enter the read contract when its populated monetary fields and explicit transport evidence establish financial relevance. Its per-instance exposure is durable, so changing or withdrawing the form does not remove the audit row.

Document eligibility requires financial nature plus transport evidence: an explicitly selected logistics category, main freight, transport surcharges, or logistics references such as bills of lading, waybills, containers, linked logistics approvals, or transport document names. Wrong categories do not veto clear evidence. Nested JSON-encoded detail values and comment remarks/content are inspected. Populated nonzero fee fields such as `海运费=12000` and `燃油附加费=500` carry transport evidence; empty labels and zero default fields do not. Financial category aliases include `付款分类=物流费用`. A generic `RelateField` also supplies reference evidence when it names an exact already archived international-logistics instance in the same corporation; substrings and other-tenant IDs do not qualify. Opaque attachment IDs alone are not transport evidence. Customs/tax-only forms and last-mile-only freight do not qualify by those words alone. A source with an explicit logistics reference can be a candidate even when it contains excluded charges: consumers must classify and allocate individual lines. Explicit customs/tax/last-mile-only charges also veto the adoption hint even when the logistics category or a generic logistics reference is present; their references can still justify collecting evidence. No source flag authorizes automatic adoption of a whole form.

Rejected, refused, withdrawn, cancelled and individually deleted financial approvals remain readable but are excluded from new attachment collection and adoption eligibility. Adoption eligibility additionally requires a completed/finished/approved status. Template deletion does not invalidate an individual approval.

Named financial registrations reuse the existing purchase-purpose allowlist and corporation scope for repair compatibility; existing manual purposes and flags remain unchanged. A generic form exposed solely by monetary and transport fields does not automatically gain a template-wide repair authorization. Its already archived local snapshot remains readable.

## Compatible read contracts

`approval_instances_v2` and `attachment_archives_v2` retain their exact column layouts, keys and source/attachment tombstones. Financial scope registration and first per-instance exposure advance their logical approval visibility time without editing raw source snapshots. Repeated registration and identical migration replay preserve that exposure time. Read the complete v2 set initially and continue independent approval/attachment watermarks with overlap replay as described in the existing contract.

`costing_read.financial_sources_v1` contains all approval v2 columns, followed by:

```text
template_name, source_kind, scope_registered_at, transport_evidence,
has_transport_evidence, source_valid, eligible_for_adoption,
attachment_count, attachment_available_count, attachment_pending_count,
attachment_failed_count, attachment_retired_count, evidence_updated_at,
attachment_reference_count, attachment_unqueued_count
```

`source_kind` is `financial`. `transport_evidence` is a text array of zero or more `logistics_category`, `main_freight`, `transport_surcharge`, `logistics_reference`. `eligible_for_adoption` describes candidate eligibility only; matching confidence, line classification and amount ownership remain downstream decisions.

Attachment counts separate source references from collector state. `attachment_reference_count` counts distinct file/media identifiers in current form/comment descriptors, including JSON-encoded values and excluding thumbnail-only identifiers. `attachment_count` is the active manifest count; `attachment_available_count` counts active `archived` records; pending includes `pending`, `archiving`, `retry`; failed counts `manual_required`; retired counts historical retired manifest rows. `attachment_unqueued_count` is current references minus active manifests, floored at zero. An available file may be a preview; read the manifest's `content_quality` before treating it as an original. `evidence_updated_at` includes manifest changes; the inherited approval `updated_at` retains its source meaning.

`costing_read.financial_template_coverage_v1` exposes:

```text
corp_id, process_code, template_name, registered_at,
window_start, window_end, status, discovered_count, processed_count,
pending_instance_count, last_error, completed_at, updated_at,
source_count, eligible_source_count, attachment_count, attachment_available_count
```

Each row describes one durable window. A registered template without queued windows has status `not_scheduled`. Window counts cover API IDs found and successfully persisted; completed means every fetched page and every returned ID completed. The four source/attachment totals describe the process's current local archive across all dates and repeat on each window row; do not sum these repeated process totals. Per-window counts can overlap when operators explicitly schedule overlapping ranges.

`costing_read.financial_template_discovery_v1` exposes exact requested name, resolved code, status, attempts, last check and error. Unresolved names are retained as `failed`, not silently treated as absent templates. Successful lookup uses `GET /v1.0/workflow/processCentres/schemaNames/processCodes?name=...`; its process code is recorded durably. Only explicitly requested/retained names and financial entries from the current list are looked up or registered.

The migration grants SELECT on these three new public views to an existing `costing_reader`; base tables remain private. If that role is created later, grant schema usage and SELECT on those views separately.

## Rollout and 2026 history

1. Apply pending migrations using the existing deployment owner, then deploy the application build. The finance migration is idempotent and performs no DingTalk or MinIO operations. It deliberately refuses a destructive down migration because its coverage/exposure registries are audit evidence. To roll back the application, disable the financial worker and retain the additive schema; the existing read schemas remain compatible. Roll forward to revise a scope decision.
2. Prepare a private JSON array containing all known historical financial template names, including BU names absent from the current list. Keep it outside the repository; fixtures use synthetic names only. Names supplied here explicitly declare financial discovery scope.
3. Discover and enqueue fixed 2026 windows. Dates are inclusive start/exclusive end in Asia/Shanghai. The default end is the start of today (capped at 2027-01-01), with the ordinary daily overlap covering the current day. For a reproducible initial run, supply a fixed cutoff:

```sh
npm run finance:backfill -- --names-file=/private/financial-template-names.json --start=2026-01-01 --end=2026-09-10 --discover-only
npm run finance:backfill -- --resume-only --max-windows=2
npm run finance:backfill -- --status
```

Omit `--max-windows` to drain all ready windows. There is no total record/page/window cap. Reusing an exact window does not reset completion or progress. `--template-name=Example-BU` is a repeatable alternative to a file. `--no-current` skips the current list while preserving exact historical-name lookup. With `--resume-only`, discovery and scheduling are skipped entirely.

4. For continuous recovery, enable the already seeded queue:

```dotenv
FINANCIAL_BACKFILL_ENABLED=true
FINANCIAL_BACKFILL_CRON=7-57/10 * * * *
FINANCIAL_BACKFILL_DELAY_MS=2000
FINANCIAL_BACKFILL_MAX_WINDOWS=1
```

The financial worker waits `FINANCIAL_BACKFILL_DELAY_MS` before every list and detail request, including empty historical windows; the CLI uses the same setting unless `--delay-ms` overrides it. The suggested minute 7/17/27/37/47/57 schedule avoids the usual minute 0/15/30/45 status/refresh starts. This is a conservative per-worker interval, not a guarantee against quotas shared with other processes. The common API client retains its existing behavior. If a search or detail response contains `Forbidden.AccessDenied.QpsLimitForApi` (including wrapped HTTP 403 errors), or HTTP 429, the worker records the failed window and immediately ends the drain with `rateLimited:true`; it does not claim other windows or corporations in that invocation. The CLI exits nonzero and the scheduler waits for its next tick. Do not immediately relaunch a rate-limited CLI or run it alongside the scheduled financial worker.

The scheduler limits work per invocation and suppresses in-process overlap. PostgreSQL row claims protect against other workers. Fifteen-minute leases expire after crashes; each progress update renews the lease, and generation fencing prevents a stale worker from advancing a reclaimed window. A page is saved before its first detail fetch, and an ID is removed only after its source snapshot/manifest transaction succeeds. Failures leave the current ID pending and mark the window failed. Failed windows become retryable after a minute, but are not immediately retried again in the same invocation. A persisted source may be replayed after a crash between persistence and checkpointing; its upsert is idempotent. Nonadvancing/empty continuation pages fail visibly rather than looping or claiming coverage.

5. Run the existing eligible attachment collector. Only financial approvals with transport evidence enter its document queue. The collector's throttles, retries, archived object identity and tombstones remain in force. Inspect source reference, unqueued, pending, available and failed counts independently from historical source completion. Neither discovery nor this worker has an AI stage.
6. Keep the existing completed-approval refresh enabled to detect late comments/documents. Its bounded durable rotation now includes valid completed financial forms even before they have transport evidence. The ordinary daily overlap also includes registered historical financial processes despite missing/disabled metadata. Re-run financial discovery with newly learned exact names and enqueue their historical windows; the current-list sync alone cannot invent missing historical names.

## Verification

Unit tests exercise exact name lookup, discovery filtering/failures, every-page traversal, per-invocation budgeting, failed-ID resumption and scheduler overlap. PostgreSQL tests exercise actual migrations, corporate scope, nested fields/comment aliases, wrong categories, excluded statuses, attachment counts, retained tombstones, read-only grants, completed polling, idempotent replay and durable lease recovery.

```sh
npm run test:run
FINANCIAL_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:5432/settlement_test_financial_LOCAL npm run test:run -- src/db/financial-contract.integration.test.ts
npm run build
```

The PostgreSQL suite requires an explicitly supplied disposable loopback database named `settlement_test_financial*`; it truncates synthetic fixture tables. It never calls DingTalk or MinIO. The prior `SETTLEMENT_TEST_DATABASE_URL` suite remains separate because it exercises down/up of the preceding, narrower migration contract.

## Snapshot projection and bounded attachment collection

The projection migration parses local JSON once for existing snapshots and on subsequent snapshot changes. Source pages, counts, completed refresh selection and coverage read the stored evidence and attachment reference count. Exact related logistics IDs are still resolved against current same-corporation scope; late arrivals and later corporation scope registration advance dependent evidence watermarks. Per-instance advisory locks serialize overlapping source/reference writes under the application's READ COMMITTED transactions. Identical snapshots preserve their evidence watermarks. Coverage aggregates source totals once per process before joining its windows. The migration makes no remote calls and preserves existing view columns and grants.

For an already identified monthly statement, collect only one file with all three exact selectors:

```sh
node dist/cli/archive-attachments.js --corp-id=CORPORATION --instance-id=APPROVAL --file-id=FILE
```

This mode synchronizes only that approval's local manifest and claims only the specified file. It skips the global scan and global retirement pass. Missing, duplicate, empty or unknown selectors fail before any work. Existing eligibility, active lease, retry backoff, five-attempt limit, generation fencing and original/thumbnail quality checks still apply. A target that cannot be claimed is reported without consuming another queued file. Inspect its archive status and content quality afterward; an exit with zero claims is not evidence of an original archived object. Use `ARCHIVE_RECOVERY_CANARY_ONLY=false` for a normal pending target if the environment is temporarily restricted to recovery canaries.
