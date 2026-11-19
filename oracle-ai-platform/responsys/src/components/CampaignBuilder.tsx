/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Campaign Builder — edits an Email, SMS and WebPush version of a draft.
 *
 * Saving creates an immutable draft version on the server (optimistic concurrency); "Saved"
 * appears only after the server confirms. A draft is authored content only: it has no
 * performance, is not a Responsys campaign, and is not sent. Email can be edited in place in the
 * preview, through fields, or as Responsys RPL code. Validation shown here is local only.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AmilTemplate, CampaignTopic, EmailContent, HighlightType, PushContent, TemplateChannel } from '../data/amilTemplates';
import { TOPIC_LABEL } from '../data/amilTemplates';
import { THEMES, buildEmailRpl, buildPushJson, removeAccents, renderRpl, smsStats } from '../utils/rplEngine';
import { EmailFrame, PushDesktop, PushMobile, SmsPhone, PhoneShell } from './TemplatePreviews';
import { packFor, rankPackTemplates, type ContentPack } from '../content/packs';
import type { Account, DraftContent, LocalValidation } from '../lib/types';
import type { JourneyRecord } from '../../shared/scenario/journeys';
import { apiSend, ApiError } from '../lib/api';
import {
  X,
  Mail,
  MessageSquare,
  Bell,
  Monitor,
  Smartphone,
  Code2,
  PenLine,
  Download,
  Copy,
  RotateCcw,
  Plus,
  Trash2,
  Wand2,
  CheckCircle2,
  AlertTriangle,
  Star,
  Info,
  Upload,
  ImageOff,
  Sparkles,
  Undo2,
  ChevronDown,
  Loader2,
  CornerDownLeft,
  Users,
  Paperclip,
  FileText,
  Bot,
  Save,
} from 'lucide-react';

export interface BuilderInput {
  account: Account;
  draftId: string | null;
  version: number | null;
  name: string;
  primaryChannel: TemplateChannel;
  content: DraftContent | null;
  topic: CampaignTopic;
  sourceNote?: string;
  /** Template picked in the AI Simulator: the builder starts from it for its channel. */
  templateId?: string | null;
  emailOverride?: EmailContent;
  /** The simulator plan this draft comes from, stored with the draft as a record (not applied to any send). */
  plan?: SimulatorPlan | null;
}

export interface SimulatorPlan {
  reportId: string;
  strategy: string;
  period: string;
  baseline: string;
  audience: string;
  program: string;
  assumptions: string;
  journey?: JourneyRecord;
}

type Device = 'desktop' | 'mobile';
const CHANNEL_ICON: Record<TemplateChannel, React.ElementType> = { Email: Mail, SMS: MessageSquare, WebPush: Bell };

/** Safe file name: draft names can contain characters browsers reject (—, /, :, quotes). */
const fileName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 100) || 'draft';

const download = (filename: string, text: string, type = 'text/html') => {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dot = filename.lastIndexOf('.');
  a.download = dot > 0 ? `${fileName(filename.slice(0, dot))}${filename.slice(dot)}` : fileName(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const firstOf = (pack: ContentPack, ch: TemplateChannel, topic: CampaignTopic): AmilTemplate | undefined => rankPackTemplates(pack, ch, topic)[0];
/** The template chosen in the simulator when it has content for this channel, else the best match for the topic. */
const startOf = (pack: ContentPack, ch: TemplateChannel, topic: CampaignTopic, chosenId: string | null | undefined): AmilTemplate | undefined => {
  const chosen = chosenId ? pack.templates.find((t) => t.id === chosenId) : undefined;
  const has = (t: AmilTemplate | undefined) => Boolean(t && (ch === 'Email' ? t.email : ch === 'SMS' ? t.sms : t.push));
  return has(chosen) ? chosen : firstOf(pack, ch, topic);
};

interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
  message?: string;
}

/* ------------------------------------------------------------------ */

export const CampaignBuilder: React.FC<{ input: BuilderInput; canEdit: boolean; aiEnabled: boolean; onClose: () => void; onSaved: (draftId: string, version: number) => void }> = ({
  input,
  canEdit,
  aiEnabled,
  onClose,
  onSaved,
}) => {
  const pack = packFor(input.account);
  const brand = useMemo(() => pack.brand(input.account), [pack, input.account]);
  const topic = input.topic;
  const initial = input.content;

  const [channel, setChannel] = useState<TemplateChannel>(input.primaryChannel);
  const [name, setName] = useState(input.name);
  const [profileId, setProfileId] = useState(pack.profiles[0]!.id);
  const data = (pack.profiles.find((p) => p.id === profileId) ?? pack.profiles[0]!).data;
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  };

  // ---------- Email ----------
  const startEmail = initial?.email ?? input.emailOverride ?? startOf(pack, 'Email', topic, input.templateId)?.email ?? pack.templates.find((t) => t.email)!.email!;
  const [emailTplId, setEmailTplId] = useState(initial?.templateIds.email ?? startOf(pack, 'Email', topic, input.templateId)?.id ?? '');
  const [email, setEmail] = useState<EmailContent>(startEmail as EmailContent);
  const [prefsLink, setPrefsLink] = useState(initial?.preferencesLink ?? false);
  const [emailMode, setEmailMode] = useState<'visual' | 'code'>(initial?.customEmailCode ? 'code' : 'visual');
  const [customCode, setCustomCode] = useState<string | null>(initial?.customEmailCode ?? null);
  const [device, setDevice] = useState<Device>('desktop');

  const comment = `${name} | Draft built in Campaign Intelligence | ${pack.label} ${pack.version}`;
  const generatedRpl = useMemo(() => buildEmailRpl(email, { mode: 'rpl', preferencesLink: prefsLink, comment, brand }), [email, prefsLink, comment, brand]);
  const rplSource = customCode ?? generatedRpl;
  const previewHtml = useMemo(() => {
    if (customCode !== null) return renderRpl(customCode, data);
    return renderRpl(buildEmailRpl(email, { mode: 'edit', data, preferencesLink: prefsLink, brand }), data);
  }, [customCode, email, data, prefsLink, brand]);

  const setEmailField = (path: string, value: string) => {
    setEmail((prev) => {
      const next = { ...prev, bullets: [...prev.bullets] };
      if (path.startsWith('bullets.')) next.bullets[Number(path.split('.')[1])] = value;
      else if (path.startsWith('step.')) {
        const steps = prev.highlightValue.split('|');
        steps[Number(path.split('.')[1])] = value.replace(/\|/g, '/');
        next.highlightValue = steps.join('|');
      } else (next as unknown as Record<string, unknown>)[path] = value;
      return next;
    });
  };

  const chooseEmailTemplate = (id: string) => {
    const t = pack.templates.find((x) => x.id === id);
    if (!t?.email) return;
    setEmailTplId(id);
    setEmail(t.email);
    setCustomCode(null);
    setEmailMode('visual');
  };

  // ---------- SMS ----------
  const [smsTplId, setSmsTplId] = useState(initial?.templateIds.sms ?? startOf(pack, 'SMS', topic, input.templateId)?.id ?? '');
  const [smsText, setSmsText] = useState(initial?.sms.text ?? startOf(pack, 'SMS', topic, input.templateId)?.sms?.text ?? '');
  const smsRendered = renderRpl(smsText, data, { linkMode: 'short', escape: false, shortLinkDomain: brand.shortLinkDomain });
  const stats = smsStats(smsRendered);

  // ---------- Push ----------
  const [pushTplId, setPushTplId] = useState(initial?.templateIds.push ?? startOf(pack, 'WebPush', topic, input.templateId)?.id ?? '');
  const [push, setPush] = useState<PushContent>(initial?.push ?? startOf(pack, 'WebPush', topic, input.templateId)?.push ?? { title: '', body: '', link: 'PUSH_LINK', button1: '', button2: '', imageUrl: '' });
  const [pushView, setPushView] = useState<'visual' | 'code'>('visual');

  // ---------- Persistence ----------
  const content: DraftContent = {
    email,
    sms: { text: smsText },
    push,
    customEmailCode: customCode,
    preferencesLink: prefsLink,
    templateIds: { email: emailTplId, sms: smsTplId, push: pushTplId },
    contentPack: pack.id,
  };
  const [draftId, setDraftId] = useState(input.draftId);
  const [version, setVersion] = useState(input.version);
  const [savedHash, setSavedHash] = useState(() => (initial ? JSON.stringify(content) : ''));
  const dirty = JSON.stringify(content) !== savedHash || name !== input.name;
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const [validation, setValidation] = useState<LocalValidation | null>(null);
  const [origin, setOrigin] = useState<'manual' | 'ai_accepted' | 'template'>('manual');

  /** Saves a new version; returns the draft ID once the server has confirmed, else null. */
  const doSave = async (): Promise<string | null> => {
    if (!canEdit) return null;
    setSave({ status: 'saving' });
    try {
      let savedId = draftId;
      if (!draftId) {
        const out = await apiSend<{ id: string; version: number; validation: LocalValidation }>('POST', '/drafts', { accountId: input.account.id, name, primaryChannel: input.primaryChannel, content, source: { ...(input.sourceNote ? { note: input.sourceNote.slice(0, 300) } : {}), ...(input.plan ? { reportId: input.plan.reportId, plan: input.plan } : {}) } });
        setDraftId(out.id);
        savedId = out.id;
        setVersion(out.version);
        setValidation(out.validation);
        onSaved(out.id, out.version);
        setSave({ status: 'saved', message: `Saved as version ${out.version}` });
      } else {
        const out = await apiSend<{ version: number; validation?: LocalValidation; unchanged?: boolean; invalidatedApprovals?: number }>('PUT', `/drafts/${draftId}`, { expectedVersion: version, content, name, origin, changeNote: origin === 'ai_accepted' ? 'Accepted AI proposal' : undefined });
        setVersion(out.version);
        if (out.validation) setValidation(out.validation);
        onSaved(draftId, out.version);
        setSave({ status: 'saved', message: out.unchanged ? 'No changes to save' : `Saved as version ${out.version}${out.invalidatedApprovals ? ` · ${out.invalidatedApprovals} approval(s) invalidated by this change` : ''}` });
      }
      setSavedHash(JSON.stringify(content));
      setOrigin('manual');
      return savedId;
    } catch (e) {
      const err = e as ApiError;
      setSave({ status: err.status === 409 ? 'conflict' : 'error', message: err.message });
      return null;
    }
  };

  // ---------- AI proposals (server-side, diff to accept) ----------
  const [history, setHistory] = useState<{ email: EmailContent; sms: string; push: PushContent }[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [manualOpen, setManualOpen] = useState(true);
  const applyProposal = (next: DraftContent) => {
    setHistory((h) => [...h.slice(-19), { email, sms: smsText, push }]);
    setEmail(next.email);
    setSmsText(next.sms.text);
    setPush(next.push);
    setOrigin('ai_accepted');
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setEmail(prev.email);
    setSmsText(prev.sms);
    setPush(prev.push);
    setChat((c) => [...c, { id: Date.now(), role: 'assistant', content: 'Undid the last accepted change.' }]);
    flash('Last change undone');
  };
  const refinePanel = (
    <RefinePanel
      draftId={draftId}
      dirty={dirty}
      aiEnabled={aiEnabled && canEdit}
      profiles={pack.profiles}
      profileId={profileId}
      setProfileId={setProfileId}
      defaultTarget={channel === 'Email' ? 'all' : channel === 'SMS' ? 'sms' : 'push'}
      disabled={channel === 'Email' && customCode !== null}
      onAccept={applyProposal}
      onUndo={undo}
      canUndo={history.length > 0}
      chat={chat}
      setChat={setChat}
      ensureSaved={doSave}
      suggestions={[
        `Write this ${channel === 'Email' ? 'email' : channel === 'SMS' ? 'SMS' : 'push message'} for: ${(input.sourceNote ?? name).slice(0, 200)}`,
        'Make the subject line shorter and more specific',
        'Make the call to action more urgent',
        'Make the SMS friendlier and keep it to one part',
      ]}
    />
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const subjectRendered = renderRpl(email.subject, data, { escape: false });
  const subjectLen = subjectRendered.length;
  const tokens = pack.tokens;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Campaign builder">
      <div className="relative bg-[#F4F5F7] w-full max-w-[1500px] sm:rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        <div className="bg-[#2d241d] text-white px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Wand2 className="w-4 h-4 text-[#f0a08f] shrink-0" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Draft name"
              disabled={!canEdit}
              className="bg-white/10 rounded-lg px-2 py-1 text-sm font-bold font-mono min-w-0 w-full max-w-md focus:outline-none focus:ring-2 focus:ring-[#f0a08f]"
            />
            <span className="text-[11px] text-white/70 whitespace-nowrap">{draftId ? `Draft v${version}` : 'Not saved yet'}{dirty ? ' · unsaved changes' : ''}</span>
          </div>
          <div className="flex gap-1" role="tablist" aria-label="Channel">
            {(['Email', 'SMS', 'WebPush'] as TemplateChannel[]).map((ch) => {
              const Icon = CHANNEL_ICON[ch];
              return (
                <button key={ch} role="tab" aria-selected={channel === ch} onClick={() => setChannel(ch)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${channel === ch ? 'bg-[#C74634]' : 'bg-white/10 hover:bg-white/20'}`}>
                  <Icon className="w-3.5 h-3.5" />
                  {ch}
                  {ch === input.primaryChannel && <Star className="w-3 h-3 fill-current" aria-label="primary channel" />}
                </button>
              );
            })}
          </div>
          {canEdit && (
            <button onClick={() => void doSave()} disabled={save.status === 'saving'} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#C74634] hover:bg-[#b03d2d] disabled:opacity-60 cursor-pointer">
              {save.status === 'saving' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {save.status === 'saving' ? 'Saving…' : 'Save draft'}
            </button>
          )}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/15 cursor-pointer" aria-label="Close builder">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-[#fffaf5] border-b border-[#e8dcc9] px-4 py-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-bold text-[#2d241d]">{pack.label}</span>
          <span className="text-[#6b554d]">· brand: {brand.name} · topic: {TOPIC_LABEL[topic]}</span>
          {input.sourceNote && <span className="text-[#6b554d]">· {input.sourceNote}</span>}
          {input.plan?.journey?.websiteOffer && <span className="w-full text-cyan-900">Website offer: {input.plan.journey.websiteOffer.title} · Map WEBSITE_OFFER to <a className="underline break-all" href={input.plan.journey.websiteOffer.landingUrl} target="_blank" rel="noreferrer">{input.plan.journey.websiteOffer.landingUrl}</a>. Recheck terms and audience eligibility before launch.</span>}
          {save.status === 'saved' && <span className="text-emerald-700 font-semibold inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />{save.message}</span>}
          {(save.status === 'error' || save.status === 'conflict') && (
            <span className="text-rose-700 font-semibold inline-flex items-center gap-1" role="alert"><AlertTriangle className="w-3.5 h-3.5" />{save.status === 'conflict' ? 'Not saved: ' : 'Not saved — your edits are still here: '}{save.message}</span>
          )}
          {validation && (
            <span className={`ml-auto inline-flex items-center gap-1 font-semibold ${validation.passed ? 'text-emerald-700' : 'text-rose-700'}`} title={validation.label}>
              {validation.passed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              Local checks: {validation.errors.length} error(s), {validation.warnings.length} warning(s) · not validated by Responsys
            </span>
          )}
        </div>
        {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
          <details className="bg-white border-b border-[#e8dcc9] px-4 py-1 text-[11px]">
            <summary className="cursor-pointer font-semibold">Show local check details</summary>
            <ul className="py-1 space-y-0.5">
              {[...validation.errors, ...validation.warnings].map((v, i) => (
                <li key={i} className={v.severity === 'error' ? 'text-rose-700' : 'text-amber-800'}>{v.channel} · {v.field}: {v.message}</li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
          {channel === 'Email' && (
            <>
              <aside className="lg:w-[430px] shrink-0 border-r border-[#e8dcc9] bg-white overflow-y-auto p-4 space-y-4">
                <TemplatePicker pack={pack} channel="Email" topic={topic} value={emailTplId} onChange={chooseEmailTemplate} />
                <div className="flex rounded-lg bg-[#f5eee6] p-0.5" role="tablist" aria-label="Editor mode">
                  {(['visual', 'code'] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      aria-selected={emailMode === m}
                      onClick={() => {
                        // Only a real code change takes over from the visual editor; viewing the code does not.
                        if (m === 'visual' && customCode === generatedRpl) setCustomCode(null);
                        setEmailMode(m);
                      }}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${emailMode === m ? 'bg-white shadow-sm text-[#2d241d]' : 'text-[#8a7668]'}`}
                    >
                      {m === 'visual' ? <PenLine className="w-3.5 h-3.5" /> : <Code2 className="w-3.5 h-3.5" />}
                      {m === 'visual' ? 'Visual' : 'RPL code'}
                    </button>
                  ))}
                </div>
                {emailMode === 'visual' && customCode !== null && (
                  <div className="text-[11px] rounded-lg bg-amber-50 border border-amber-200 p-2 text-amber-900 flex gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <div>
                      The code was edited, so the preview shows your code.{' '}
                      <button className="font-bold underline cursor-pointer" onClick={() => { setCustomCode(null); flash('Back to visual editing'); }}>Discard code edits</button> to edit visually again.
                    </div>
                  </div>
                )}
                {emailMode === 'visual' ? (
                  <>
                    {refinePanel}
                    <div className="rounded-xl border border-[#e8dcc9]">
                      <button onClick={() => setManualOpen((v) => !v)} aria-expanded={manualOpen} className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-bold cursor-pointer">
                        <span className="inline-flex items-center gap-1.5"><PenLine className="w-3.5 h-3.5 text-[#C74634]" /> Edit fields directly</span>
                        <ChevronDown className={`w-4 h-4 transition-transform ${manualOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {manualOpen && (
                        <fieldset disabled={customCode !== null || !canEdit} className="space-y-3 disabled:opacity-50 px-3 pb-3">
                          <EmailFields email={email} setField={setEmailField} setEmail={setEmail} subjectLen={subjectLen} pack={pack} tokens={tokens} hasFacts={brand.facts.length > 0} hasApp={Boolean(brand.appBanner)} hasTrust={brand.trustItems.length > 0} />
                          <label className="flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={prefsLink} onChange={(e) => setPrefsLink(e.target.checked)} />
                            “Fewer emails” link in footer
                          </label>
                        </fieldset>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="text-[11px] text-[#6b554d]">
                      Responsys RPL. The preview supports <code>${'{VAR}'}</code>, <code>&lt;#if&gt;</code>, <code>&lt;#assign&gt;</code>, <code>clickthrough()</code> — Responsys is the real renderer.
                    </div>
                    <textarea value={rplSource} onChange={(e) => setCustomCode(e.target.value)} readOnly={!canEdit} spellCheck={false} aria-label="RPL code" className="w-full h-[460px] font-mono text-[11px] leading-snug p-2 rounded-lg border border-[#e8dcc9] bg-[#1e1e1e] text-[#d4d4d4] focus:outline-none focus:ring-2 focus:ring-[#C74634]" />
                    <button onClick={() => { setCustomCode(null); setEmailMode('visual'); }} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#C74634] cursor-pointer">
                      <RotateCcw className="w-3.5 h-3.5" /> Reset to the visual version
                    </button>
                  </div>
                )}
              </aside>
              <section className="flex-1 overflow-auto p-4 space-y-3">
                <PreviewToolbar
                  profiles={pack.profiles}
                  profileId={profileId}
                  setProfileId={setProfileId}
                  device={device}
                  setDevice={setDevice}
                  hint={customCode === null ? 'Click any text in the preview to edit it' : 'Showing your RPL code'}
                  onCopy={() => navigator.clipboard?.writeText(rplSource).then(() => flash('RPL copied'))}
                  onDownload={() => download(`${name}.htm`, rplSource)}
                  copyLabel="Copy RPL"
                  downloadLabel="Download .htm"
                />
                <div className="rounded-lg bg-white border border-[#e8dcc9] px-3 py-2 text-xs flex flex-wrap gap-x-3">
                  <span className="text-[#8a7668]">From</span>
                  <span className="font-semibold">{brand.senderName}</span>
                  <span className="text-[#8a7668]">Subject</span>
                  <span className="font-semibold">{subjectRendered}</span>
                  <span className="text-[#8a7668] truncate">— {renderRpl(email.preheader, data, { escape: false })}</span>
                </div>
                <div className="flex flex-wrap gap-6 items-start justify-center">
                  {device !== 'mobile' && (
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="rounded-xl overflow-hidden border border-gray-300 shadow bg-white">
                        <div className="h-7 bg-[#f1f3f4] flex items-center gap-1.5 px-3 border-b border-gray-200">
                          <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                        </div>
                        <EmailFrame title="Desktop preview" html={previewHtml} width={680} height={760} editable={customCode === null && canEdit} onEdit={setEmailField} />
                      </div>
                      <span className="text-[10px] text-[#8a7668]">Desktop</span>
                    </div>
                  )}
                  {device !== 'desktop' && (
                    <PhoneShell label="Mobile">
                      <EmailFrame title="Mobile preview" html={previewHtml} width={375} height={700} editable={customCode === null && canEdit} onEdit={setEmailField} />
                    </PhoneShell>
                  )}
                </div>
              </section>
            </>
          )}

          {channel === 'SMS' && (
            <>
              <aside className="lg:w-[430px] shrink-0 border-r border-[#e8dcc9] bg-white overflow-y-auto p-4 space-y-4">
                <TemplatePicker pack={pack} channel="SMS" topic={topic} value={smsTplId} onChange={(id) => { setSmsTplId(id); setSmsText(pack.templates.find((x) => x.id === id)?.sms?.text || ''); }} />
                {refinePanel}
                <label className="block">
                  <span className="text-xs font-bold">Message (RPL)</span>
                  <textarea id="sms-text" value={smsText} onChange={(e) => setSmsText(e.target.value)} readOnly={!canEdit} spellCheck={false} className="mt-1 w-full h-36 font-mono text-[12px] p-2 rounded-lg border border-[#e8dcc9] focus:outline-none focus:ring-2 focus:ring-[#C74634]" />
                </label>
                <TokenChips tokens={tokens} onInsert={(tok) => {
                  const el = document.getElementById('sms-text') as HTMLTextAreaElement | null;
                  const pos = el?.selectionStart ?? smsText.length;
                  setSmsText(smsText.slice(0, pos) + tok + smsText.slice(pos));
                }} />
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat label="Characters" value={`${stats.length}/${stats.limit}`} bad={stats.segments > 1} />
                  <Stat label="SMS parts" value={`${stats.segments}`} bad={stats.segments > 1} />
                  <Stat label="Encoding" value={stats.encoding.split(' ')[0]!} bad={stats.encoding !== 'GSM-7'} />
                </div>
                {stats.nonGsm.length > 0 && (
                  <div className="text-[11px] rounded-lg bg-amber-50 border border-amber-200 p-2 text-amber-900">
                    Characters like <strong>{stats.nonGsm.slice(0, 6).join(' ')}</strong> switch the message to Unicode (70 characters per part).{' '}
                    <button className="font-bold underline cursor-pointer" onClick={() => setSmsText(removeAccents(smsText))}>Remove accents</button>
                  </div>
                )}
                <ul className="text-[11px] space-y-1">
                  <Check ok={/STOP|SAIR|opt.?out/i.test(smsText)} text="Opt-out wording (check your country's rules)" />
                  <Check ok={stats.segments <= 1} text="Fits in 1 SMS part with this sample" />
                  <Check ok={/clickthrough|reply/i.test(smsText)} text="Tracked short link (or reply-based)" />
                </ul>
                <div className="flex gap-2">
                  <ActionBtn icon={Copy} label="Copy RPL" onClick={() => navigator.clipboard?.writeText(smsText).then(() => flash('SMS copied'))} />
                  <ActionBtn icon={Download} label="Download .txt" onClick={() => download(`${name}_SMS.txt`, smsText, 'text/plain')} />
                </div>
              </aside>
              <section className="flex-1 overflow-auto p-4 flex flex-col items-center gap-3">
                <ProfileSelect profiles={pack.profiles} profileId={profileId} setProfileId={setProfileId} />
                <SmsPhone text={smsRendered} sender={brand.smsSender} />
                <p className="text-[11px] text-[#8a7668] flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Preview only — not sent. SMS limits depend on your provider and country.</p>
              </section>
            </>
          )}

          {channel === 'WebPush' && (
            <>
              <aside className="lg:w-[430px] shrink-0 border-r border-[#e8dcc9] bg-white overflow-y-auto p-4 space-y-3">
                <TemplatePicker pack={pack} channel="WebPush" topic={topic} value={pushTplId} onChange={(id) => { setPushTplId(id); const t = pack.templates.find((x) => x.id === id); if (t?.push) setPush(t.push); }} />
                {refinePanel}
                <div className="flex rounded-lg bg-[#f5eee6] p-0.5">
                  {(['visual', 'code'] as const).map((m) => (
                    <button key={m} onClick={() => setPushView(m)} className={`flex-1 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${pushView === m ? 'bg-white shadow-sm' : 'text-[#8a7668]'}`}>
                      {m === 'visual' ? 'Fields' : 'Payload (JSON)'}
                    </button>
                  ))}
                </div>
                {pushView === 'visual' ? (
                  <fieldset disabled={!canEdit} className="space-y-3">
                    <Field label="Title" value={push.title} max={50} onChange={(v) => setPush({ ...push, title: v })} />
                    <Field label="Message" value={push.body} max={120} multiline onChange={(v) => setPush({ ...push, body: v })} />
                    <Field label="Button 1" value={push.button1} max={20} onChange={(v) => setPush({ ...push, button1: v })} />
                    <Field label="Button 2 (optional)" value={push.button2} max={20} onChange={(v) => setPush({ ...push, button2: v })} />
                    <Field label="Link name (link table)" value={push.link} onChange={(v) => setPush({ ...push, link: v.toUpperCase().replace(/\s+/g, '_') })} />
                    <ImagePicker pack={pack} label="Large image" value={push.imageUrl} allowNone onChange={(v) => setPush({ ...push, imageUrl: v })} />
                  </fieldset>
                ) : (
                  <pre className="text-[11px] font-mono bg-[#1e1e1e] text-[#d4d4d4] rounded-lg p-2 overflow-auto max-h-[420px]">{buildPushJson(push, name, brand.iconUrl)}</pre>
                )}
                <div className="flex gap-2">
                  <ActionBtn icon={Copy} label="Copy JSON" onClick={() => navigator.clipboard?.writeText(buildPushJson(push, name, brand.iconUrl)).then(() => flash('Payload copied'))} />
                  <ActionBtn icon={Download} label="Download .json" onClick={() => download(`${name}_PUSH.json`, buildPushJson(push, name, brand.iconUrl), 'application/json')} />
                </div>
              </aside>
              <section className="flex-1 overflow-auto p-4 space-y-3">
                <PreviewToolbar profiles={pack.profiles} profileId={profileId} setProfileId={setProfileId} device={device} setDevice={setDevice} />
                <div className="flex flex-wrap gap-6 items-start justify-center">
                  {device !== 'mobile' && <PushDesktop p={push} brand={brand} title={renderRpl(push.title, data, { escape: false })} body={renderRpl(push.body, data, { escape: false })} />}
                  {device !== 'desktop' && <PushMobile p={push} brand={brand} title={renderRpl(push.title, data, { escape: false })} body={renderRpl(push.body, data, { escape: false })} />}
                </div>
              </section>
            </>
          )}
        </div>

        {toast && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#2d241d] text-white text-xs px-3 py-2 rounded-lg shadow-lg flex items-center gap-1.5" role="status">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> {toast}
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Sub-components                                                     */
/* ------------------------------------------------------------------ */

const TemplatePicker: React.FC<{ pack: ContentPack; channel: TemplateChannel; topic: CampaignTopic; value: string; onChange: (id: string) => void }> = ({ pack, channel, topic, value, onChange }) => {
  const list = rankPackTemplates(pack, channel, topic);
  const current = list.find((t) => t.id === value);
  return (
    <label className="block">
      <span className="text-xs font-bold">{channel} template · {pack.label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full text-xs rounded-lg border border-[#e8dcc9] px-2 py-1.5 bg-white">
        {list.map((t: AmilTemplate) => (
          <option key={t.id} value={t.id}>{t.topic === topic ? '★ ' : ''}{t.name} · {TOPIC_LABEL[t.topic]}</option>
        ))}
      </select>
      {current && <span className="text-[10px] text-[#8a7668]">{current.bestFor}{current.source ? ` · based on ${current.source}` : ''}</span>}
    </label>
  );
};

const HIGHLIGHT_OPTIONS: { v: HighlightType; l: string }[] = [
  { v: 'none', l: 'None' },
  { v: 'price', l: 'Price' },
  { v: 'discount', l: 'Discount' },
  { v: 'boleto', l: 'Payment code' },
  { v: 'steps', l: 'Steps (use | between)' },
  { v: 'nps', l: 'Survey 0–10' },
  { v: 'promo', l: 'Promo code box' },
  { v: 'offer', l: 'Website offer' },
];

const EmailFields: React.FC<{
  email: EmailContent;
  setField: (path: string, v: string) => void;
  setEmail: React.Dispatch<React.SetStateAction<EmailContent>>;
  subjectLen: number;
  pack: ContentPack;
  tokens: { label: string; token: string }[];
  hasFacts: boolean;
  hasApp: boolean;
  hasTrust: boolean;
}> = ({ email, setField, setEmail, subjectLen, pack, tokens, hasFacts, hasApp, hasTrust }) => {
  const lastFocus = useRef<{ path: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const bind = (path: string) => ({ onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => (lastFocus.current = { path, el: e.currentTarget }) });
  const insert = (tok: string) => {
    const f = lastFocus.current;
    if (!f) return;
    const pos = f.el.selectionStart ?? f.el.value.length;
    setField(f.path, f.el.value.slice(0, pos) + tok + f.el.value.slice(pos));
  };
  return (
    <div className="space-y-3">
      <Field label="Subject" value={email.subject} onChange={(v) => setField('subject', v)} {...bind('subject')} note={`${subjectLen} characters with the sample profile`} />
      <Field label="Preview line (preheader)" value={email.preheader} onChange={(v) => setField('preheader', v)} {...bind('preheader')} />
      <div className="rounded-lg border border-[#e8dcc9] p-2 space-y-2">
        <div className="text-xs font-bold">Banner (header)</div>
        <ImagePicker pack={pack} label="Banner image" value={email.heroImage} allowNone onChange={(v) => setEmail((p) => ({ ...p, heroImage: v }))} />
        <Field label="Small label above headline" value={email.eyebrow} onChange={(v) => setField('eyebrow', v)} {...bind('eyebrow')} />
        <Field label="Headline" value={email.headline} onChange={(v) => setField('headline', v)} {...bind('headline')} />
        <Field label="Line under headline" value={email.heroSub} onChange={(v) => setField('heroSub', v)} {...bind('heroSub')} />
        {hasTrust && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={email.trustBar} onChange={(e) => setEmail((p) => ({ ...p, trustBar: e.target.checked }))} />
            Icon strip under banner (from the brand kit)
          </label>
        )}
      </div>
      <Field label="Main text" value={email.intro} multiline onChange={(v) => setField('intro', v)} {...bind('intro')} />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={email.greeting} onChange={(e) => setEmail((p) => ({ ...p, greeting: e.target.checked }))} />
        Greeting “Hi first name,” (falls back to “Hi there,”)
      </label>
      <div>
        <Field label="List title" value={email.bulletsTitle} onChange={(v) => setField('bulletsTitle', v)} {...bind('bulletsTitle')} />
        <div className="space-y-1 mt-1.5">
          {email.bullets.map((b, i) => (
            <div key={i} className="flex gap-1">
              <input value={b} onChange={(e) => setField(`bullets.${i}`, e.target.value)} {...bind(`bullets.${i}`)} aria-label={`List item ${i + 1}`} className="flex-1 text-xs rounded-lg border border-[#e8dcc9] px-2 py-1" />
              <button aria-label={`Remove item ${i + 1}`} onClick={() => setEmail((p) => ({ ...p, bullets: p.bullets.filter((_, j) => j !== i) }))} className="p-1 text-[#8a7668] hover:text-rose-600 cursor-pointer">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button onClick={() => setEmail((p) => ({ ...p, bullets: [...p.bullets, 'New item'] }))} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#C74634] cursor-pointer">
            <Plus className="w-3.5 h-3.5" /> Add item
          </button>
        </div>
      </div>
      <div className="rounded-lg border border-[#e8dcc9] p-2 space-y-2">
        <label className="block text-xs font-bold">
          Highlight box
          <select value={email.highlightType} onChange={(e) => setEmail((p) => ({ ...p, highlightType: e.target.value as HighlightType }))} className="mt-1 w-full text-xs rounded-lg border border-[#e8dcc9] px-2 py-1 bg-white font-normal">
            {HIGHLIGHT_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </label>
        {email.highlightType !== 'none' && (
          <>
            <Field label="Label" value={email.highlightLabel} onChange={(v) => setField('highlightLabel', v)} {...bind('highlightLabel')} />
            {email.highlightType !== 'nps' && <Field label="Value" value={email.highlightValue} onChange={(v) => setEmail((p) => ({ ...p, highlightValue: v }))} {...bind('highlightValue')} />}
            <Field label="Note" value={email.highlightNote} onChange={(v) => setField('highlightNote', v)} {...bind('highlightNote')} />
          </>
        )}
      </div>
      <Field label="Button text" value={email.ctaText} onChange={(v) => setField('ctaText', v)} {...bind('ctaText')} />
      <Field label="Button link name (link table)" value={email.ctaLink} onChange={(v) => setField('ctaLink', v.toUpperCase().replace(/\s+/g, '_'))} />
      <Field label="Second button text (optional)" value={email.cta2Text} onChange={(v) => setField('cta2Text', v)} {...bind('cta2Text')} />
      {email.cta2Text.trim() && <Field label="Second button link name" value={email.cta2Link} onChange={(v) => setField('cta2Link', v.toUpperCase().replace(/\s+/g, '_'))} />}
      {hasApp && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={email.appBanner} onChange={(e) => setEmail((p) => ({ ...p, appBanner: e.target.checked }))} />
          App banner (from the brand kit)
        </label>
      )}
      {hasFacts && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={email.statsBand} onChange={(e) => setEmail((p) => ({ ...p, statsBand: e.target.checked }))} />
          Brand facts band (from the brand kit — verify the figures)
        </label>
      )}
      <Field label="Text under the button" value={email.secondaryText} onChange={(v) => setField('secondaryText', v)} {...bind('secondaryText')} />
      <Field label="Legal text" value={email.legal} multiline onChange={(v) => setField('legal', v)} {...bind('legal')} />
      <div>
        <div className="text-xs font-bold mb-1">Colour</div>
        <div className="flex gap-2">
          {(Object.keys(THEMES) as (keyof typeof THEMES)[]).map((k) => (
            <button key={k} onClick={() => setEmail((p) => ({ ...p, theme: k }))} aria-pressed={email.theme === k} title={THEMES[k].name} className={`w-9 h-9 rounded-lg border-2 cursor-pointer ${email.theme === k ? 'border-[#2d241d]' : 'border-transparent'}`} style={{ background: `linear-gradient(135deg, ${THEMES[k].primary}, ${THEMES[k].accent})` }} />
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs font-bold mb-1">Insert personalisation</div>
        <TokenChips tokens={tokens} onInsert={insert} />
        <div className="text-[10px] text-[#8a7668] mt-1">Click a field first, then a chip. Confirm each field exists in your profile list or PET.</div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; onChange: (v: string) => void; multiline?: boolean; max?: number; note?: string; warn?: boolean; onFocus?: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void }> = ({ label, value, onChange, multiline, max, note, warn, onFocus }) => (
  <label className="block">
    <span className="flex justify-between text-xs font-bold">
      {label}
      {max && <span className={`font-normal ${value.length > max ? 'text-rose-600' : 'text-[#8a7668]'}`}>{value.length}/{max}</span>}
    </span>
    {multiline ? (
      <textarea value={value} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} rows={3} className="mt-1 w-full text-xs rounded-lg border border-[#e8dcc9] px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#C74634]/50" />
    ) : (
      <input value={value} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} className="mt-1 w-full text-xs rounded-lg border border-[#e8dcc9] px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#C74634]/50" />
    )}
    {note && <span className={`text-[10px] ${warn ? 'text-amber-700 font-semibold' : 'text-[#8a7668]'}`}>{note}</span>}
  </label>
);

const TokenChips: React.FC<{ tokens: { label: string; token: string }[]; onInsert: (tok: string) => void }> = ({ tokens, onInsert }) => (
  <div className="flex flex-wrap gap-1">
    {tokens.map((t) => (
      <button key={t.token} onMouseDown={(e) => e.preventDefault()} onClick={() => onInsert(t.token)} title={t.token} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[#eef0ff] text-[#461bff] hover:bg-[#dfe3ff] cursor-pointer">
        + {t.label}
      </button>
    ))}
  </div>
);

const ProfileSelect: React.FC<{ profiles: ContentPack['profiles']; profileId: string; setProfileId: (v: string) => void }> = ({ profiles, profileId, setProfileId }) => (
  <label className="text-xs flex items-center gap-1.5">
    <span className="text-[#6b554d]">Preview as</span>
    <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="text-xs rounded-lg border border-[#e8dcc9] px-2 py-1 bg-white">
      {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select>
  </label>
);

const PreviewToolbar: React.FC<{
  profiles: ContentPack['profiles'];
  profileId: string;
  setProfileId: (v: string) => void;
  device: Device;
  setDevice: (d: Device) => void;
  hint?: string;
  onCopy?: () => void;
  onDownload?: () => void;
  copyLabel?: string;
  downloadLabel?: string;
}> = ({ profiles, profileId, setProfileId, device, setDevice, hint, onCopy, onDownload, copyLabel, downloadLabel }) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <div className="flex flex-wrap items-center gap-3">
      <ProfileSelect profiles={profiles} profileId={profileId} setProfileId={setProfileId} />
      <div className="flex rounded-lg bg-white border border-[#e8dcc9] p-0.5" role="tablist" aria-label="Device">
        {([['desktop', Monitor, 'Desktop'], ['mobile', Smartphone, 'Mobile']] as [Device, React.ElementType, string][]).map(([d, Icon, l]) => (
          <button key={d} role="tab" aria-selected={device === d} onClick={() => setDevice(d)} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer ${device === d ? 'bg-[#2d241d] text-white' : 'text-[#6b554d]'}`}>
            <Icon className="w-3.5 h-3.5" /> {l}
          </button>
        ))}
      </div>
      {hint && <span className="text-[11px] text-[#461bff] inline-flex items-center gap-1"><PenLine className="w-3.5 h-3.5" /> {hint}</span>}
    </div>
    <div className="flex gap-2">
      {onCopy && <ActionBtn icon={Copy} label={copyLabel || 'Copy'} onClick={onCopy} />}
      {onDownload && <ActionBtn icon={Download} label={downloadLabel || 'Download'} onClick={onDownload} primary />}
    </div>
  </div>
);

const ActionBtn: React.FC<{ icon: React.ElementType; label: string; onClick: () => void; primary?: boolean }> = ({ icon: Icon, label, onClick, primary }) => (
  <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${primary ? 'bg-[#C74634] text-white hover:bg-[#b03d2d]' : 'bg-white border border-[#e8dcc9] text-[#2d241d] hover:border-[#c9b8a8]'}`}>
    <Icon className="w-3.5 h-3.5" /> {label}
  </button>
);

const Stat: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
  <div className={`rounded-lg border p-1.5 ${bad ? 'border-amber-300 bg-amber-50' : 'border-[#e8dcc9]'}`}>
    <div className="text-[10px] text-[#8a7668]">{label}</div>
    <div className="text-xs font-bold font-mono">{value}</div>
  </div>
);

const Check: React.FC<{ ok: boolean; text: string }> = ({ ok, text }) => (
  <li className={`flex items-center gap-1.5 ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />} {text}
  </li>
);

/** Banner image: pack gallery or an https URL. Uploaded files are preview-only (not stored as assets). */
const ImagePicker: React.FC<{ pack: ContentPack; label: string; value: string; onChange: (v: string) => void; allowNone?: boolean }> = ({ pack, label, value, onChange, allowNone }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const isUpload = value.startsWith('data:');
  return (
    <div>
      <div className="text-[11px] font-semibold mb-1">{label}</div>
      <div className="grid grid-cols-4 gap-1.5">
        {Object.entries(pack.images).map(([k, img]) => (
          <button key={k} onClick={() => onChange(img.url)} title={img.label} aria-pressed={value === img.url} className={`relative h-12 rounded-md overflow-hidden border-2 cursor-pointer bg-gradient-to-r from-[#2d241d] to-[#8d563b] ${value === img.url ? 'border-[#C74634] ring-2 ring-[#C74634]/30' : 'border-white'}`}>
            <img src={img.url.replace('w=1200', 'w=200')} alt={img.label} className="w-full h-full object-cover" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
          </button>
        ))}
        <button onClick={() => fileRef.current?.click()} className={`h-12 rounded-md border-2 border-dashed text-[10px] font-semibold flex flex-col items-center justify-center cursor-pointer ${isUpload ? 'border-[#C74634] text-[#C74634]' : 'border-[#d4bfa9] text-[#8a7668]'}`}>
          <Upload className="w-3.5 h-3.5" /> Preview
        </button>
        {allowNone && (
          <button onClick={() => onChange('')} aria-pressed={!value} className={`h-12 rounded-md border-2 text-[10px] font-semibold flex flex-col items-center justify-center cursor-pointer ${!value ? 'border-[#C74634] text-[#C74634]' : 'border-[#e8dcc9] text-[#8a7668]'}`}>
            <ImageOff className="w-3.5 h-3.5" /> None
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 1_500_000) return alert('Preview images must be under 1.5 MB.');
        const r = new FileReader();
        r.onload = () => onChange(String(r.result));
        r.readAsDataURL(file);
        e.target.value = '';
      }} />
      <input value={isUpload ? '' : value} onChange={(e) => onChange(e.target.value)} placeholder={isUpload ? 'Local preview image' : 'or paste an https image URL'} aria-label={`${label} URL`} className="mt-1.5 w-full text-[11px] rounded-lg border border-[#e8dcc9] px-2 py-1" />
      {isUpload && <div className="text-[10px] text-amber-700 mt-1">Local images are for preview only. Host the image in the Responsys Content Library and paste its https URL before requesting approval.</div>}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* AI change proposals                                                */
/* ------------------------------------------------------------------ */

type RefineTarget = 'all' | 'email' | 'sms' | 'push';
interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  files?: string[];
  target?: RefineTarget;
  error?: boolean;
  /** For a failed request: what to send again. */
  retry?: { prompt: string; target: RefineTarget };
  proposal?: { content: DraftContent; applied: { path: string; before: string; after: string }[]; rejected: { path: string; reason: string }[]; status: 'pending' | 'accepted' | 'discarded' };
}

const TARGETS: { v: RefineTarget; l: string; icon: React.ElementType }[] = [
  { v: 'all', l: 'All 3', icon: Sparkles },
  { v: 'email', l: 'Email', icon: Mail },
  { v: 'push', l: 'Push', icon: Bell },
  { v: 'sms', l: 'SMS', icon: MessageSquare },
];
const TEXT_FILE = /\.(csv|tsv|txt|json|md|html?|xml)$/i;

const RefinePanel: React.FC<{
  draftId: string | null;
  dirty: boolean;
  aiEnabled: boolean;
  profiles: ContentPack['profiles'];
  profileId: string;
  setProfileId: (v: string) => void;
  defaultTarget: RefineTarget;
  disabled: boolean;
  onAccept: (c: DraftContent) => void;
  onUndo: () => void;
  canUndo: boolean;
  chat: ChatMessage[];
  setChat: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Saves unsaved edits first, so the AI works on exactly what is on screen. */
  ensureSaved: () => Promise<string | null>;
  suggestions: string[];
}> = ({ draftId, dirty, aiEnabled, profiles, profileId, setProfileId, defaultTarget, disabled, onAccept, onUndo, canUndo, chat, setChat, ensureSaved, suggestions }) => {
  const [target, setTarget] = useState<RefineTarget>(defaultTarget);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.length, busy]);

  const addFiles = async (list: FileList | File[]) => {
    setNotice('');
    const ok: { name: string; text: string }[] = [];
    for (const f of Array.from(list).slice(0, 5 - files.length)) {
      if (!TEXT_FILE.test(f.name)) {
        setNotice('Only text files (CSV, TXT, JSON, HTML, MD) can be attached. Images and PDFs are not supported.');
        continue;
      }
      ok.push({ name: f.name.slice(0, 200), text: (await f.text()).slice(0, 40_000) });
    }
    setFiles((p) => [...p, ...ok]);
  };

  const run = async (again?: { prompt: string; target: RefineTarget }) => {
    const prompt = (again?.prompt ?? text).trim();
    const sendTarget = again?.target ?? target;
    if (!prompt || busy || disabled || !aiEnabled) return;
    const history = chat.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
    setChat((c) => [...c, { id: Date.now(), role: 'user', content: prompt, files: files.map((f) => f.name), target: sendTarget }]);
    setText('');
    const sent = files;
    setFiles([]);
    setBusy(true);
    try {
      const id = !draftId || dirty ? await ensureSaved() : draftId;
      if (!id) throw new Error('The draft could not be saved, so the AI was not asked. Check the message at the top of the builder and try again.');
      const out = await apiSend<{ reply: string; proposedContent: DraftContent; applied: { path: string; before: string; after: string }[]; rejected: { path: string; reason: string }[] }>('POST', `/drafts/${id}/ai-proposals`, { message: prompt, target: sendTarget, attachments: sent, history });
      setChat((c) => [...c, { id: Date.now() + 1, role: 'assistant', content: out.reply || (out.applied.length ? 'Here is a proposed change.' : 'No changes proposed.'), proposal: out.applied.length || out.rejected.length ? { content: out.proposedContent, applied: out.applied, rejected: out.rejected, status: out.applied.length ? 'pending' : 'discarded' } : undefined }]);
    } catch (e) {
      setChat((c) => [...c, { id: Date.now() + 1, role: 'assistant', content: (e as Error).message, error: true, retry: { prompt, target: sendTarget } }]);
    } finally {
      setBusy(false);
    }
  };
  const decide = (id: number, accept: boolean) => {
    setChat((c) =>
      c.map((m) => {
        if (m.id !== id || !m.proposal) return m;
        if (accept) onAccept(m.proposal.content);
        return { ...m, proposal: { ...m.proposal, status: accept ? 'accepted' : 'discarded' } };
      })
    );
  };

  return (
    <div className={`rounded-xl border bg-white border-[#e8dcc9] ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div className="p-3 border-b border-[#f0e6dc] flex items-start gap-2.5">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0 bg-gradient-to-br from-[#C74634] to-[#e11d48]"><Wand2 className="w-4 h-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">Refine with AI</div>
          <div className="text-[11px] text-[#8a7668]">Ask for changes in your own words. You review every change before it is applied; nothing is saved until you click Save draft.</div>
        </div>
        {canUndo && (
          <button onClick={onUndo} className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[#C74634] cursor-pointer"><Undo2 className="w-3 h-3" /> Undo</button>
        )}
      </div>
      <div className="p-3 space-y-3">
        <label className="flex items-center gap-2 rounded-lg bg-[#faf6f1] border border-[#eadfd2] px-2 py-1.5">
          <Users className="w-3.5 h-3.5 text-[#C74634] shrink-0" />
          <span className="text-[11px] font-semibold text-[#5f4d42] shrink-0">Preview profile</span>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="flex-1 min-w-0 text-[11px] bg-white border border-[#e8dcc9] rounded-md px-1.5 py-1">
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {!aiEnabled ? (
          <div className="text-[11px] rounded-lg bg-[#faf6f1] px-2.5 py-2 text-[#6b554d]">AI editing is not configured in this deployment. Edit fields directly, in the preview, or in RPL code.</div>
        ) : !draftId || dirty ? (
          <div className="text-[11px] rounded-lg bg-[#faf6f1] px-2.5 py-2 text-[#6b554d]">Your current edits are saved as a draft version before the AI reads them.</div>
        ) : null}
        {aiEnabled && (
          <div className="flex flex-wrap gap-1">
            {suggestions.map((x) => (
              <button key={x} type="button" onClick={() => setText(x)} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#faf6f1] border border-[#eadfd2] text-[#5f4d42] hover:border-[#C74634] text-left cursor-pointer">
                {x.length > 70 ? `${x.slice(0, 68)}…` : x}
              </button>
            ))}
          </div>
        )}
        <div ref={listRef} className="max-h-72 overflow-y-auto space-y-2" aria-live="polite">
          {chat.map((m) => (
            <div key={m.id} className={`flex gap-1.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && <Bot className="w-3.5 h-3.5 mt-1.5 shrink-0 text-[#C74634]" />}
              <div className={`max-w-[92%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-[#2d241d] text-white' : m.error ? 'bg-amber-50 text-amber-900 border border-amber-200' : 'bg-[#faf6f1] text-[#2d241d]'}`}>
                {m.content}
                {m.error && m.retry && (
                  <div className="mt-1.5">
                    <button type="button" onClick={() => void run(m.retry)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[10px] font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50 cursor-pointer">
                      <RotateCcw className="w-3 h-3" /> Send again
                    </button>
                  </div>
                )}
                {m.files && m.files.length > 0 && <div className="mt-1 text-[10px] opacity-75">📎 {m.files.join(', ')}</div>}
                {m.proposal && (
                  <div className="mt-2 space-y-1">
                    {m.proposal.applied.map((a) => (
                      <div key={a.path} className="rounded border border-[#e8dcc9] bg-white p-1.5">
                        <div className="font-mono text-[10px] text-[#8a7668]">{a.path}</div>
                        <div className="line-through text-rose-700">{a.before.slice(0, 200) || '(empty)'}</div>
                        <div className="text-emerald-800">{a.after.slice(0, 200) || '(empty)'}</div>
                      </div>
                    ))}
                    {m.proposal.rejected.map((r) => <div key={r.path} className="text-[10px] text-amber-800">Not applied · {r.path}: {r.reason}</div>)}
                    {m.proposal.status === 'pending' ? (
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => decide(m.id, true)} className="px-2 py-1 rounded bg-emerald-600 text-white text-[10px] font-bold cursor-pointer">Accept changes</button>
                        <button onClick={() => decide(m.id, false)} className="px-2 py-1 rounded border border-[#e8dcc9] text-[10px] font-bold cursor-pointer">Discard</button>
                      </div>
                    ) : (
                      <div className="text-[10px] font-semibold">{m.proposal.status === 'accepted' ? '✓ Applied to the editor (not saved yet)' : 'Discarded'}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && <div className="flex items-center gap-1.5 text-[11px] text-[#8a7668]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working on it…</div>}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-bold flex items-center gap-1"><Sparkles className="w-3.5 h-3.5 text-[#C74634]" /> Message</span>
            <div className="flex rounded-lg bg-[#f5eee6] p-0.5" role="tablist" aria-label="Apply to">
              {TARGETS.map((t) => (
                <button key={t.v} role="tab" aria-selected={target === t.v} onClick={() => setTarget(t.v)} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold cursor-pointer ${target === t.v ? 'bg-white shadow-sm text-[#2d241d]' : 'text-[#8a7668]'}`}>
                  <t.icon className="w-3 h-3" /> {t.l}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-xl border-2 border-[#eadfd2] focus-within:border-[#C74634] overflow-hidden">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
                {files.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 text-[10px] bg-[#faf6f1] border border-[#eadfd2] rounded-md pl-1 pr-1.5 py-0.5">
                    <FileText className="w-3.5 h-3.5 text-[#8a7668]" />
                    <span className="max-w-[120px] truncate" title={f.name}>{f.name}</span>
                    <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="cursor-pointer"><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={text}
              disabled={!aiEnabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run(); } }}
              rows={3}
              aria-label="Describe changes"
              placeholder="e.g. Make the SMS friendlier and shorter"
              className="w-full text-xs p-2.5 resize-none focus:outline-none disabled:bg-gray-50"
            />
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-[#faf6f1] border-t border-[#f0e6dc]">
              <div className="flex items-center gap-2">
                <button onClick={() => fileInput.current?.click()} disabled={files.length >= 5 || !aiEnabled} className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#5f4d42] hover:text-[#C74634] disabled:opacity-40 cursor-pointer" title="Attach a text brief (CSV, TXT, JSON, HTML, MD)">
                  <Paperclip className="w-3.5 h-3.5" /> Attach text
                </button>
                <input ref={fileInput} type="file" multiple hidden accept=".csv,.tsv,.txt,.json,.md,.html,.htm,.xml" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
                <span className="text-[10px] text-[#8a7668] hidden sm:inline-flex items-center gap-1">
                  <kbd className="inline-flex items-center gap-0.5 px-1 rounded border border-[#d4bfa9] bg-white">Enter <CornerDownLeft className="w-2.5 h-2.5" /></kbd> to send
                </span>
              </div>
              <button onClick={() => void run()} disabled={!text.trim() || busy || !aiEnabled} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#C74634] hover:bg-[#b03d2d] disabled:opacity-40 text-white text-[11px] font-bold cursor-pointer">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {busy ? 'Working…' : 'Propose changes'}
              </button>
            </div>
          </div>
          {notice && <div className="mt-1.5 text-[10px] text-amber-800">{notice}</div>}
        </div>
      </div>
    </div>
  );
};
