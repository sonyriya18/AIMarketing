import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { ah, parse, uuidParam } from '../../http/util';
import { deactivateDataset, listCampaigns, listDatasets, listVersions, rollbackDataset } from './service';

export function datasetRoutes(deps: { db: Db }): Router {
  const { db } = deps;
  const r = Router();

  r.get(
    '/accounts/:accountId/datasets',
    requirePermission('report.view'),
    ah(async (req, res) => {
      res.json({ data: await listDatasets(db, tenantOf(req), uuidParam(req, 'accountId', 'Account')) });
    })
  );

  r.get(
    '/datasets/:datasetId/versions',
    requirePermission('report.view'),
    ah(async (req, res) => {
      res.json({ data: await listVersions(db, tenantOf(req), uuidParam(req, 'datasetId', 'Dataset')) });
    })
  );

  r.get(
    '/datasets/:datasetId/campaigns',
    requirePermission('report.view'),
    ah(async (req, res) => {
      res.json({ data: await listCampaigns(db, tenantOf(req), uuidParam(req, 'datasetId', 'Dataset')) });
    })
  );

  r.post(
    '/datasets/:datasetId/rollback',
    requirePermission('data.import'),
    ah(async (req, res) => {
      const { versionId } = parse(z.object({ versionId: z.string().uuid() }), req.body);
      res.json({ data: await rollbackDataset(db, { ...tenantOf(req), requestId: req.requestId }, uuidParam(req, 'datasetId', 'Dataset'), versionId) });
    })
  );

  r.post(
    '/datasets/:datasetId/deactivate',
    requirePermission('data.import'),
    ah(async (req, res) => {
      res.json({ data: await deactivateDataset(db, { ...tenantOf(req), requestId: req.requestId }, uuidParam(req, 'datasetId', 'Dataset')) });
    })
  );

  return r;
}
