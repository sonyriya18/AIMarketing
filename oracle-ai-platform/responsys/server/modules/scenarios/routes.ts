import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { AppError, notFound } from '../../http/errors';
import { ah, parse, uuidParam } from '../../http/util';
import { runScenario, ScenarioInputsSchema, SCENARIO_ALGORITHM, type ScenarioOutput } from '../../../shared/scenario/engine';
import { stableStringify } from '../reports/snapshots';
import { csvCell } from '../reports/export';
import { audit } from '../audit/audit';

const COLUMNS = `s.id, s.account_id AS "accountId", s.baseline_report_id AS "baselineReportId", s.name, s.algorithm_version AS "algorithmVersion",
  s.inputs, s.input_hash AS "inputHash", s.output, s.created_at AS "createdAt", u.email AS "createdByEmail"`;

export function scenarioRoutes(deps: { db: Db }): Router {
  const { db } = deps;
  const r = Router();

  r.post(
    '/scenarios',
    requirePermission('scenario.create'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const b = parse(
        z.object({ accountId: z.string().uuid(), name: z.string().trim().min(1).max(160), baselineReportId: z.string().uuid().nullable().default(null), inputs: z.unknown() }),
        req.body
      );
      const parsed = ScenarioInputsSchema.safeParse(b.inputs);
      if (!parsed.success) throw new AppError('unprocessable', 'Some assumptions are invalid', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      const output = runScenario(parsed.data);
      const inputHash = createHash('sha256').update(stableStringify({ algorithm: SCENARIO_ALGORITHM, inputs: parsed.data })).digest('hex');
      const row = await db.withTenant(t, async (tx) => {
        const a = await tx.query<{ currency: string }>('SELECT currency FROM accounts WHERE id = $1', [b.accountId]);
        if (!a.rows[0]) throw notFound('Account');
        if (b.baselineReportId) {
          const rep = await tx.query('SELECT 1 FROM report_snapshots WHERE id = $1 AND account_id = $2', [b.baselineReportId, b.accountId]);
          if (!rep.rowCount) throw notFound('Baseline report');
        }
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO scenario_runs (workspace_id, account_id, baseline_report_id, name, algorithm_version, inputs, input_hash, output, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [t.workspaceId, b.accountId, b.baselineReportId, b.name, SCENARIO_ALGORITHM, JSON.stringify(parsed.data), inputHash, JSON.stringify(output), t.userId]
        );
        await audit(tx, { ...t, requestId: req.requestId }, 'scenario.create', { type: 'scenario', id: rows[0]!.id }, 'success', { inputHash });
        return (await tx.query(`SELECT ${COLUMNS} FROM scenario_runs s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`, [rows[0]!.id])).rows[0];
      });
      res.status(201).json({ data: row });
    })
  );

  r.get(
    '/accounts/:accountId/scenarios',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const accountId = uuidParam(req, 'accountId', 'Account');
      const { rows } = await db.withTenant(t, (tx) => tx.query(`SELECT ${COLUMNS} FROM scenario_runs s LEFT JOIN users u ON u.id = s.created_by WHERE s.account_id = $1 ORDER BY s.created_at DESC LIMIT 100`, [accountId]));
      res.json({ data: rows });
    })
  );

  r.get(
    '/scenarios/:scenarioId',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const id = uuidParam(req, 'scenarioId', 'Scenario');
      const { rows } = await db.withTenant(tenantOf(req), (tx) => tx.query(`SELECT ${COLUMNS} FROM scenario_runs s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`, [id]));
      if (!rows[0]) throw notFound('Scenario');
      res.json({ data: rows[0] });
    })
  );

  r.get(
    '/scenarios/:scenarioId/export',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const id = uuidParam(req, 'scenarioId', 'Scenario');
      const { rows } = await db.withTenant(tenantOf(req), (tx) => tx.query<{ name: string; output: ScenarioOutput; created_at: Date; baseline_report_id: string | null }>('SELECT name, output, created_at, baseline_report_id FROM scenario_runs WHERE id = $1', [id]));
      const s = rows[0];
      if (!s) throw notFound('Scenario');
      const o = s.output;
      const lines = [
        ['SCENARIO — assumption-based projection, not measured results'],
        ['Scenario', s.name],
        ['Scenario ID', id],
        ['Algorithm', o.algorithmVersion],
        ['Baseline report', s.baseline_report_id ?? 'none'],
        ['Created', s.created_at.toISOString()],
        ['Currency', o.currency],
        [],
        ['assumption', 'low', 'base', 'high', 'source', 'note'],
        ...o.assumptions.map((a) => [a.input, a.low, a.base, a.high, a.source, a.note ?? '']),
        [],
        ['output', 'low', 'base', 'high'],
        ...(['expectedDelivered', 'expectedConverters', 'expectedOrders', 'expectedRevenue', 'contribution', 'incrementalRevenue'] as const).map((k) => [k, o.cases.low[k] ?? 'Unavailable', o.cases.base[k] ?? 'Unavailable', o.cases.high[k] ?? 'Unavailable']),
        [],
        ['notes'],
        ...o.notes.map((n) => [n]),
      ];
      res.setHeader('Content-Disposition', `attachment; filename="scenario-${id.slice(0, 8)}.csv"`);
      res.type('text/csv; charset=utf-8').send('﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n');
    })
  );

  return r;
}
