# Logistics settlement archive contract

The cost system reads PostgreSQL and MinIO only. DingTalk requests remain in this upstream service. This change adds no cost-system write endpoint, no DingTalk write operation, and no new MinIO credential.

## Database rollout

Apply `migrations/20260909000000_logistics_settlement_archive.cjs`, then `migrations/20260910000000_purchase_template_scope.cjs`, with the existing migration owner before deploying this application code. The September 10 migration also requires `public.ding_process_template`; apply the existing actor-name and repair-queue migrations first when those features are installed. It depends on the approval-instance and existing costing archive/diagnostics migrations. `npm run migrate:up` applies pending migrations through the normal deployment connection. The migration has been tested on a disposable local PostgreSQL database; it has not been applied to a live database.

The existing `allowed_process_template` rows must use `purpose='international_logistics'` with `archive_attachments=true` for main logistics, and `purpose='purchase_expense'` for purchase expenses. Keep purchase `archive_attachments=false`: purchase eligibility is evaluated per approval category, never by enabling the entire purchase template. The September 10 migration automatically registers every metadata template whose name contains the literal `采购支出`, including names such as 拉丁购采购支出、凌翔星铭采购支出 and LEMOS采购支出. The migration scans existing metadata, and a database trigger handles future insertions and renames. Disabled and deleted templates are included. Recorded membership survives later renames, disabling, soft deletion and physical deletion of template metadata. Existing manually configured allowlist purposes and flags, including international logistics, are preserved. Automatically added rows use `purchase_expense`, `archive_attachments=false`, and `auto_registered_purchase=true`. Their membership is stored by `(corp_id, process_code)` in the private `purchase_template_scope` registry so a matching code in another corporation does not widen that corporation’s read, actor-name, attachment or repair-request scope. Existing manual allowlist rows retain their previous scope. Unknown categories remain visible in the approval contract for downstream review and are not queued for attachment download.

The September 9 migration adds two triggers, `retired_at` plus internal revision/claim generation counters on the attachment manifest, the completed-refresh ledger, and the views below. It retains v1 column names and types. Existing attachments whose approval is deleted or outside the current attachment scope are marked retired. The next existing `archive:attachments` scan reconciles current attachment lists and discovers eligible historical purchase attachments. Event/backfill/completed-refresh writes thereafter reconcile the source and manifest in one transaction, under a per-instance row lock.

If `costing_reader` exists, the migration grants schema usage and SELECT on the three new public views. It grants no base-table access or write privileges. If the role is provisioned later, grant only:

```sql
GRANT USAGE ON SCHEMA costing_read TO costing_reader;
GRANT SELECT ON costing_read.approval_instances_v2,
  costing_read.attachment_archives_v2,
  costing_read.completed_approval_refresh_v1 TO costing_reader;
```

For a September 10 rollback, stop new matching/import work and export `purchase_template_scope` and `purchase_approval_exposure` first, especially if template metadata has since been deleted or renamed. Roll down September 10 before September 9. Its down migration restores the prior classifier and views, removes automatic registrations and the two scope ledgers, and leaves manually configured rows, source records, attachment manifests and MinIO objects intact. Repair requests referencing an automatically registered code intentionally block the down migration through their foreign key; the entire rollback transaction is undone. Preserve that evidence and roll forward or resolve the dependency explicitly before retrying. Do not delete repair requests simply to force rollback. Restoring a later backup is necessary to recover registry membership for physically deleted or renamed-away templates after a down/up cycle.

For a September 9 rollback, deploy the prior application first. Its down restores the original v1 attachment filter and removes v2/refresh state; it does not delete MinIO objects.

## Read-only views

`costing_read.approval_instances_v2` contains **every approval from every allowlisted template**, including deleted sources. Its key is `(corp_id, process_instance_id)` and its columns are the existing v1 columns followed by `deleted_at`:

```text
corp_id, process_instance_id, business_id, process_code, title, status, result,
originator_user_id, originator_user_name, originator_dept_id, originator_dept_name,
create_time, finish_time, form_component_values, raw_payload, last_event_time,
updated_at, deleted_at
```

`deleted_at IS NOT NULL` is a retained tombstone; it is not an absent row. `raw_payload` retains the complete existing normalized DingTalk detail, including operation records/comments and attachment references. Any persisted source-content change, including a completed approval's comment change or deletion, advances `updated_at`. September 10 additionally exposes a stable logical update time for newly registered template rows and previously allowlisted approvals newly recognized by the corrected category classifier. This wakes incremental readers even when the raw approval is old. Raw source timestamps and payloads remain untouched; already qualifying manual-allowlist approvals retain their existing view timestamps and content fingerprints. Metadata no-op updates and subsequent matching renames do not advance registration time. An identical poll only advances `last_event_time`; it does not create a source change. The existing running-approval rotation now orders by that successful-check time rather than the content-change timestamp.

`costing_read.attachment_archives_v2` retains manifest rows for allowlisted sources. Its key is `(corp_id, process_instance_id, file_id)` and its columns are existing v1 columns followed by `retired_at`:

```text
corp_id, process_instance_id, process_code, attachment_origin, file_id, space_id,
file_name, declared_size, bucket, object_key, actual_size, content_type, etag,
sha256, archive_status, attempts, last_error, comment_user_id, comment_user_name,
comment_time, comment_remark, archived_at, updated_at, archive_method,
content_quality, failure_code, last_attempt_strategy, diagnostic_json,
recovery_canary, retired_at
```

Removal from the source, deletion of its approval, or a category change outside the allowed attachment scope sets `retired_at` and advances `updated_at`. Reappearance clears the retirement marker. A retired row is kept for audit and is excluded from download claims. V1 exposes only currently eligible, unretired attachments; its columns are unchanged.

New or changed attachment metadata, archive progress, and retirement all advance manifest `updated_at`; identical scans do not. A changed file name, size, space, or thumbnail reference advances a durable monotonic revision generation, creates a new object key, and requeues downloading. Returning to an earlier descriptor does not reuse its earlier object key or recover its old bytes through HEAD. Identical descriptors leave the revision unchanged. Every claim, including an expired claim that is reclaimed, separately increments a durable claim generation and receives its own object key under that descriptor revision. A stale worker can only upload to its old claim key, so it cannot overwrite the object published by the current claim. Both successful and failed manifest writes must match the claim generation, the object key, and the current archiving state. Old worker results cannot replace a newer claim or manifest revision. Read `bucket` and `object_key` verbatim; do not derive the key from the file ID. Read MinIO content only after `archive_status='archived'` and `retired_at IS NULL`, and preserve `content_quality` so a preview is not treated as an original. Existing download retry limits and API throttling remain in use. HEAD recovery is limited to the exact current claim key. Reclaiming uses a fresh key and may redownload after an earlier claim uploaded successfully but failed to persist its result; old claim objects remain unreferenced by the current manifest. DingTalk file IDs and exposed file descriptors are the available change signals; upstream cannot detect a remote byte mutation that changes neither.

Initial consumers must read the complete v2 approval set, not just current/eligible logistics rows. Incremental consumers should independently track approval and attachment updates, retain tombstones, use `(updated_at, corp_id, process_instance_id[, file_id])` for deterministic paging, and replay an overlap interval idempotently. Timestamp fields are not a transactional change-log sequence; an overlapping replay avoids missing a transaction that commits after another reader has observed a newer timestamp. A periodic complete reconciliation provides coverage beyond the overlap interval.

`costing_read.completed_approval_refresh_v1` exposes `(corp_id, process_instance_id, last_checked_at, last_success_at, last_error, lease_until)` for operational inspection. `last_checked_at` means an attempted/claimed refresh, including failures; it is separate from source `updated_at` and is not a source-change watermark.

## Eligible purchase paths

The SQL classifier matches complete, explicitly recognized procurement field labels and complete structured/path values. After whitespace and case normalization, it accepts an explicit category path containing both `服务类采购` / `Compra De Servicios` and `物流及运输服务` / `Servicios de logística y transporte` in a named procurement-category field. It also accepts the actual split-field form:

```text
采购支出Gastos de Compra = 服务商采购Compra de proveedores (or Compra de servicios)
服务类采购 Adquisiciones de servicios = 物流及运输服务Servicios de logística y transporte
```

The exact selected child `服务类采购 Adquisiciones de servicios = 物流及运输服务Servicios de logística y transporte` qualifies on its own; the former upper-category literal is no longer required and an old commodity parent does not veto an explicitly selected logistics child. Empty child labels, the presence of a logistics field label with no selected service child, unknown values, explanation fields and narrative mentions do not qualify. Legacy complete category paths remain supported, including current provider-purchase parent aliases; conflicting parent-only paths remain excluded. The SQL and Python classifiers are checked against the same 26-case fixture without a global parser-version bump.

Purchase approvals that are rejected, withdrawn, cancelled or individually deleted remain in the v2 audit contract; they are excluded by the cost consumer and do not become eligible for new attachment downloads. Template deletion alone does not invalidate individual approvals. International logistics attachments continue to follow the existing allowlist flag. All unrelated approvals remain available as raw approval rows to the authorized reader, but their attachments are not newly archived by this collector.

## Completed approval polling

Enable after the migration and application are deployed:

```dotenv
COMPLETED_APPROVAL_REFRESH_ENABLED=true
COMPLETED_APPROVAL_REFRESH_CRON=*/30 * * * *
COMPLETED_APPROVAL_REFRESH_BATCH_SIZE=10
COMPLETED_APPROVAL_REFRESH_DELAY_MS=1000
COMPLETED_APPROVAL_REFRESH_MIN_INTERVAL_SECONDS=21600
```

The shipped default is disabled until explicitly enabled. The defaults select at most 10 approvals per 30-minute invocation, with one second between requests and at least six hours between attempts for an individual approval. Batch size is validated in 1–100, delay in 500–10000 ms, and the per-approval interval in 60–604800 seconds. API retries may add requests beyond the selected approval count.

Only nondeleted, completed logistics or logistics-service purchase approvals enter the rotation. Selection orders by durable `last_checked_at` with unvisited rows first; each claim advances this timestamp before calling DingTalk. A failure cannot hold the head of the queue. Fifteen-minute leases exclude active claims, expire after a crash, and carry a generation to prevent a stale worker from releasing a newer lease. The scheduler suppresses overlapping in-process invocations. Refreshes use the existing API client, retries, accounting, normalization, and transactional source/attachment synchronization. The existing attachment archive timer downloads newly pending files separately.

## Local verification

`npm run test:run` runs unit tests. PostgreSQL contract tests are opt-in and require a **disposable** loopback database named `settlement_test*`; the tests truncate their fixture tables and exercise migration down/up. They never call DingTalk or MinIO.

```sh
SETTLEMENT_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/settlement_test npm run test:run
npm run build
```

Coverage includes migration up/down, existing/new/renamed/deleted purchase metadata, corporate isolation, incremental exposure of historical records without invalidating unchanged records, the shared SQL/Python category corpus, invalid-purchase attachment exclusions, allowlist/tombstones, the actual bilingual split category, commodity/comment exclusions, comment attachment additions/changes/removals, stable no-op timestamps, nonrepeating archive revisions and old-byte HEAD exclusion, expired-claim success/failure fencing and a delayed preview PUT after publication of the current original, durable fair rotation after failure/reconnect, existing running rotation, read-only grants, and periodic scheduling overlap protection.
