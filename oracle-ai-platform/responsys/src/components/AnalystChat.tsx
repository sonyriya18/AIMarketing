/**
 * Ask AI ("Ask the AI Campaign Analyst"). It answers about the whole dashboard (every section and
 * every campaign in the selected period) or about one campaign. The server builds the evidence and
 * dashboard facts from the report snapshot the screen shows; when the data or period changes, the
 * conversation continues on the new snapshot. Answers are labelled AI or rule-based, and every
 * statement links to the evidence or facts it is based on.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, Loader2, MessageSquare, RefreshCw, Send, User } from 'lucide-react';
import { ErrorBox, EvidenceListModal } from './ui';
import { apiSend } from '../lib/api';
import type { CampaignReportResult, EvidenceItem, OverviewResult, Session } from '../lib/types';
import type { SimulatorScenario } from '../app/askAi';

interface Answer {
  statements: { kind: string; text: string; evidenceIds: string[]; strength: string }[];
  missingInformation: string[];
  aiStatus: string;
  generator: 'ai' | 'rule_based';
  model: string | null;
  rejectedStatements: number;
  aiError?: string | null;
}
interface Fact {
  id: string;
  section: string;
  text: string;
}
interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer?: Answer | null;
  at?: string;
  notice?: boolean;
  facts?: Fact[];
}

const STATUS_TEXT: Record<string, string> = {
  completed: 'AI answer, checked against the report',
  disabled: 'Rule-based answer (AI not configured)',
  not_permitted: 'Rule-based answer (your role does not include AI — sign in as the owner, or ask the owner to change your role)',
  failed: 'Rule-based answer (AI unavailable)',
  rate_limited: 'Rule-based answer (AI budget reached)',
  rejected: 'Rule-based answer (AI output failed evidence checks)',
};

const KIND_CLS: Record<string, string> = {
  observation: 'bg-white text-[#6b554d] border-[#e8dcc9]',
  hypothesis: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  recommendation: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  limitation: 'bg-amber-50 text-amber-800 border-amber-200',
};

const time = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const scopeLabel = (r: CampaignReportResult | OverviewResult) =>
  r.meta.kind === 'campaign' ? (r as CampaignReportResult).campaign.name : `the whole dashboard (${(r as OverviewResult).counts?.campaigns ?? 0} campaigns)`;

const FactList: React.FC<{ facts: Fact[] }> = ({ facts }) => {
  const [open, setOpen] = useState(false);
  if (!facts.length) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#C74634] hover:underline" aria-expanded={open}>
        Based on {facts.length} dashboard fact{facts.length === 1 ? '' : 's'} <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 rounded-lg bg-white border border-[#efe3d6] p-2 text-[10px] font-mono text-[#6b554d]">
          {facts.map((f) => <li key={f.id}>{f.text}</li>)}
        </ul>
      )}
    </div>
  );
};

export const AnalystChat: React.FC<{
  report: CampaignReportResult | OverviewResult;
  session: Session;
  /** A question sent from another screen ("Ask AI about this"); sent once, then cleared. */
  pending?: { id: number; question: string } | null;
  onPendingHandled?: () => void;
  onScopeChange?: (scope: 'account' | 'campaign') => void;
  canPickCampaign?: boolean;
  /** The AI Simulator scenario last built for this period; sent with whole-dashboard questions. */
  scenario?: SimulatorScenario | null;
}> = ({ report, session, pending, onPendingHandled, onScopeChange, canPickCampaign, scenario }) => {
  const isCampaign = report.meta.kind === 'campaign';
  const activeScenario = !isCampaign && scenario && scenario.reportId === report.meta.reportId ? scenario : null;
  const contextName = scopeLabel(report);
  const intro: Msg = {
    id: 'intro',
    role: 'assistant',
    at: time(),
    content: isCampaign
      ? `Hello! I am your AI Campaign Performance Analyst. I answer from the report for **${contextName}** (${report.period?.label ?? 'selected period'}, source ${report.source.datasetName}).\n\nAsk how it performed, how it compares with other campaigns and the previous period, what its subject lines were, and what to test next. Every number links to its evidence.`
      : `Hello! I am your AI Campaign Performance Analyst. I can see **${contextName}** for ${report.period?.label ?? 'the selected period'} (source ${report.source.datasetName}): headline KPIs, what improved and what needs attention, every campaign, revenue by campaign and channel, programs, subject lines and creative, launch days and offers.\n\nAsk anything about it — for example which campaigns to fix first, or what worked best. Every number links to the dashboard fact it comes from.`,
  };
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([intro]);
  const [evidence, setEvidence] = useState<EvidenceItem[]>(report.evidence);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showEvidence, setShowEvidence] = useState<string[] | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Block body: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup.
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  // Real time: a new import or a different period gives a new snapshot. Keep the conversation,
  // start a new thread on the new snapshot, and say what changed.
  const reportRef = useRef(report.meta.reportId);
  useEffect(() => {
    if (reportRef.current === report.meta.reportId) return;
    reportRef.current = report.meta.reportId;
    setThreadId(null);
    setEvidence(report.evidence);
    setMessages((m) => [
      ...m,
      { id: `n-${Date.now()}`, role: 'assistant', notice: true, at: time(), content: `The dashboard data changed. Answers now use ${report.period?.label ?? 'the selected period'} · ${report.source.datasetName} v${report.source.version}.` },
    ]);
  }, [report]);

  const questions = isCampaign
    ? [`Why did ${contextName} perform this way?`, 'How did it compare with the other campaigns on this channel?', 'What subject lines did it use, and how did they do?', 'What was its revenue per delivered message?', 'How did it change from the previous period?', 'What should I test next for this campaign?']
    : [...(activeScenario ? ['Explain my AI Simulator scenario and its risks', 'Is my scenario realistic compared with the measured results?'] : []), 'Summarize the whole dashboard for this period', 'Which campaigns should I fix first, and why?', 'Which campaigns performed best?', 'Which program, subject line and offer worked best?', 'Which launch day worked best?', 'Where did revenue come from?', 'What improved and what declined vs the previous period?', 'What can this data not tell me?'];

  const handleSend = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setInput('');
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', content: q, at: time() }]);
    try {
      let id = threadId;
      if (!id) {
        id = (await apiSend<{ id: string }>('POST', '/chat/threads', { reportId: report.meta.reportId })).id;
        setThreadId(id);
      }
      const out = await apiSend<{ message: Msg; evidence: EvidenceItem[]; facts?: Fact[] }>('POST', `/chat/threads/${id}/messages`, { message: q, ...(activeScenario ? { scenario: activeScenario } : {}) });
      setEvidence(out.evidence);
      setMessages((m) => [...m, { ...out.message, facts: out.facts ?? [], at: time() }]);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  // "Ask AI about this" from another screen: send once.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!pending || handled.current === pending.id) return;
    handled.current = pending.id;
    onPendingHandled?.();
    void handleSend(pending.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  const renderIntro = (s: string) => s.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>));

  return (
    <div className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm flex flex-col h-[680px] overflow-hidden">
      <div className="p-4 border-b border-[#e8dcc9] bg-[#f5eee6] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#f1dfcf] text-[#8d563b] flex items-center justify-center"><Bot className="w-5 h-5" /></div>
          <div>
            <h3 className="text-sm font-bold text-[#2d241d] flex items-center gap-2">
              Ask the AI Campaign Analyst
              <span className="text-[10px] bg-emerald-100 text-emerald-800 font-semibold px-2 py-0.5 rounded-full">{session.features.aiProvider === 'none' ? 'Report Grounded · rule-based' : 'Report Grounded'}</span>
              <span className="text-[10px] bg-sky-100 text-sky-800 font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1" title="Answers always use the data and period shown on the dashboard; a new import or period switches automatically.">
                <RefreshCw className="w-2.5 h-2.5" /> Live data
              </span>
            </h3>
            <p className="text-[11px] text-[#6b554d]">
              {isCampaign ? 'One campaign' : 'Whole dashboard'} · {report.period?.label ?? 'selected period'} · {report.source.datasetName} v{report.source.version}
            </p>
            {activeScenario && (
              <p className="text-[10px] text-violet-800" id="chat-scenario">
                Includes your AI Simulator scenario: {activeScenario.strategy}, {activeScenario.audience.toLocaleString('en-US')} messages (your assumptions, not results)
              </p>
            )}
          </div>
        </div>
        {canPickCampaign && onScopeChange && (
          <div className="flex rounded-lg bg-white border border-[#e8dcc9] p-0.5 text-[11px] font-semibold" role="tablist" aria-label="Ask about">
            <button role="tab" aria-selected={!isCampaign} onClick={() => onScopeChange('account')} className={`px-2.5 py-1 rounded-md ${!isCampaign ? 'bg-[#C74634] text-white' : 'text-[#6b554d]'}`}>Whole dashboard</button>
            <button role="tab" aria-selected={isCampaign} onClick={() => onScopeChange('campaign')} className={`px-2.5 py-1 rounded-md ${isCampaign ? 'bg-[#C74634] text-white' : 'text-[#6b554d]'}`}>One campaign</button>
          </div>
        )}
      </div>

      <div className="px-4 py-2 bg-[#f5eee6] border-b border-[#e8dcc9] flex gap-2 overflow-x-auto">
        {questions.map((q) => (
          <button key={q} onClick={() => handleSend(q)} disabled={loading} className="text-[11px] px-3 py-1 rounded-full bg-[#fffaf5] hover:bg-[#b77a57]/20 hover:text-[#7d4d35] text-[#4d4039] border border-[#e8dcc9] whitespace-nowrap transition-all flex items-center gap-1.5 disabled:opacity-50">
            <MessageSquare className="w-2.5 h-2.5 text-[#8d563b]" /> <span>{q}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4" aria-live="polite">
        {messages.map((msg) => {
          const isAssistant = msg.role === 'assistant';
          if (msg.notice) {
            return (
              <div key={msg.id} className="mx-auto max-w-xl text-center text-[11px] rounded-full bg-sky-50 border border-sky-200 text-sky-900 px-3 py-1 flex items-center justify-center gap-1.5">
                <RefreshCw className="w-3 h-3" /> {msg.content}
              </div>
            );
          }
          return (
            <div key={msg.id} className={`flex gap-3 max-w-3xl ${isAssistant ? '' : 'ml-auto flex-row-reverse'}`}>
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isAssistant ? 'bg-[#b77a57]/20 text-[#8d563b] border border-[#e2c4a8]' : 'bg-[#eadfd2] text-[#2d241d]'}`}>
                {isAssistant ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
              </div>
              <div className="space-y-1 min-w-0">
                {!isAssistant || msg.id === 'intro' ? (
                  <div className={`p-4 rounded-2xl text-xs leading-relaxed whitespace-pre-line ${isAssistant ? 'bg-[#f5eee6] text-[#4d4039] border border-[#e8dcc9]' : 'bg-[#b77a57] text-white shadow-xs'}`}>
                    {isAssistant ? renderIntro(msg.content) : msg.content}
                  </div>
                ) : (
                  <div className="p-4 rounded-2xl text-xs bg-[#f5eee6] text-[#4d4039] border border-[#e8dcc9] space-y-2">
                    {msg.answer?.statements.map((s, i) => {
                      const facts = (msg.facts ?? []).filter((f) => s.evidenceIds.includes(f.id));
                      return (
                        <div key={i} className="space-y-1">
                          <div className="flex items-start gap-2">
                            <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border shrink-0 ${KIND_CLS[s.kind] ?? KIND_CLS.observation}`}>{s.kind}</span>
                            <span className="flex-1 leading-relaxed">{s.text}</span>
                            {s.evidenceIds.some((id) => evidence.some((e) => e.id === id)) && <button className="text-[10px] font-semibold text-[#C74634] hover:underline shrink-0" onClick={() => setShowEvidence(s.evidenceIds)}>Evidence</button>}
                          </div>
                          {msg.answer?.generator === 'ai' && <div className="pl-14"><FactList facts={facts} /></div>}
                        </div>
                      );
                    })}
                    {!msg.answer?.statements.length && <div>No statement could be grounded in this report.</div>}
                    {msg.answer && msg.answer.missingInformation.length > 0 && (
                      <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-amber-900">
                        <div className="font-bold">Not answerable from this data</div>
                        <ul className="list-disc pl-4">{msg.answer.missingInformation.map((x) => <li key={x}>{x}</li>)}</ul>
                      </div>
                    )}
                    {msg.answer && (
                      <div className="text-[10px] text-[#8a7668]">
                        {STATUS_TEXT[msg.answer.aiStatus] ?? msg.answer.aiStatus}
                        {msg.answer.model ? ` · ${msg.answer.model}` : ''}
                        {msg.answer.rejectedStatements ? ` · ${msg.answer.rejectedStatements} unsupported statement(s) removed` : ''}
                        {msg.answer.aiError ? <div className="mt-1 text-amber-800">Why the AI was not used: {msg.answer.aiError}</div> : null}
                      </div>
                    )}
                  </div>
                )}
                <div className={`text-[10px] text-[#6b554d] px-1 ${isAssistant ? 'text-left' : 'text-right'}`}>{msg.at}</div>
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#b77a57]/20 text-[#8d563b] border border-[#e2c4a8] flex items-center justify-center"><Bot className="w-4 h-4" /></div>
            <div className="p-3.5 rounded-2xl bg-[#f5eee6] border border-[#e8dcc9] text-xs text-[#8d563b] flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> <span>{isCampaign ? 'Checking the campaign report…' : 'Analysing the whole dashboard…'}</span></div>
          </div>
        )}
        {error ? <ErrorBox error={error} /> : null}
        <div ref={end} />
      </div>

      <div className="p-3 bg-[#f5eee6] border-t border-[#e8dcc9]">
        <form onSubmit={(e) => { e.preventDefault(); void handleSend(); }} className="flex items-center gap-2">
          <input id="chat-input" type="text" value={input} maxLength={2000} onChange={(e) => setInput(e.target.value)} placeholder={isCampaign ? 'Ask about this campaign’s results, subject lines, or how it compares…' : 'Ask anything about the dashboard: campaigns, revenue, programs, subject lines, days, offers…'} className="flex-1 bg-[#fffaf5] border border-[#e8dcc9] focus:border-[#e2c4a8] rounded-xl px-4 py-2.5 text-xs text-[#2d241d] placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-[#b77a57]/50" />
          <button id="btn-chat-send" type="submit" disabled={!input.trim() || loading} aria-label="Send" className="p-2.5 rounded-xl bg-[#b77a57] hover:bg-[#a86d4d] text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs flex items-center justify-center">
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
      <EvidenceListModal ids={showEvidence} evidence={evidence} onClose={() => setShowEvidence(null)} />
    </div>
  );
};
