/**
 * AI summaries on every page. The text is written by Gemini when it is configured and checked on
 * the server against facts built from the same report snapshot; otherwise it is written by rules
 * from those facts. Every point can show the facts it is based on. Numbers on the page itself
 * never come from here.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, Lightbulb, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import { useAskAi } from '../app/askAi';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAiStatus, usePageSummary, type AiStatus, type PageSummary, type SummarySection } from '../lib/queries';

const STATUS: Record<PageSummary['aiStatus'], string> = {
  completed: 'AI summary · checked against the report numbers',
  partial: 'AI summary · some sections written by rules',
  disabled: 'Rule-based summary (AI not configured)',
  not_permitted: 'Rule-based summary (your role does not include AI)',
  failed: 'Rule-based summary (AI unavailable — reason below)',
  rate_limited: 'Rule-based summary (daily AI budget reached)',
  rejected: 'Rule-based summary (AI output failed the number checks)',
};

const KIND_DOT: Record<string, string> = {
  observation: 'bg-[#C74634]',
  recommendation: 'bg-emerald-600',
  limitation: 'bg-amber-500',
};

const Points: React.FC<{ section: SummarySection; summary: PageSummary; dense?: boolean }> = ({ section, summary, dense }) => {
  const [open, setOpen] = useState(false);
  const facts = summary.facts.filter((f) => section.points.some((p) => p.factIds.includes(f.id)));
  if (section.unavailable) return <p className="text-[11px] text-[#8a7668] italic">{section.unavailable}</p>;
  return (
    <div className="space-y-1.5">
      <ul className={`space-y-1 ${dense ? 'text-[11px]' : 'text-xs'} text-[#4d4039] leading-relaxed`}>
        {section.points.map((p, i) => (
          <li key={i} className="flex gap-2">
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${KIND_DOT[p.kind] ?? KIND_DOT.observation}`} />
            <span>{p.kind === 'recommendation' && <strong className="text-emerald-800">Action: </strong>}{p.text}</span>
          </li>
        ))}
      </ul>
      {facts.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#C74634] hover:underline" aria-expanded={open}>
            Based on {facts.length} evidence source{facts.length === 1 ? '' : 's'} <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 rounded-lg bg-white border border-[#efe3d6] p-2 text-[10px] font-mono text-[#6b554d]">
              {facts.map((f) => <li key={f.id}>{f.text}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

/** Opens Ask AI with a question about this section, answered right away. */
const AskAiButton: React.FC<{ question: string; scope: 'account' | 'campaign'; small?: boolean }> = ({ question, scope, small }) => {
  const ask = useAskAi();
  if (!ask) return null;
  return (
    <button
      type="button"
      onClick={() => ask(question, scope)}
      title={question}
      className={`inline-flex items-center gap-1 rounded-md border border-violet-300 bg-white font-semibold text-violet-800 hover:bg-violet-100 ${small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'}`}
    >
      <MessageSquare className={small ? 'w-3 h-3' : 'w-3.5 h-3.5'} /> Ask AI
    </button>
  );
};

const scopeOf = (summary: PageSummary | undefined): 'account' | 'campaign' => ((summary as { reportKind?: string } | undefined)?.reportKind === 'campaign' ? 'campaign' : 'account');

const SourceTag: React.FC<{ section: SummarySection }> = ({ section }) => (
  <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${section.generator === 'ai' ? 'bg-violet-50 text-violet-800 border-violet-200' : 'bg-white text-[#6b554d] border-[#e8dcc9]'}`}>
    {section.generator === 'ai' ? 'AI' : 'Rule-based'}
  </span>
);

/** Large card at the top of a page: the executive section, or several sections side by side. */
export const AiSummaryCard: React.FC<{ reportId: string; focus?: 'page' | 'simulator'; sections?: string[]; id?: string }> = ({ reportId, focus = 'page', sections = ['executive'], id }) => {
  const q = usePageSummary(reportId, focus);
  const qc = useQueryClient();
  // A summary request is a real AI call; refresh the footer's AI status from it.
  useEffect(() => {
    if (q.dataUpdatedAt) void qc.invalidateQueries({ queryKey: ['ai-status'] });
  }, [q.dataUpdatedAt, qc]);
  const list = q.data ? sections.map((k) => q.data!.sections.find((s) => s.key === k)).filter((s): s is SummarySection => Boolean(s)) : [];
  return (
    <section id={id} className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-[#fffaf5] to-[#fffaf5] p-5 shadow-sm" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="flex items-center gap-2 text-base font-bold text-[#2d241d]">
          <Sparkles className="w-4 h-4 text-violet-600" /> {list[0]?.title ?? (focus === 'simulator' ? 'AI Strategy Brief' : 'AI Summary')}
        </h3>
        <div className="flex items-center gap-2">
          {q.data && <span className="text-[10px] text-[#6b554d]">{STATUS[q.data.aiStatus]}{q.data.model ? ` · ${q.data.model}` : ''}</span>}
          {list[0] && <AskAiButton scope={scopeOf(q.data)} question={`${list[0].title}: explain what stands out for this period and what I should do next.`} />}
        </div>
      </div>
      {q.data?.businessContext && <div className="mb-3 rounded-lg border border-violet-100 bg-white/70 p-3 text-xs text-[#6b554d]">
        <p><strong>{q.data.businessContext.status === 'ready' ? 'Business context retrieved' : 'Business context'}:</strong> {q.data.businessContext.message}</p>
        {q.data.businessContext.sources.length > 0 && <p className="mt-1">Website sources · checked {new Date(q.data.businessContext.checkedAt).toLocaleString()}: {q.data.businessContext.sources.map((s, i) => <a key={s.url} className="underline ml-2 text-violet-800" href={s.url} target="_blank" rel="noreferrer">Page {i + 1}</a>)}</p>}
      </div>}
      {q.data?.aiError && (
        <div className="mb-3 flex flex-wrap items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0"><strong>Why the AI was not used:</strong> {q.data.aiError}</span>
          <button type="button" onClick={() => q.refetch()} disabled={q.isFetching} className="shrink-0 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-semibold hover:bg-amber-100 disabled:opacity-50">
            {q.isFetching ? 'Asking the AI…' : 'Try AI again'}
          </button>
        </div>
      )}
      {q.isLoading && (
        <div className="flex items-center gap-2 text-xs text-violet-800"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Writing the summary from this report…</div>
      )}
      {q.error ? (
        <div className="flex items-center gap-2 text-xs text-rose-800"><AlertTriangle className="w-3.5 h-3.5" /> The summary could not be loaded. The figures below are unaffected.
          <button type="button" className="font-semibold underline" onClick={() => q.refetch()}>Try again</button>
        </div>
      ) : null}
      {list.length > 0 && (
        <div className={`grid gap-4 ${list.length > 1 ? 'md:grid-cols-2' : ''}`}>
          {list.map((s, i) => (
            <div key={s.key} className={list.length > 1 ? 'rounded-xl bg-white/70 border border-[#efe3d6] p-3' : ''}>
              <div className="flex items-center gap-2 mb-1.5">
                {list.length > 1 && i > 0 && <span className="text-[11px] font-bold uppercase tracking-wider text-[#8d563b]">{s.title}</span>}
                <span className="text-sm font-semibold text-[#2d241d]">{s.headline}</span>
                <SourceTag section={s} />
              </div>
              <Points section={s} summary={q.data!} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

/** Compact AI insight shown under a section heading. */
export const AiInsight: React.FC<{ reportId: string; section: string; focus?: 'page' | 'simulator' }> = ({ reportId, section, focus = 'page' }) => {
  const q = usePageSummary(reportId, focus);
  const s = q.data?.sections.find((x) => x.key === section);
  if (q.error) return null;
  return (
    <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2.5" data-ai-insight={section}>
      <div className="flex items-center gap-2 mb-1">
        <Lightbulb className="w-3.5 h-3.5 text-violet-700" />
        <span className="text-[11px] font-bold text-violet-900">AI insight{s ? `: ${s.headline}` : ''}</span>
        {s && <SourceTag section={s} />}
        {s && <span className="ml-auto"><AskAiButton small scope={scopeOf(q.data)} question={`Tell me more about "${s.title}" for this period: what stands out, and what should I do next?`} /></span>}
      </div>
      {q.isLoading || !s ? (
        <div className="flex items-center gap-2 text-[11px] text-violet-800"><Loader2 className="w-3 h-3 animate-spin" /> Summarising…</div>
      ) : (
        <Points section={s} summary={q.data!} dense />
      )}
    </div>
  );
};

/** Footer badge: the result of a real AI call, with the reason when it fails. */
export const AiStatusBadge: React.FC<{ configured: boolean }> = ({ configured }) => {
  const q = useAiStatus(configured);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!configured) return <span title="AI_PROVIDER is not set on the server">AI: not configured</span>;
  const s = q.data;
  const recheck = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['ai-status'], await apiGet<AiStatus>('/ai/status?refresh=1'));
    } catch {
      /* the badge keeps its last state */
    } finally {
      setBusy(false);
    }
  };
  const when = s?.checkedAt ? new Date(s.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const label = q.isLoading || busy ? 'AI: checking…' : !s?.checkedAt ? 'AI: not used yet' : s.ok ? `AI: working (${when})` : 'AI: last call failed';
  return (
    <span className="relative">
      <button type="button" id="ai-status" onClick={() => setOpen((v) => !v)} className={`font-semibold ${s?.ok ? 'text-emerald-700' : q.isLoading || busy || !s?.checkedAt ? 'text-gray-600 underline' : 'text-rose-700 underline'}`} title="Result of the latest real call to the AI model">
        {label}
      </button>
      {open && (
        <div className="absolute bottom-6 right-0 z-30 w-80 rounded-xl border border-gray-200 bg-white p-3 text-[11px] text-gray-700 shadow-lg" role="dialog" aria-label="AI status">
          <div className="font-bold text-gray-900">AI model: {s?.model ?? 'unknown'}</div>
          {s?.ok ? (
            <p className="mt-1">The latest AI call succeeded at {when}{s.latencyMs ? ` (${(s.latencyMs / 1000).toFixed(1)} s)` : ''}.</p>
          ) : !s?.checkedAt ? (
            <p className="mt-1">No AI call has been made yet. “Check again” sends one small test request.</p>
          ) : (
            <p className="mt-1 text-rose-800">{s.error ?? (q.error ? (q.error as Error).message : 'Unknown error.')}</p>
          )}
          <p className="mt-1 text-gray-500">Free Gemini keys allow only a few requests per minute; each page summary uses one.</p>
          <button type="button" onClick={recheck} disabled={busy} className="mt-2 rounded-lg border border-gray-300 px-2 py-1 font-semibold hover:bg-gray-50 disabled:opacity-50">{busy ? 'Checking…' : 'Check again'}</button>
        </div>
      )}
    </span>
  );
};
