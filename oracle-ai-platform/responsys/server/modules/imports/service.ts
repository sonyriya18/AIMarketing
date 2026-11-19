/**
 * Import lifecycle:
 *   upload → needs_mapping → (validate) → ready_to_commit → committing (job) → completed | failed
 *
 * The raw bytes are stored immutably before anything else. Commit runs in a durable job:
 * stage a dataset version and its facts, then activate it atomically (superseding the previous
 * version and bumping the account's data revision). A crash between the two steps leaves a
 * staged version that the retried job discards and rebuilds.
 */
import path from 'node:path';
import type { Db, Tx } from '../../db/pool';
import type { ObjectStorage } from '../../integrations/storage/storage';
import { AppError, notFound } from '../../http/errors';
import { PermanentJobError, enqueueJob, type JobHandler } from '../../jobs/queue';
import { audit, publishEvent } from '../audit/audit';
import { MAPPING_VERSION, MappingSchema, type ImportMapping } from './formats';
import { inspect, validate, type CampaignFact, type Inspection, type LegacyFact, type ValidationResult } from './validate';
import { ParseError, type Delimiter, type Encoding } from './parse/text';
import { activateVersion } from '../datasets/service';

export interface Tenant {
  workspaceId: string;
  userId: string;
  requestId?: string;
}

const ALLOWED_EXT = new Set(['.csv', '.tsv', '.txt']);

export const IMPORT_COLUMNS = `i.id, i.account_id AS "accountId", i.format, i.status, i.detection, i.mapping, i.validation,
  i.target_dataset_id AS "targetDatasetId", i.dataset_version_id AS "datasetVersionId", i.duplicate_of AS "duplicateOf",
  i.error_message AS "errorMessage", i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.completed_at AS "completedAt",
  r.original_filename AS "fileName", r.byte_size AS "byteSize", r.sha256, u.email AS "createdByEmail"`;

const IMPORT_FROM = `import_jobs i JOIN raw_objects r ON r.id = i.raw_object_id LEFT JOIN users u ON u.id = i.created_by`;

async function getAccount(tx: Tx, accountId: string) {
  const { rows } = await tx.query<{ id: string; currency: string; timezone: string; name: string }>(
    'SELECT id, currency, timezone, name FROM accounts WHERE id = $1',
    [accountId]
  );
  if (!rows[0]) throw notFound('Account');
  return rows[0];
}

export async function getImport(db: Db, t: Tenant, importId: string) {
  const { rows } = await db.withTenant(t, (tx) => tx.query(`SELECT ${IMPORT_COLUMNS} FROM ${IMPORT_FROM} WHERE i.id = $1`, [importId]));
  if (!rows[0]) throw notFound('Import');
  return rows[0];
}

export async function listImports(db: Db, t: Tenant, accountId: string) {
  return db.withTenant(t, async (tx) => {
    await getAccount(tx, accountId);
    const { rows } = await tx.query(`SELECT ${IMPORT_COLUMNS} FROM ${IMPORT_FROM} WHERE i.account_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [accountId]);
    return rows;
  });
}

export async function createImport(
  deps: { db: Db; storage: ObjectStorage },
  t: Tenant,
  accountId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
  opts: { encoding?: Encoding; delimiter?: Delimiter } = {}
) {
  const { db, storage } = deps;
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new AppError('unprocessable', 'Upload a .csv, .tsv or .txt file. Spreadsheet (.xlsx) and archive files are not supported.');
  if (!file.buffer.length) throw new AppError('unprocessable', 'The file is empty.');
  const account = await db.withTenant(t, (tx) => getAccount(tx, accountId));
  const fileName = path.basename(file.originalname).replace(/[^\w .()-]/g, '_').slice(0, 160) || 'upload.csv';

  // Inspect before storing so binary/unsafe content is rejected, but store every text upload
  // (including ones that need decisions) so the import record always has its exact bytes.
  const insp: Inspection = inspect(file.buffer, { ...opts, accountCurrency: account.currency });
  if (insp.error?.code === 'binary_content') throw new AppError('unprocessable', insp.error.message);

  const stored = await storage.put(t.workspaceId, 'imports', file.buffer);
  return db.withTenant(t, async (tx) => {
    const raw = await tx.query<{ id: string }>(
      `INSERT INTO raw_objects (workspace_id, account_id, storage_key, sha256, byte_size, content_type, original_filename, scan_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'text_checked', $8) RETURNING id`,
      [t.workspaceId, accountId, stored.key, stored.sha256, stored.byteSize, file.mimetype.slice(0, 100) || 'text/csv', fileName, t.userId]
    );
    const prior = await tx.query<{ id: string; dataset_version_id: string | null }>(
      `SELECT i.id, i.dataset_version_id FROM import_jobs i JOIN raw_objects r ON r.id = i.raw_object_id
        WHERE i.account_id = $1 AND r.sha256 = $2 AND i.status = 'completed' ORDER BY i.completed_at DESC LIMIT 1`,
      [accountId, stored.sha256]
    );
    const duplicateOf = prior.rows[0]?.id ?? null;
    const status = duplicateOf ? 'cancelled' : 'needs_mapping';
    const format = insp.detection?.format && insp.detection.format !== 'unknown' ? insp.detection.format : 'unknown';
    const proposal = { ...insp.proposal, datasetName: fileName.replace(/\.[^.]+$/, '') };
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO import_jobs (workspace_id, account_id, raw_object_id, format, status, detection, duplicate_of, error_message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        t.workspaceId,
        accountId,
        raw.rows[0]!.id,
        format,
        status,
        JSON.stringify({ ...insp, proposal, mappingVersion: MAPPING_VERSION }),
        duplicateOf,
        duplicateOf ? 'This exact file was already imported for this account' : insp.error?.message ?? null,
        t.userId,
      ]
    );
    const id = rows[0]!.id;
    await audit(tx, t, 'import.upload', { type: 'import', id }, 'success', { fileName, sha256: stored.sha256, bytes: stored.byteSize, duplicateOf });
    await publishEvent(tx, { workspaceId: t.workspaceId, accountId, type: 'import.progress', resourceId: id, payload: { status } });
    const out = await tx.query(`SELECT ${IMPORT_COLUMNS} FROM ${IMPORT_FROM} WHERE i.id = $1`, [id]);
    return out.rows[0];
  });
}

/** Re-inspects with a chosen encoding/delimiter (when detection needed a decision). */
export async function reinspectImport(deps: { db: Db; storage: ObjectStorage }, t: Tenant, importId: string, opts: { encoding?: Encoding; delimiter?: Delimiter }) {
  const { db, storage } = deps;
  const imp = await loadForUpdate(db, t, importId);
  if (!['needs_mapping', 'ready_to_commit'].includes(imp.status)) throw new AppError('conflict', `Import is ${imp.status} and cannot be re-inspected`);
  const bytes = await storage.get(imp.storage_key);
  const insp = inspect(bytes, { ...opts, accountCurrency: imp.currency });
  await db.withTenant(t, (tx) =>
    tx.query(
      `UPDATE import_jobs SET detection = $2, format = $3, status = 'needs_mapping', validation = NULL, error_message = $4, updated_at = now() WHERE id = $1`,
      [importId, JSON.stringify({ ...insp, proposal: { ...insp.proposal, datasetName: imp.original_filename.replace(/\.[^.]+$/, '') }, mappingVersion: MAPPING_VERSION }), insp.detection?.format && insp.detection.format !== 'unknown' ? insp.detection.format : 'unknown', insp.error?.message ?? null]
    )
  );
  return getImport(db, t, importId);
}

async function loadForUpdate(db: Db, t: Tenant, importId: string) {
  const { rows } = await db.withTenant(t, (tx) =>
    tx.query<{ id: string; status: string; account_id: string; storage_key: string; currency: string; original_filename: string; mapping: ImportMapping | null; detected_format: string | null; header_count: number | null }>(
      `SELECT i.id, i.status, i.account_id, r.storage_key, a.currency, r.original_filename, i.mapping,
              i.detection->'detection'->>'format' AS detected_format,
              jsonb_array_length(COALESCE(i.detection->'detection'->'headers', '[]'::jsonb)) AS header_count
         FROM import_jobs i JOIN raw_objects r ON r.id = i.raw_object_id JOIN accounts a ON a.id = i.account_id WHERE i.id = $1`,
      [importId]
    )
  );
  if (!rows[0]) throw notFound('Import');
  return rows[0];
}

async function checkTargetDataset(tx: Tx, accountId: string, mapping: ImportMapping) {
  if (!mapping.targetDatasetId) return;
  const { rows } = await tx.query<{ source_type: string; account_id: string }>('SELECT source_type, account_id FROM datasets WHERE id = $1', [mapping.targetDatasetId]);
  const ds = rows[0];
  if (!ds || ds.account_id !== accountId) throw new AppError('unprocessable', 'The dataset to replace was not found in this account');
  const expected = mapping.format === 'legacy_summary' ? 'upload_legacy_summary' : 'upload_campaign_metrics';
  if (ds.source_type !== expected) throw new AppError('unprocessable', 'The dataset to replace holds a different kind of data');
}

/** Validates a mapping against the full file (dry run). Nothing is committed. */
export async function validateImport(deps: { db: Db; storage: ObjectStorage }, t: Tenant, importId: string, rawMapping: unknown): Promise<ValidationResult> {
  const { db, storage } = deps;
  const parsed = MappingSchema.safeParse(rawMapping);
  if (!parsed.success) {
    throw new AppError('unprocessable', 'The mapping is incomplete or invalid', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const mapping = parsed.data;
  const imp = await loadForUpdate(db, t, importId);
  if (!['needs_mapping', 'ready_to_commit'].includes(imp.status)) throw new AppError('conflict', `Import is ${imp.status}; it can no longer be changed`);
  // Settings must describe this file: same detected format, and only columns that exist in it.
  if (imp.detected_format && imp.detected_format !== 'unknown' && mapping.format !== imp.detected_format) {
    throw new AppError('unprocessable', 'These settings belong to a different kind of file than the one uploaded. Reload the page and open the import again.');
  }
  const outOfRange = Object.values(mapping.columns ?? {}).some((i) => typeof i === 'number' && (i < 0 || i >= (imp.header_count ?? 0)));
  if (outOfRange) throw new AppError('unprocessable', 'The column mapping refers to columns that are not in this file. Reload the page and open the import again.');
  await db.withTenant(t, (tx) => checkTargetDataset(tx, imp.account_id, mapping));
  const bytes = await storage.get(imp.storage_key);
  let result: ValidationResult;
  try {
    result = validate(bytes, mapping).result;
  } catch (e) {
    if (e instanceof ParseError) throw new AppError('unprocessable', e.message);
    throw e;
  }
  await db.withTenant(t, async (tx) => {
    await tx.query(
      `UPDATE import_jobs SET mapping = $2, mapping_version = $3, validation = $4, status = $5, format = $6, target_dataset_id = $7, updated_at = now() WHERE id = $1`,
      [importId, JSON.stringify(mapping), MAPPING_VERSION, JSON.stringify(result), result.ok ? 'ready_to_commit' : 'needs_mapping', mapping.format, mapping.targetDatasetId]
    );
    await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: 'import.progress', resourceId: importId, payload: { status: result.ok ? 'ready_to_commit' : 'needs_mapping' } });
  });
  return result;
}

export async function commitImport(db: Db, t: Tenant, importId: string): Promise<{ jobId: string; status: string }> {
  return db.withTenant(t, async (tx) => {
    const { rows } = await tx.query<{ status: string; account_id: string }>('SELECT status, account_id FROM import_jobs WHERE id = $1 FOR UPDATE', [importId]);
    const imp = rows[0];
    if (!imp) throw notFound('Import');
    if (imp.status === 'committing' || imp.status === 'completed') {
      const job = await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE type = 'import.commit' AND payload->>'importId' = $1 ORDER BY id DESC LIMIT 1`, [importId]);
      return { jobId: job.rows[0]?.id ?? '', status: imp.status };
    }
    if (imp.status !== 'ready_to_commit') throw new AppError('conflict', 'Validate the mapping successfully before committing');
    await tx.query(`UPDATE import_jobs SET status = 'committing', updated_at = now() WHERE id = $1`, [importId]);
    const jobId = await enqueueJob(tx, { workspaceId: t.workspaceId, type: 'import.commit', payload: { importId }, dedupeKey: `import:${importId}`, maxAttempts: 5, createdBy: t.userId });
    await audit(tx, t, 'import.commit_requested', { type: 'import', id: importId }, 'success', { jobId });
    await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: 'import.progress', resourceId: importId, payload: { status: 'committing', jobId } });
    return { jobId, status: 'committing' };
  });
}

export async function cancelImport(db: Db, t: Tenant, importId: string) {
  await db.withTenant(t, async (tx) => {
    const { rows } = await tx.query<{ status: string; account_id: string }>('SELECT status, account_id FROM import_jobs WHERE id = $1 FOR UPDATE', [importId]);
    if (!rows[0]) throw notFound('Import');
    if (!['uploaded', 'needs_mapping', 'ready_to_commit'].includes(rows[0].status)) throw new AppError('conflict', `Import is ${rows[0].status} and cannot be cancelled`);
    await tx.query(`UPDATE import_jobs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [importId]);
    await audit(tx, t, 'import.cancel', { type: 'import', id: importId });
    await publishEvent(tx, { workspaceId: t.workspaceId, accountId: rows[0].account_id, type: 'import.progress', resourceId: importId, payload: { status: 'cancelled' } });
  });
}

// ---------------------------------------------------------------- worker: commit job
const BATCH = 500;

async function insertBatched(tx: Tx, table: string, columns: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples = chunk.map((r) => {
      const ph = r.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      return `(${ph.join(', ')})`;
    });
    await tx.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
  }
}

export function importCommitHandler(storage: ObjectStorage): JobHandler {
  return async (job, { db, heartbeat }) => {
    const importId = String(job.payload.importId ?? '');
    const t = { workspaceId: job.workspace_id, userId: job.created_by ?? '' };
    const imp = await db.withTenant(t, async (tx) => {
      const { rows } = await tx.query<{
        status: string; account_id: string; mapping: ImportMapping; storage_key: string; original_filename: string; dataset_version_id: string | null; created_by: string | null;
      }>(
        `SELECT i.status, i.account_id, i.mapping, r.storage_key, r.original_filename, i.dataset_version_id, i.created_by
           FROM import_jobs i JOIN raw_objects r ON r.id = i.raw_object_id WHERE i.id = $1`,
        [importId]
      );
      return rows[0];
    });
    if (!imp) throw new PermanentJobError('Import not found');
    if (imp.status === 'completed') return { alreadyCompleted: true };
    if (imp.status !== 'committing') throw new PermanentJobError(`Import is ${imp.status}`);
    const actor = { workspaceId: job.workspace_id, userId: imp.created_by };

    const fail = async (message: string) => {
      await db.withTenant(t, async (tx) => {
        await tx.query(`UPDATE import_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [importId, message]);
        await audit(tx, actor, 'import.commit', { type: 'import', id: importId }, 'failure', { message });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: 'import.progress', resourceId: importId, payload: { status: 'failed', message } });
      });
      throw new PermanentJobError(message);
    };

    const mapping = MappingSchema.safeParse(imp.mapping);
    if (!mapping.success) return fail('The stored mapping is no longer valid');
    const bytes = await storage.get(imp.storage_key);
    const out = validate(bytes, mapping.data);
    if (!out.result.ok) return fail(`Validation failed with ${out.result.errorCount} error(s)`);
    await heartbeat();
    const r = out.result;
    const m = mapping.data;
    const sourceType = m.format === 'legacy_summary' ? 'upload_legacy_summary' : 'upload_campaign_metrics';

    // Stage: dataset (new or existing), a staged version, and its facts.
    const staged = await db.withTenant(t, async (tx) => {
      const acct = await tx.query<{ timezone: string }>('SELECT timezone FROM accounts WHERE id = $1', [imp.account_id]);
      let datasetId = m.targetDatasetId;
      if (datasetId) {
        await checkTargetDataset(tx, imp.account_id, m);
        await tx.query('SELECT id FROM datasets WHERE id = $1 FOR UPDATE', [datasetId]);
        const active = await tx.query<{ id: string; content_signature: string }>(`SELECT id, content_signature FROM dataset_versions WHERE dataset_id = $1 AND status = 'active'`, [datasetId]);
        if (active.rows[0]?.content_signature === r.signature) return { unchanged: true as const, versionId: active.rows[0].id, datasetId };
      } else {
        // A retried job may already have created the dataset for this import.
        const existing = await tx.query<{ dataset_id: string }>('SELECT dataset_id FROM dataset_versions WHERE import_job_id = $1 LIMIT 1', [importId]);
        datasetId = existing.rows[0]?.dataset_id ?? null;
        if (!datasetId) {
          const ds = await tx.query<{ id: string }>(
            `INSERT INTO datasets (workspace_id, account_id, name, source_type, grain, time_basis, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [t.workspaceId, imp.account_id, m.datasetName, sourceType, r.grain, r.timeBasis, imp.created_by]
          );
          datasetId = ds.rows[0]!.id;
        }
      }
      // Discard a staged version left behind by a crashed attempt (its facts cascade).
      await tx.query(`DELETE FROM dataset_versions WHERE import_job_id = $1 AND status = 'staged'`, [importId]);
      const next = await tx.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM dataset_versions WHERE dataset_id = $1', [datasetId]);
      const ver = await tx.query<{ id: string }>(
        `INSERT INTO dataset_versions (workspace_id, dataset_id, account_id, version, status, import_job_id, timezone, currency, source_as_of,
                                       coverage_start, coverage_end_exclusive, row_count, quality, content_signature, created_by)
         VALUES ($1, $2, $3, $4, 'staged', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          t.workspaceId, datasetId, imp.account_id, next.rows[0]!.v, importId, acct.rows[0]!.timezone, m.currency,
          r.sourceAsOf ? `${r.sourceAsOf}T00:00:00Z` : null, r.coverage?.start ?? null, r.coverage?.endExclusive ?? null,
          r.acceptedRows, JSON.stringify({ warnings: r.warnings, conflicts: r.conflicts, limitations: r.limitations, semantics: r.semantics, grain: r.grain }),
          r.signature, imp.created_by,
        ]
      );
      const versionId = ver.rows[0]!.id;
      if (m.format === 'legacy_summary') await insertLegacy(tx, t.workspaceId, imp.account_id, versionId, m.currency, out.legacyFacts);
      else await insertCampaign(tx, t.workspaceId, imp.account_id, versionId, m.currency, out.campaignFacts);
      await tx.query(`UPDATE import_jobs SET dataset_version_id = $2, target_dataset_id = $3, updated_at = now() WHERE id = $1`, [importId, versionId, datasetId]);
      return { unchanged: false as const, versionId, datasetId };
    });
    await heartbeat();

    // Activate atomically.
    return db.withTenant(t, async (tx) => {
      const cur = await tx.query<{ status: string }>('SELECT status FROM import_jobs WHERE id = $1 FOR UPDATE', [importId]);
      if (cur.rows[0]?.status === 'completed') return { alreadyCompleted: true };
      if (staged.unchanged) {
        const prev = await tx.query<{ id: string }>('SELECT id FROM import_jobs WHERE dataset_version_id = $1 AND id <> $2 LIMIT 1', [staged.versionId, importId]);
        await tx.query(
          `UPDATE import_jobs SET status = 'completed', completed_at = now(), updated_at = now(), duplicate_of = $2,
                  error_message = 'The data is identical to the active version; no new version was created' WHERE id = $1`,
          [importId, prev.rows[0]?.id ?? null]
        );
        await audit(tx, actor, 'import.commit', { type: 'import', id: importId }, 'success', { unchanged: true });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: 'import.progress', resourceId: importId, payload: { status: 'completed', unchanged: true } });
        return { unchanged: true, datasetVersionId: staged.versionId };
      }
      const revision = await activateVersion(tx, actor, staged.datasetId, staged.versionId, 'import');
      await tx.query(`UPDATE import_jobs SET status = 'completed', completed_at = now(), updated_at = now(), error_message = NULL WHERE id = $1`, [importId]);
      await audit(tx, actor, 'import.commit', { type: 'import', id: importId }, 'success', { datasetId: staged.datasetId, datasetVersionId: staged.versionId, rows: r.acceptedRows, revision });
      await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: 'import.progress', resourceId: importId, revision, payload: { status: 'completed', datasetId: staged.datasetId } });
      return { datasetId: staged.datasetId, datasetVersionId: staged.versionId, revision };
    });
  };
}

async function insertLegacy(tx: Tx, ws: string, accountId: string, versionId: string, currency: string, facts: LegacyFact[]) {
  await insertBatched(
    tx,
    'summary_window_facts',
    ['workspace_id', 'account_id', 'dataset_version_id', 'channel', 'window_key', 'window_label', 'window_days', 'window_start', 'window_end_exclusive', 'currency',
      'sent', 'delivered', 'skipped', 'bounce_rate', 'soft_bounce_rate', 'hard_bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'revenue', 'conversions', 'source_row'],
    facts.map((f) => [ws, accountId, versionId, f.channel, f.windowKey, f.windowLabel, f.windowDays, f.windowStart, f.windowEndExclusive, currency,
      f.sent, f.delivered, f.skipped, f.bounceRate, f.softBounceRate, f.hardBounceRate, f.openRate, f.clickRate, f.unsubscribeRate, f.revenue, f.conversions, f.sourceRow])
  );
}

async function insertCampaign(tx: Tx, ws: string, accountId: string, versionId: string, currency: string, facts: CampaignFact[]) {
  const latest = new Map<string, CampaignFact>();
  for (const f of facts) {
    const cur = latest.get(f.campaignExternalId);
    if (!cur || f.launchDate >= cur.launchDate) latest.set(f.campaignExternalId, f);
  }
  const ids = new Map<string, string>();
  const list = [...latest.values()];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples = chunk.map((f) => {
      values.push(ws, accountId, f.campaignExternalId, f.campaignName, f.channel, f.program);
      const n = values.length;
      return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    const { rows } = await tx.query<{ id: string; external_id: string }>(
      `INSERT INTO campaigns (workspace_id, account_id, external_id, name, channel, program) VALUES ${tuples.join(', ')}
       ON CONFLICT (workspace_id, account_id, external_id) DO UPDATE SET updated_at = now() RETURNING id, external_id`,
      values
    );
    for (const r of rows) ids.set(r.external_id, r.id);
  }
  await insertBatched(
    tx,
    'campaign_launch_facts',
    ['workspace_id', 'account_id', 'dataset_version_id', 'campaign_id', 'launch_external_id', 'channel', 'launch_date', 'launch_time', 'fact_date', 'campaign_name', 'program', 'subject_line', 'creative_type', 'offer', 'currency',
      'sent', 'delivered', 'skipped', 'bounces', 'total_opens', 'unique_opens', 'total_clicks', 'unique_clicks', 'conversion_events', 'orders', 'revenue', 'unsubscribes', 'complaints', 'source_row'],
    facts.map((f) => [ws, accountId, versionId, ids.get(f.campaignExternalId), f.launchExternalId, f.channel, f.launchDate, f.launchTime ?? null, f.factDate, f.campaignName, f.program, f.subjectLine, f.creativeType, f.offer, currency,
      f.sent, f.delivered, f.skipped, f.bounces, f.totalOpens, f.uniqueOpens, f.totalClicks, f.uniqueClicks, f.conversionEvents, f.orders, f.revenue, f.unsubscribes, f.complaints, f.sourceRow])
  );
}
