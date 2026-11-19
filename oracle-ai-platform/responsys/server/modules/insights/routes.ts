/**
 * POST /reports/:reportId/summary — the AI summary for a page, built from the report snapshot the
 * user is viewing. AI-written results are cached per snapshot (snapshots are immutable), so a page
 * spends AI budget once. Rule-based summaries are recomputed and never cached.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { AppError } from '../../http/errors';
import { ah, parse, uuidParam } from '../../http/util';
import { noneProvider, type AiProvider } from '../../integrations/ai/provider';
import { getReport, sha256, stableStringify } from '../reports/snapshots';
import { overBudget, recordRun } from '../chat/routes';
import { logger } from '../../observability/logger';
import type { Clock } from '../../../shared/time/clock';
import { researchWebsite } from './business';
import { businessPlaybooks } from './business-strategies';
import { businessWebsite } from '../../../shared/business/accounts';
import {
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SYSTEM_PROMPT,
  buildFacts,
  buildSummaryPrompt,
  chunkSections,
  ruleBasedSection,
  scopeTexts,
  sectionsFor,
  summaryJsonSchema,
  validateStrategyPick,
  validateBusinessStrategies,
  validateSummary,
  type PageSummary,
  type StrategyPick,
  type SummaryAiStatus,
  type SummarySection,
} from './summary';

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function insightRoutes(deps: { cfg: AppConfig; db: Db; ai?: AiProvider; clock: Clock }): Router {
  const { cfg, db, clock } = deps;
  const ai = deps.ai ?? noneProvider;
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  r.post(
    '/reports/:reportId/summary',
    requirePermission('report.view'),
    limiter,
    ah(async (req, res) => {
      const t = tenantOf(req);
      const reportId = uuidParam(req, 'reportId', 'Report');
      const { focus } = parse(z.object({ focus: z.enum(['page', 'simulator']).default('page') }), req.body ?? {});
      const snap = await getReport(db, t, reportId);
      if (focus === 'simulator' && snap.meta.kind !== 'overview') throw new AppError('unprocessable', 'The simulator summary needs an account summary report');

      const account = await db.withTenant(t, (tx) => tx.query<{ name: string; brand: { officialWebsite?: string } }>('SELECT name, brand FROM accounts WHERE id = $1', [snap.meta.accountId]));
      const businessContext = await researchWebsite(account.rows[0] ? businessWebsite(account.rows[0]) : undefined);
      // Website content can change while the report snapshot remains immutable.
      const promptVersion = `${SUMMARY_PROMPT_VERSION}:offers1:${sha256(stableStringify({ website: businessContext.website, status: businessContext.status, sources: businessContext.sources, offers: businessContext.offers?.map(({ checkedAt: _checkedAt, ...offer }) => offer) })).slice(0, 16)}`;

      const cached = await db.withTenant(t, (tx) =>
        tx.query<{ result: PageSummary }>('SELECT result FROM report_ai_summaries WHERE report_id = $1 AND focus = $2 AND prompt_version = $3', [reportId, focus, promptVersion])
      );
      const canUseAi = ai.enabled && req.auth!.permissions.has('ai.use');
      if (cached.rows[0] && canUseAi && !(focus === 'simulator' && businessContext.status === 'ready' && !cached.rows[0].result.businessStrategies?.length)) return void res.json({ data: { ...cached.rows[0].result, businessContext, cached: true } });

      const snapshot = snap as unknown as Parameters<typeof buildFacts>[0];
      const facts = [...buildFacts(snapshot), ...businessContext.sources.map((source, i) => ({ id: `business:${i}`, section: 'business', text: `Official website for ${account.rows[0]?.name}: ${source.url}\n${source.text}` }))];
      const specs = sectionsFor(snap.meta.kind, focus).map((s) => s.mode === 'advise' ? { ...s, uses: [...s.uses, 'business'] } : s);
      const rule = new Map(specs.map((s) => [s.key, ruleBasedSection(s, facts)]));
      const base = { reportId, reportKind: snap.meta.kind, focus, promptVersion, facts, businessContext, generatedAt: clock.now().toISOString() };
      const websitePlans = focus === 'simulator' ? businessPlaybooks(facts) : [];

      const finish = (sections: SummarySection[], aiStatus: SummaryAiStatus, model: string | null, rejectedPoints: number, aiError: string | null = null, strategyPick: StrategyPick | null = null): PageSummary => ({ ...base, sections, aiStatus, model, rejectedPoints, aiError, strategyPick, businessStrategies: websitePlans });
      const allRule = () => specs.map((s) => rule.get(s.key)!);

      if (!canUseAi) return void res.json({ data: finish(allRule(), ai.enabled ? 'not_permitted' : 'disabled', null, 0) });
      if (await overBudget(db, t.workspaceId, cfg.AI_DAILY_RUN_LIMIT_PER_WORKSPACE)) return void res.json({ data: finish(allRule(), 'rate_limited', null, 0) });

      // Sections with no facts have nothing for the model to say; they keep their rule-based note.
      const askable = specs.filter((s) => facts.some((f) => s.uses.includes(f.section)));
      const evidenceHash = sha256(stableStringify(facts));
      const results = await Promise.all(
        chunkSections(askable, 12).map(async (chunk, i) => {
          const used = facts.filter((f) => f.section === 'business' || chunk.some((s) => s.uses.includes(f.section)));
          // The simulator's first call also asks for a strategy pick (same call: free tiers allow few requests).
          const withStrategy = focus === 'simulator' && i === 0;
          const started = Date.now();
          try {
            const out = await ai.generateJson({ system: SUMMARY_SYSTEM_PROMPT, prompt: buildSummaryPrompt(snapshot, chunk, used, withStrategy), jsonSchema: summaryJsonSchema(chunk.map((s) => s.key), withStrategy, used.some((f) => f.section === 'business'), used.map((f) => f.id)), enforceSchema: withStrategy && used.some((f) => f.section === 'business') });
            const raw = parseJson(out.text);
            const v = { ...validateSummary(raw, chunk, used, scopeTexts(snapshot)), pick: withStrategy ? validateStrategyPick(raw, used, scopeTexts(snapshot)) : null, businessStrategies: withStrategy ? validateBusinessStrategies(raw, used, scopeTexts(snapshot)) : [] };
            const status = [...v.sections.values()].some((s) => s.points.length) ? 'completed' : 'rejected';
            await db.withTenant(t, (tx) => recordRun(tx, t.workspaceId, { accountId: snap.meta.accountId, purpose: 'report_explanation', provider: ai.name, model: out.model, status, promptVersion: SUMMARY_PROMPT_VERSION, evidenceHash, inTok: out.inputTokens, outTok: out.outputTokens, ms: Date.now() - started, userId: t.userId }));
            return { ok: true as const, model: out.model, v };
          } catch (e) {
            const msg = (e as Error).message;
            logger.warn('ai summary failed', { error: msg });
            await db.withTenant(t, (tx) => recordRun(tx, t.workspaceId, { accountId: snap.meta.accountId, purpose: 'report_explanation', provider: ai.name, model: ai.model, status: 'failed', promptVersion: SUMMARY_PROMPT_VERSION, evidenceHash, ms: Date.now() - started, error: msg, userId: t.userId }));
            return { ok: false as const, error: msg };
          }
        })
      );

      let rejected = 0;
      let model: string | null = null;
      let pick: StrategyPick | null = null;
      let businessStrategies: PageSummary['businessStrategies'] = [];
      const fromAi = new Map<string, { headline: string; points: SummarySection['points'] }>();
      for (const x of results) {
        if (!x.ok) continue;
        model = x.model;
        rejected += x.v.rejected;
        pick ??= x.v.pick;
        businessStrategies.push(...x.v.businessStrategies);
        for (const [k, s] of x.v.sections) if (s.points.length) fromAi.set(k, s);
      }
      const sections = specs.map((s): SummarySection => {
        const a = fromAi.get(s.key);
        return a ? { key: s.key, title: s.title, headline: a.headline, points: a.points, generator: 'ai', unavailable: null } : rule.get(s.key)!;
      });
      const anyOk = results.some((x) => x.ok);
      const aiCount = sections.filter((s) => s.generator === 'ai').length;
      const status: SummaryAiStatus = !anyOk ? 'failed' : aiCount === 0 ? 'rejected' : aiCount === askable.length && results.every((x) => x.ok) ? 'completed' : 'partial';
      const firstError = results.find((x) => !x.ok) as { error?: string } | undefined;
      const summary = finish(sections, status, model, rejected, firstError?.error ?? (status === 'rejected' ? 'The AI answer did not pass the number checks.' : null), pick);
      summary.businessStrategies = businessStrategies.length ? businessStrategies.map((s) => ({ ...s, generator: 'ai' })) : websitePlans;
      if (status === 'completed' && !(focus === 'simulator' && businessContext.status === 'ready' && !businessStrategies.length)) {
        await db.withTenant(t, (tx) =>
          tx.query('INSERT INTO report_ai_summaries (workspace_id, report_id, focus, prompt_version, result, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [t.workspaceId, reportId, focus, promptVersion, JSON.stringify(summary), t.userId])
        );
      }
      res.json({ data: summary });
    })
  );

  /**
   * Live AI check: one tiny request to the configured model. Shown in the footer so "AI
   * connected" is only claimed after a real answer. Results are kept briefly per instance.
   */
  let lastCheck: { at: number; ok: boolean; error: string | null; latencyMs: number | null; checkedAt: string } | null = null;
  const statusLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
  r.get(
    '/ai/status',
    requirePermission('report.view'),
    statusLimiter,
    ah(async (req, res) => {
      const t = tenantOf(req);
      if (!ai.enabled) return void res.json({ data: { provider: 'none', model: null, ok: false, error: null, latencyMs: null, checkedAt: null } });
      const force = req.query.refresh === '1';
      if (!force) {
        // Without an explicit check, report the workspace's most recent real AI call: no request is
        // spent (free API tiers allow only a few a minute) and nothing is claimed without evidence.
        const { rows } = await db.withTenant(t, (tx) =>
          tx.query<{ status: string; error: string | null; latency_ms: number | null; created_at: Date; model: string | null }>(
            `SELECT status, error, latency_ms, created_at, model FROM ai_runs WHERE provider = $1 AND status IN ('completed', 'failed', 'rejected') ORDER BY created_at DESC LIMIT 1`,
            [ai.name]
          )
        );
        const last = rows[0];
        return void res.json({
          data: last
            ? { provider: ai.name, model: ai.model, ok: last.status !== 'failed', error: last.status === 'failed' ? last.error : null, latencyMs: last.latency_ms, checkedAt: new Date(last.created_at).toISOString(), source: 'last_call' }
            : { provider: ai.name, model: ai.model, ok: false, error: null, latencyMs: null, checkedAt: null, source: 'none' },
        });
      }
      {
        const started = Date.now();
        try {
          const out = await ai.generateJson({ system: 'Reply with the JSON object {"ok": true}.', prompt: 'Connection check.', jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });
          const ok = (parseJson(out.text) as { ok?: unknown } | null)?.ok === true;
          lastCheck = { at: Date.now(), ok, error: ok ? null : 'The model answered, but not in the expected format.', latencyMs: Date.now() - started, checkedAt: clock.now().toISOString() };
        } catch (e) {
          lastCheck = { at: Date.now(), ok: false, error: (e as Error).message.slice(0, 500), latencyMs: Date.now() - started, checkedAt: clock.now().toISOString() };
          logger.warn('ai status check failed', { error: lastCheck.error });
        }
        await db.withTenant(t, (tx) => recordRun(tx, t.workspaceId, { accountId: null, purpose: 'report_explanation', provider: ai.name, model: ai.model, status: lastCheck!.ok ? 'completed' : 'failed', promptVersion: 'ai-status-check-1', ms: lastCheck!.latencyMs ?? 0, error: lastCheck!.error, userId: t.userId }));
      }
      const { at: _at, ...check } = lastCheck!;
      res.json({ data: { provider: ai.name, model: ai.model, ...check, source: 'live_check' } });
    })
  );

  return r;
}
