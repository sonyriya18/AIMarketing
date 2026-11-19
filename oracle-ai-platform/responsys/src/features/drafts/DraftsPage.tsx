/**
 * Drafts and approvals. A draft is authored content with immutable versions; approvals bind to
 * one version; execution re-checks everything and is blocked while kill switches are off or no
 * verified Responsys write capability exists. Nothing here reports a send that did not happen.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Mail, MessageSquare, Bell, PenSquare, Plus, ShieldCheck, XCircle } from 'lucide-react';
import { Button, Card, Empty, ErrorBox, Loading, Modal, Notice, Pill, TextInput } from '../../components/ui';
import { CampaignBuilder, type BuilderInput } from '../../components/CampaignBuilder';
import type { Account, Session } from '../../lib/types';
import { apiGet, apiSend } from '../../lib/api';
import { qk } from '../../lib/queries';
import { TOPIC_LABEL, type CampaignTopic, type TemplateChannel } from '../../data/amilTemplates';

const ACTION_LABEL: Record<string, string> = {
  provider_draft_create: 'Create campaign in Responsys',
  proof_send: 'Send proof',
  live_schedule: 'Schedule live launch',
};

function NewDraftModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (v: { name: string; channel: TemplateChannel; topic: CampaignTopic }) => void }) {
  const [name, setName] = useState(`Draft ${new Date().toISOString().slice(0, 10)}`);
  const [channel, setChannel] = useState<TemplateChannel>('Email');
  const [topic, setTopic] = useState<CampaignTopic>('promo');
  return (
    <Modal open={open} onClose={onClose} title="New draft">
      <div className="space-y-3 text-xs">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <fieldset>
          <legend className="font-bold">Primary channel</legend>
          <div className="flex gap-2 mt-1">
            {(['Email', 'SMS', 'WebPush'] as TemplateChannel[]).map((c) => (
              <label key={c} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${channel === c ? 'border-[#C74634] bg-white' : 'border-[#e8dcc9]'}`}>
                <input type="radio" className="mr-1" checked={channel === c} onChange={() => setChannel(c)} />{c}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block font-bold">Topic (picks starting templates)
          <select value={topic} onChange={(e) => setTopic(e.target.value as CampaignTopic)} className="mt-1 block w-full rounded border border-[#e8dcc9] px-2 py-1.5 font-normal">
            {(Object.keys(TOPIC_LABEL) as CampaignTopic[]).map((t) => <option key={t} value={t}>{TOPIC_LABEL[t]}</option>)}
          </select>
        </label>
        <Button variant="primary" onClick={() => onCreate({ name, channel, topic })}>Open the builder</Button>
        <p className="text-[11px] text-[#6b554d]">The draft is saved only when you click "Save draft" in the builder.</p>
      </div>
    </Modal>
  );
}

function DraftDetail({ id, perms, killSwitches, onOpen }: { id: string; perms: Set<string>; killSwitches: Record<string, boolean>; onOpen: (d: any) => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: qk.draft(id), queryFn: () => apiGet<any>(`/drafts/${id}`) });
  const [action, setAction] = useState('proof_send');
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg?: (out: any) => string) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const out = await fn();
      if (msg) setNote(msg(out));
      void qc.invalidateQueries({ queryKey: qk.draft(id) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  if (d.isLoading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const x = d.data;
  const v = x.current;
  const switchFor = (a: string) => (a === 'provider_draft_create' ? killSwitches.providerDraftWrites : a === 'proof_send' ? killSwitches.proofSends : killSwitches.liveCampaignSends);
  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-base font-bold text-[#2d241d]">{x.name}</div>
          <div className="text-[#6b554d]">{x.primaryChannel} · version {x.currentVersion} · updated {new Date(x.updatedAt).toLocaleString()} · by {x.createdByEmail}</div>
        </div>
        <div className="flex gap-2">
          <Pill tone={v?.validation?.passed ? 'good' : 'bad'}>{v?.validation?.passed ? 'Local checks passed' : 'Local checks failing'}</Pill>
          <Button variant="primary" icon={PenSquare} onClick={() => onOpen(x)}>{perms.has('draft.edit') ? 'Edit' : 'View'}</Button>
        </div>
      </div>
      <Notice>This is a draft (authored content). It is not a Responsys campaign, has not been sent, and has no performance data.</Notice>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#e8dcc9] bg-white p-3">
          <div className="font-bold mb-2">Version history</div>
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {x.versions.map((ver: any) => (
              <li key={ver.id} className="flex justify-between gap-2">
                <span><span className="font-mono">v{ver.version}</span> · {ver.changeNote ?? ver.origin}{ver.origin === 'ai_accepted' && <Pill tone="scenario">AI-assisted</Pill>}</span>
                <span className="text-[#8a7668]">{new Date(ver.createdAt).toLocaleString()} · {ver.createdByEmail}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-[#e8dcc9] bg-white p-3 space-y-2">
          <div className="font-bold flex items-center gap-1"><ShieldCheck className="w-4 h-4 text-[#C74634]" /> Approvals</div>
          {perms.has('draft.edit') && (
            <div className="flex flex-wrap items-end gap-2">
              <label>Action
                <select value={action} onChange={(e) => setAction(e.target.value)} className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1">
                  {Object.entries(ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              {action === 'proof_send' && <label>Proof recipient<input type="email" value={proof} onChange={(e) => setProof(e.target.value)} placeholder="qa@company.com" className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1" /></label>}
              <Button busy={busy === 'req'} onClick={() => run('req', () => apiSend('POST', `/drafts/${id}/approvals`, { actionType: action, params: action === 'proof_send' && proof ? { proofRecipients: [proof] } : {} }), () => 'Approval requested for the current version. Any edit will invalidate it.')}>
                Request approval of v{x.currentVersion}
              </Button>
            </div>
          )}
          <ul className="space-y-2">
            {x.approvals.map((a: any) => (
              <li key={a.id} className="rounded-lg border border-[#eadfd2] p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><strong>{ACTION_LABEL[a.actionType]}</strong> · v{a.version} · requested by {a.requestedByEmail}</span>
                  <Pill tone={a.status === 'approved' ? 'good' : a.status === 'pending' ? 'info' : 'bad'}>{a.status}</Pill>
                </div>
                {a.decidedByEmail && <div className="text-[#6b554d]">Decided by {a.decidedByEmail}{a.decisionNote ? `: ${a.decisionNote}` : ''}</div>}
                <div className="flex flex-wrap gap-2 mt-1">
                  {a.status === 'pending' && perms.has('approval.decide') && (
                    <>
                      <Button icon={CheckCircle2} busy={busy === `a${a.id}`} onClick={() => run(`a${a.id}`, () => apiSend('POST', `/approvals/${a.id}/decision`, { decision: 'approve' }), () => 'Approved.')}>Approve</Button>
                      <Button variant="danger" icon={XCircle} onClick={() => run(`r${a.id}`, () => apiSend('POST', `/approvals/${a.id}/decision`, { decision: 'reject' }), () => 'Rejected.')}>Reject</Button>
                    </>
                  )}
                  {a.status === 'approved' && (
                    <>
                      <Button
                        variant="primary"
                        disabled={!perms.has('action.execute')}
                        busy={busy === `x${a.id}`}
                        onClick={() => run(`x${a.id}`, () => apiSend('POST', `/approvals/${a.id}/execute`, { idempotencyKey: `${a.id}-${crypto.randomUUID()}` }, { allowConflictBody: true }), (out) => (out.status === 'blocked' ? `Not executed: ${out.error}` : `Operation ${out.status}`))}
                      >
                        {ACTION_LABEL[a.actionType]}
                      </Button>
                      {!switchFor(a.actionType) && <span className="text-[11px] text-amber-800 self-center">Disabled in this deployment (kill switch off)</span>}
                      {!perms.has('action.execute') && <span className="text-[11px] text-[#6b554d] self-center">Needs the explicit "execute actions" grant</span>}
                    </>
                  )}
                </div>
              </li>
            ))}
            {x.approvals.length === 0 && <li className="text-[#6b554d]">No approval requests yet.</li>}
          </ul>
          {x.operations.length > 0 && (
            <div>
              <div className="font-bold mt-2">External operations</div>
              <ul>{x.operations.map((o: any) => <li key={o.id}>{ACTION_LABEL[o.operationType]} · <Pill tone={o.status === 'confirmed' ? 'good' : 'bad'}>{o.status}</Pill> {o.error}</li>)}</ul>
            </div>
          )}
        </div>
      </div>
      {note && <Notice tone={note.startsWith('Not executed') ? 'warn' : 'good'}>{note}</Notice>}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  );
}

export const DraftsPanel: React.FC<{ account: Account; perms: Set<string>; session: Session; initialBuilder?: Omit<BuilderInput, 'account'> | null }> = ({ account, perms, session, initialBuilder }) => {
  const qc = useQueryClient();
  const drafts = useQuery({ queryKey: qk.drafts(account.id), queryFn: () => apiGet<any[]>(`/accounts/${account.id}/drafts`) });
  const [newOpen, setNewOpen] = useState(false);
  const [builder, setBuilder] = useState<BuilderInput | null>(initialBuilder ? { account, ...initialBuilder } : null);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? drafts.data?.[0]?.id ?? null;
  const update = (p: { draftId: string }) => setPicked(p.draftId);

  const openExisting = (d: any) =>
    setBuilder({ account, draftId: d.id, version: d.currentVersion, name: d.name, primaryChannel: d.primaryChannel, content: d.current.content, topic: 'promo', sourceNote: d.source?.note, plan: d.source?.plan });

  return (
    <div className="space-y-6">
      <Card
        title="Campaign drafts"
        subtitle="Durable drafts with version history. Saving a draft never sends anything."
        right={perms.has('draft.edit') ? <Button variant="primary" icon={Plus} onClick={() => setNewOpen(true)}>New draft</Button> : undefined}
      >
        {drafts.isLoading && <Loading />}
        {drafts.error ? <ErrorBox error={drafts.error} /> : null}
        {drafts.data?.length === 0 && <Empty icon={PenSquare} title="No drafts yet">Create a draft from scratch or from the AI Simulator.</Empty>}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {drafts.data?.map((d) => {
            const Icon = d.primaryChannel === 'Email' ? Mail : d.primaryChannel === 'SMS' ? MessageSquare : Bell;
            return (
              <button key={d.id} onClick={() => update({ draftId: d.id })} className={`text-left p-3 rounded-xl border cursor-pointer ${selected === d.id ? 'border-[#C74634] bg-white' : 'border-[#e8dcc9] bg-[#faf6f1]'}`}>
                <div className="flex items-center gap-2 text-sm font-bold text-[#2d241d]"><Icon className="w-4 h-4 text-[#C74634]" />{d.name}</div>
                <div className="text-[11px] text-[#6b554d]">v{d.currentVersion} · {new Date(d.updatedAt).toLocaleString()}</div>
              </button>
            );
          })}
        </div>
      </Card>
      {selected && (
        <Card title="Draft details" tone="white">
          <DraftDetail id={selected} perms={perms} killSwitches={session.features.killSwitches} onOpen={openExisting} />
        </Card>
      )}
      <NewDraftModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={(v) => {
          setNewOpen(false);
          setBuilder({ account, draftId: null, version: null, name: v.name, primaryChannel: v.channel, content: null, topic: v.topic });
        }}
      />
      {builder && (
        <CampaignBuilder
          input={builder}
          canEdit={perms.has('draft.edit')}
          aiEnabled={session.features.aiProvider !== 'none' && perms.has('ai.use')}
          onClose={() => setBuilder(null)}
          onSaved={(draftId) => {
            void qc.invalidateQueries({ queryKey: qk.drafts(account.id) });
            void qc.invalidateQueries({ queryKey: qk.draft(draftId) });
            update({ draftId });
          }}
        />
      )}
    </div>
  );
};
