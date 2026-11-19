import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Db } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { AppError } from '../../http/errors';
import { ah, parse, uuidParam } from '../../http/util';
import { CampaignReportRequestSchema, ComparisonRequestSchema, OverviewRequestSchema } from '../../../shared/contracts/reports';
import { PeriodError } from '../../../shared/time/periods';
import type { Clock } from '../../../shared/time/clock';
import { audit } from '../audit/audit';
import { createReport, getReport } from './snapshots';
import { toCsv, toMarkdown } from './export';

export function reportRoutes(deps: { db: Db; clock: Clock; dataMode?: string }): Router {
  const { db, clock } = deps;
  const dataMode = deps.dataMode ?? process.env.APP_DATA_MODE ?? 'development';
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

  const run = (kind: 'overview' | 'campaign' | 'comparison', schema: typeof OverviewRequestSchema | typeof CampaignReportRequestSchema | typeof ComparisonRequestSchema) =>
    ah(async (req, res) => {
      const body = parse(schema, req.body);
      try {
        res.json({ data: await createReport(db, tenantOf(req), kind, body, clock, dataMode) });
      } catch (e) {
        if (e instanceof PeriodError) throw new AppError('unprocessable', e.message);
        throw e;
      }
    });

  r.post('/reports/overview', requirePermission('report.view'), limiter, run('overview', OverviewRequestSchema));
  r.post('/reports/campaign', requirePermission('report.view'), limiter, run('campaign', CampaignReportRequestSchema));
  r.post('/reports/comparison', requirePermission('report.view'), limiter, run('comparison', ComparisonRequestSchema));

  r.get(
    '/reports/:reportId',
    requirePermission('report.view'),
    ah(async (req, res) => {
      res.json({ data: await getReport(db, tenantOf(req), uuidParam(req, 'reportId', 'Report')) });
    })
  );

  r.get(
    '/reports/:reportId/export',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const id = uuidParam(req, 'reportId', 'Report');
      const format = String(req.query.format || 'csv');
      if (!['csv', 'json', 'md'].includes(format)) throw new AppError('invalid_request', 'format must be csv, json, or md');
      const snap = await getReport(db, t, id);
      await db.withTenant(t, (tx) => audit(tx, { ...t, requestId: req.requestId }, 'report.export', { type: 'report', id }, 'success', { format }));
      const base = `report-${snap.kind}-${id.slice(0, 8)}`;
      res.setHeader('Cache-Control', 'private, no-store');
      if (format === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
        return res.type('application/json').send(JSON.stringify(snap, null, 2));
      }
      if (format === 'md') {
        res.setHeader('Content-Disposition', `attachment; filename="${base}.md"`);
        return res.type('text/markdown; charset=utf-8').send(toMarkdown(snap));
      }
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      return res.type('text/csv; charset=utf-8').send(toCsv(snap));
    })
  );

  return r;
}
