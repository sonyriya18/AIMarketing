/**
 * Dataset versions. Exactly one version of a dataset is active at a time (enforced by a partial
 * unique index). Activation, rollback, and deactivation each bump the account's data revision in
 * the same transaction, so cached reports and open browsers know the data changed.
 * Older versions and their facts are retained as evidence; nothing here deletes data.
 */
import type { Db, Tx } from '../../db/pool';
import { AppError, notFound } from '../../http/errors';
import { audit, publishEvent, type Actor } from '../audit/audit';

export async function bumpRevision(tx: Tx, accountId: string): Promise<string> {
  const { rows } = await tx.query<{ data_revision: string }>('UPDATE accounts SET data_revision = data_revision + 1 WHERE id = $1 RETURNING data_revision', [accountId]);
  return rows[0]!.data_revision;
}

export async function activateVersion(tx: Tx, actor: Actor, datasetId: string, versionId: string, reason: 'import' | 'rollback' | 'sync'): Promise<string> {
  const ds = await tx.query<{ account_id: string }>('SELECT account_id FROM datasets WHERE id = $1 FOR UPDATE', [datasetId]);
  if (!ds.rows[0]) throw notFound('Dataset');
  const v = await tx.query<{ status: string }>('SELECT status FROM dataset_versions WHERE id = $1 AND dataset_id = $2', [versionId, datasetId]);
  if (!v.rows[0]) throw notFound('Dataset version');
  if (v.rows[0].status === 'failed') throw new AppError('conflict', 'A failed version cannot be activated');
  await tx.query(`UPDATE dataset_versions SET status = 'superseded', superseded_at = now() WHERE dataset_id = $1 AND status = 'active' AND id <> $2`, [datasetId, versionId]);
  await tx.query(`UPDATE dataset_versions SET status = 'active', activated_at = now(), superseded_at = NULL WHERE id = $1`, [versionId]);
  await tx.query('UPDATE datasets SET active_version_id = $2, archived_at = NULL WHERE id = $1', [datasetId, versionId]);
  const revision = await bumpRevision(tx, ds.rows[0].account_id);
  await audit(tx, actor, `dataset.activate`, { type: 'dataset_version', id: versionId }, 'success', { datasetId, reason, revision });
  await publishEvent(tx, { workspaceId: actor.workspaceId, accountId: ds.rows[0].account_id, type: 'dataset.activated', resourceId: datasetId, revision, payload: { datasetVersionId: versionId, reason } });
  return revision;
}

export const DATASET_COLUMNS = `d.id, d.account_id AS "accountId", d.name, d.source_type AS "sourceType", d.grain, d.time_basis AS "timeBasis",
  d.active_version_id AS "activeVersionId", d.archived_at AS "archivedAt", d.created_at AS "createdAt",
  v.version AS "activeVersion", v.currency, v.timezone, v.coverage_start AS "coverageStart", v.coverage_end_exclusive AS "coverageEndExclusive",
  v.source_as_of AS "sourceAsOf", v.row_count AS "rowCount", v.quality, v.activated_at AS "activatedAt"`;

export async function listDatasets(db: Db, t: { workspaceId: string }, accountId: string) {
  return db.withTenant(t, async (tx) => {
    const a = await tx.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
    if (!a.rowCount) throw notFound('Account');
    const { rows } = await tx.query(
      `SELECT ${DATASET_COLUMNS} FROM datasets d LEFT JOIN dataset_versions v ON v.id = d.active_version_id
        WHERE d.account_id = $1 ORDER BY d.archived_at NULLS FIRST, v.activated_at DESC NULLS LAST, d.created_at DESC`,
      [accountId]
    );
    return rows;
  });
}

export async function listVersions(db: Db, t: { workspaceId: string }, datasetId: string) {
  return db.withTenant(t, async (tx) => {
    const d = await tx.query('SELECT 1 FROM datasets WHERE id = $1', [datasetId]);
    if (!d.rowCount) throw notFound('Dataset');
    const { rows } = await tx.query(
      `SELECT v.id, v.version, v.status, v.row_count AS "rowCount", v.currency, v.timezone, v.coverage_start AS "coverageStart",
              v.coverage_end_exclusive AS "coverageEndExclusive", v.source_as_of AS "sourceAsOf", v.quality, v.created_at AS "createdAt",
              v.activated_at AS "activatedAt", v.superseded_at AS "supersededAt", v.import_job_id AS "importId",
              r.original_filename AS "fileName", r.sha256
         FROM dataset_versions v LEFT JOIN import_jobs i ON i.id = v.import_job_id LEFT JOIN raw_objects r ON r.id = i.raw_object_id
        WHERE v.dataset_id = $1 ORDER BY v.version DESC`,
      [datasetId]
    );
    return rows;
  });
}

export async function rollbackDataset(db: Db, actor: Actor, datasetId: string, versionId: string) {
  return db.withTenant(actor, async (tx) => {
    const v = await tx.query<{ status: string }>('SELECT status FROM dataset_versions WHERE id = $1 AND dataset_id = $2', [versionId, datasetId]);
    if (!v.rows[0]) throw notFound('Dataset version');
    if (v.rows[0].status === 'active') throw new AppError('conflict', 'This version is already active');
    if (!['superseded', 'deactivated'].includes(v.rows[0].status)) throw new AppError('conflict', `A ${v.rows[0].status} version cannot be restored`);
    return { revision: await activateVersion(tx, actor, datasetId, versionId, 'rollback') };
  });
}

/** Stops using a dataset. Its versions and facts remain as evidence; reports stop selecting it. */
export async function deactivateDataset(db: Db, actor: Actor, datasetId: string) {
  return db.withTenant(actor, async (tx) => {
    const ds = await tx.query<{ account_id: string }>('SELECT account_id FROM datasets WHERE id = $1 FOR UPDATE', [datasetId]);
    if (!ds.rows[0]) throw notFound('Dataset');
    await tx.query(`UPDATE dataset_versions SET status = 'deactivated', superseded_at = now() WHERE dataset_id = $1 AND status = 'active'`, [datasetId]);
    await tx.query('UPDATE datasets SET active_version_id = NULL, archived_at = now() WHERE id = $1', [datasetId]);
    const revision = await bumpRevision(tx, ds.rows[0].account_id);
    await audit(tx, actor, 'dataset.deactivate', { type: 'dataset', id: datasetId }, 'success', { revision });
    await publishEvent(tx, { workspaceId: actor.workspaceId, accountId: ds.rows[0].account_id, type: 'dataset.activated', resourceId: datasetId, revision, payload: { deactivated: true } });
    return { revision };
  });
}

export async function listCampaigns(db: Db, t: { workspaceId: string }, datasetId: string) {
  return db.withTenant(t, async (tx) => {
    const d = await tx.query<{ active_version_id: string | null }>('SELECT active_version_id FROM datasets WHERE id = $1', [datasetId]);
    if (!d.rows[0]) throw notFound('Dataset');
    if (!d.rows[0].active_version_id) return [];
    const { rows } = await tx.query(
      `SELECT c.id AS "campaignId", c.external_id AS "externalId",
              (ARRAY_AGG(f.campaign_name ORDER BY f.launch_date DESC))[1] AS name,
              (ARRAY_AGG(f.channel ORDER BY f.launch_date DESC))[1] AS channel,
              (ARRAY_AGG(f.program ORDER BY f.launch_date DESC))[1] AS program,
              MIN(f.launch_date) AS "firstLaunchDate", MAX(f.launch_date) AS "lastLaunchDate",
              COUNT(DISTINCT (COALESCE(f.launch_external_id, ''), f.launch_date))::int AS "launchCount"
         FROM campaign_launch_facts f JOIN campaigns c ON c.id = f.campaign_id
        WHERE f.dataset_version_id = $1
        GROUP BY c.id, c.external_id ORDER BY MAX(f.launch_date) DESC, name LIMIT 5000`,
      [d.rows[0].active_version_id]
    );
    return rows;
  });
}
