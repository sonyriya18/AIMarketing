import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/pool';
import type { ObjectStorage } from '../../integrations/storage/storage';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { AppError } from '../../http/errors';
import { ah, parse, uuidParam } from '../../http/util';
import { DELIMITERS, ENCODINGS } from './parse/text';
import { cancelImport, commitImport, createImport, getImport, listImports, reinspectImport, validateImport } from './service';

export function importRoutes(deps: { cfg: AppConfig; db: Db; storage: ObjectStorage }): Router {
  const { cfg, db, storage } = deps;
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.UPLOAD_MAX_BYTES, files: 1, fields: 5, parts: 8 } });
  const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  const actor = (req: Parameters<typeof tenantOf>[0]) => ({ ...tenantOf(req), requestId: req.requestId });

  r.get(
    '/accounts/:accountId/imports',
    requirePermission('report.view'),
    ah(async (req, res) => {
      res.json({ data: await listImports(db, tenantOf(req), uuidParam(req, 'accountId', 'Account')) });
    })
  );

  r.post(
    '/accounts/:accountId/imports',
    requirePermission('data.import'),
    uploadLimiter,
    upload.single('file'),
    ah(async (req, res) => {
      if (!req.file) throw new AppError('invalid_request', 'Attach a file in the "file" field');
      const row = await createImport({ db, storage }, actor(req), uuidParam(req, 'accountId', 'Account'), req.file);
      res.status(201).json({ data: row });
    })
  );

  r.get(
    '/imports/:importId',
    requirePermission('report.view'),
    ah(async (req, res) => {
      res.json({ data: await getImport(db, tenantOf(req), uuidParam(req, 'importId', 'Import')) });
    })
  );

  r.post(
    '/imports/:importId/reinspect',
    requirePermission('data.import'),
    ah(async (req, res) => {
      const body = parse(z.object({ encoding: z.enum(ENCODINGS).optional(), delimiter: z.enum(DELIMITERS).optional() }), req.body);
      res.json({ data: await reinspectImport({ db, storage }, actor(req), uuidParam(req, 'importId', 'Import'), body) });
    })
  );

  r.post(
    '/imports/:importId/validate',
    requirePermission('data.import'),
    ah(async (req, res) => {
      const result = await validateImport({ db, storage }, actor(req), uuidParam(req, 'importId', 'Import'), req.body?.mapping);
      res.json({ data: result });
    })
  );

  r.post(
    '/imports/:importId/commit',
    requirePermission('data.import'),
    ah(async (req, res) => {
      const id = uuidParam(req, 'importId', 'Import');
      const out = await commitImport(db, actor(req), id);
      res.status(202).json({ data: { ...out, statusUrl: `/api/v1/imports/${id}` } });
    })
  );

  r.post(
    '/imports/:importId/cancel',
    requirePermission('data.import'),
    ah(async (req, res) => {
      await cancelImport(db, actor(req), uuidParam(req, 'importId', 'Import'));
      res.json({ data: { ok: true } });
    })
  );

  return r;
}
