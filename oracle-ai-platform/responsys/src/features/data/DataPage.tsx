/**
 * Data sources: uploads and the import wizard, dataset versions with rollback, import history,
 * Responsys connections (admin), account settings, and workspace members.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, History, PlugZap, RefreshCw, RotateCcw, Settings, Trash2, Users } from 'lucide-react';
import { Button, Card, ErrorBox, Loading, Modal, Notice, Pill, TextInput, cx } from '../../components/ui';
import type { Account, Connection, Dataset, Session } from '../../lib/types';
import { apiGet, apiSend } from '../../lib/api';
import { invalidateAccountData, qk, useConnections, useImports } from '../../lib/queries';
import { addDays } from '../../../shared/time/zoned';
import { ImportWizard, UploadCard } from './ImportWizard';

export const SOURCE_LABEL: Record<string, string> = {
  upload_campaign_metrics: 'Campaign file',
  upload_legacy_summary: 'Account summary export',
  responsys_reporting: 'Responsys reporting',
};

function DatasetRow({ d, canEdit, onUse }: { d: Dataset; canEdit: boolean; onUse: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const versions = useQuery({ queryKey: ['versions', d.id], queryFn: () => apiGet<any[]>(`/datasets/${d.id}/versions`), enabled: open });
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      invalidateAccountData(qc, d.accountId);
      void qc.invalidateQueries({ queryKey: ['versions', d.id] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-bold text-[#2d241d] flex items-center gap-2">
            {d.name} <Pill>{SOURCE_LABEL[d.sourceType]}</Pill>
            {d.activeVersionId ? <Pill tone="good">Active v{d.activeVersion}</Pill> : <Pill tone="neutral">Not in use</Pill>}
          </div>
          <div className="text-[11px] text-[#6b554d]">
            {d.coverageStart && d.coverageEndExclusive ? `Covers ${d.coverageStart} – ${addDays(d.coverageEndExclusive, -1)} · ` : ''}
            {d.rowCount !== null ? `${d.rowCount} rows · ` : ''}
            {d.currency ?? ''} {d.sourceAsOf ? `· source as of ${d.sourceAsOf.slice(0, 10)}` : ''} {d.activatedAt ? `· activated ${new Date(d.activatedAt).toLocaleString()}` : ''}
          </div>
          {(d.quality?.conflicts?.length ?? 0) > 0 && <div className="text-[11px] text-rose-700">{d.quality!.conflicts!.length} data-quality conflict(s) — see report warnings</div>}
        </div>
        <div className="flex gap-2">
          {d.activeVersionId && <Button onClick={onUse}>View report</Button>}
          <Button variant="ghost" icon={History} onClick={() => setOpen((o) => !o)}>{open ? 'Hide versions' : 'Versions'}</Button>
          {canEdit && d.activeVersionId && <Button variant="danger" icon={Trash2} onClick={() => setConfirm(true)}>Stop using</Button>}
        </div>
      </div>
      {open && (
        <div className="mt-2 rounded-xl border border-[#e8dcc9] bg-white p-2">
          {versions.isLoading && <Loading />}
          <table className="w-full text-xs">
            <tbody>
              {versions.data?.map((v) => (
                <tr key={v.id} className="border-t border-gray-100 first:border-0">
                  <td className="py-1.5 pr-2 font-mono">v{v.version}</td>
                  <td className="pr-2"><Pill tone={v.status === 'active' ? 'good' : 'neutral'}>{v.status}</Pill></td>
                  <td className="pr-2">{v.fileName ?? 'Responsys sync'} {v.sha256 ? <span className="font-mono text-[10px] text-[#8a7668]">{v.sha256.slice(0, 10)}</span> : null}</td>
                  <td className="pr-2">{v.rowCount} rows</td>
                  <td className="pr-2">{new Date(v.createdAt).toLocaleString()}</td>
                  <td className="text-right">
                    {canEdit && ['superseded', 'deactivated'].includes(v.status) && (
                      <Button variant="ghost" icon={RotateCcw} busy={busy} onClick={() => act(() => apiSend('POST', `/datasets/${d.id}/rollback`, { versionId: v.id }))}>Restore</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error ? <ErrorBox error={error} /> : null}
      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Stop using "${d.name}"?`}>
        <p className="text-xs">Reports will no longer use this data source. Its versions and the original files are kept as evidence, and you can restore a version later. No data is deleted.</p>
        <div className="mt-4 flex gap-2">
          <Button variant="danger" busy={busy} onClick={() => act(() => apiSend('POST', `/datasets/${d.id}/deactivate`))}>Stop using</Button>
          <Button onClick={() => setConfirm(false)}>Keep it</Button>
        </div>
      </Modal>
    </li>
  );
}

export function ConnectionsCard({ account, canManage, canSync }: { account: Account; canManage: boolean; canSync: boolean }) {
  const qc = useQueryClient();
  const conns = useConnections(account.id);
  const [form, setForm] = useState({ displayName: 'Responsys', loginBaseUrl: '', credentialRef: 'file:main' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (msg) setNote(msg);
      void qc.invalidateQueries({ queryKey: qk.connections(account.id) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><PlugZap className="w-4 h-4 text-[#C74634]" />Responsys connection</span>} subtitle="Read-only API access for campaign reporting and Connect job diagnostics. Credentials stay on the server.">
      {conns.isLoading && <Loading />}
      {conns.error ? <ErrorBox error={conns.error} /> : null}
      {conns.data?.length === 0 && <p className="text-xs text-[#6b554d] mb-3">No connection configured. Uploads work without one.</p>}
      <ul className="space-y-3">
        {conns.data?.map((c: Connection) => (
          <li key={c.id} className="rounded-xl border border-[#e8dcc9] bg-white p-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>{c.displayName}</strong> <Pill tone={c.status === 'available' ? 'good' : c.status === 'denied' || c.status === 'unavailable' ? 'bad' : c.status === 'degraded' ? 'warn' : 'neutral'}>{c.status.replace('_', ' ')}</Pill>
                <div className="text-[11px] text-[#6b554d]">
                  {c.loginBaseUrl ? `${c.loginBaseUrl} · secret ref ${c.credentialRef} · ` : ''}
                  last checked {c.lastCheckedAt ? new Date(c.lastCheckedAt).toLocaleString() : 'never'} · last successful sync {c.lastSuccessfulSyncAt ? new Date(c.lastSuccessfulSyncAt).toLocaleString() : 'never'}
                </div>
              </div>
              <div className="flex gap-2">
                {canManage && <Button busy={busy === `t${c.id}`} onClick={() => run(`t${c.id}`, () => apiSend('POST', `/connections/${c.id}/test`), 'Connection test queued. The status updates when the check finishes.')}>Test connection</Button>}
                {canSync && <Button icon={RefreshCw} disabled={!['available', 'degraded'].includes(c.status)} busy={busy === `s${c.id}`} onClick={() => run(`s${c.id}`, () => apiSend('POST', `/connections/${c.id}/sync`), 'Sync queued. Reporting requests can take minutes; new data appears automatically when it is activated.')}>Sync now</Button>}
                {canManage && (
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={c.syncEnabled} onChange={(e) => run(`e${c.id}`, () => apiSend('PATCH', `/connections/${c.id}`, { syncEnabled: e.target.checked }))} />
                    Scheduled sync
                  </label>
                )}
              </div>
            </div>
            {c.lastError && <div className="text-rose-700">Last error: {c.lastError}</div>}
            {Object.keys(c.capabilities ?? {}).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(c.capabilities).map(([k, v]) => (
                  <Pill key={k} tone={v.status === 'available' ? 'good' : v.status === 'denied' ? 'bad' : v.status === 'unverified' ? 'info' : 'warn'} title={v.detail ?? undefined}>
                    {k.replace('_', ' ')}: {v.status}
                  </Pill>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <form
          className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run('add', () => apiSend('POST', `/accounts/${account.id}/connections`, form), 'Connection saved. Run "Test connection" to check each API capability.');
          }}
        >
          <TextInput label="Name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <TextInput label="Login URL" placeholder="https://login5.responsys.net" value={form.loginBaseUrl} onChange={(e) => setForm({ ...form, loginBaseUrl: e.target.value })} hint="Your pod's login host (HTTPS)" />
          <TextInput label="Server secret reference" value={form.credentialRef} onChange={(e) => setForm({ ...form, credentialRef: e.target.value })} hint="file:main uses the main entry in the configured local credentials file" />
          <Button type="submit" variant="primary" busy={busy === 'add'}>Add connection</Button>
        </form>
      )}
      {note && <div className="mt-2"><Notice tone="good">{note}</Notice></div>}
      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
      <p className="mt-3 text-[11px] text-[#8a7668]">Store the API username and password in the local credentials file or server environment. This page uses only the secret reference. See docs/RESPONSYS_SETUP.md.</p>
    </Card>
  );
}

function SettingsCard({ account }: { account: Account }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: account.name,
    timezone: account.timezone,
    currency: account.currency,
    brandName: account.brand?.name ?? '',
    senderName: account.brand?.senderName ?? '',
    domain: account.brand?.domain ?? '',
    allowed: (account.brand?.allowedLinkDomains ?? []).join(', '),
    contentPack: account.contentPack,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await apiSend('PATCH', `/accounts/${account.id}`, {
        name: f.name,
        timezone: f.timezone,
        currency: f.currency,
        brand: { name: f.brandName || undefined, senderName: f.senderName || undefined, domain: f.domain || undefined, allowedLinkDomains: f.allowed.split(',').map((s) => s.trim()).filter(Boolean) },
        contentPack: f.contentPack,
      });
      setSaved(true);
      invalidateAccountData(qc, account.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Settings className="w-4 h-4 text-[#C74634]" />Account settings</span>} subtitle="Timezone and currency define report periods and money values.">
      <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <TextInput label="Account name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextInput label="Timezone (IANA)" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
        <TextInput label="Currency" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
        <TextInput label="Brand name (creative)" value={f.brandName} onChange={(e) => setF({ ...f, brandName: e.target.value })} />
        <TextInput label="Sender name" value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} />
        <TextInput label="Website domain" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="example.com" />
        <TextInput label="Allowed link domains" value={f.allowed} onChange={(e) => setF({ ...f, allowed: e.target.value })} hint="Comma-separated; links elsewhere get a warning" />
        <label className="text-xs font-bold">Template pack
          <select value={f.contentPack} onChange={(e) => setF({ ...f, contentPack: e.target.value as Account['contentPack'] })} className="mt-1 w-full rounded-lg border border-[#e8dcc9] px-2 py-2 font-normal">
            <option value="starter">Starter pack (neutral, uses your brand settings)</option>
            <option value="amil_example">Example pack: Amil Dental (sample content from the original files)</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="primary" busy={busy}>Save settings</Button>
          {saved && <span className="text-xs text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Saved</span>}
        </div>
      </form>
      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
    </Card>
  );
}

function MembersCard() {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: qk.members, queryFn: () => apiGet<any[]>('/workspace/members') });
  const [f, setF] = useState({ email: '', role: 'analyst', execute: false });
  const [error, setError] = useState<unknown>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiSend('POST', '/workspace/members', { email: f.email, role: f.role, grants: f.execute ? ['action.execute'] : [] });
      setF({ email: '', role: 'analyst', execute: false });
      void qc.invalidateQueries({ queryKey: qk.members });
    } catch (err) {
      setError(err);
    }
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      await apiSend('DELETE', `/workspace/members/${id}`);
      void qc.invalidateQueries({ queryKey: qk.members });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Users className="w-4 h-4 text-[#C74634]" />Members &amp; roles</span>} subtitle="Viewer: read reports · Analyst: import data, scenarios · Marketer: drafts · Approver: approve versions · Owner: settings. Sending needs an explicit grant.">
      {members.isLoading && <Loading />}
      <table className="w-full text-xs">
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.userId} className="border-t border-gray-100">
              <td className="py-1.5">{m.email}</td>
              <td><Pill>{m.role}</Pill> {m.grants?.map((g: string) => <Pill key={g} tone="warn">{g}</Pill>)}</td>
              <td className="text-right"><Button variant="ghost" onClick={() => remove(m.userId)}>Remove</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-64"><TextInput label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <label className="text-xs font-bold">Role
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, execute: false })} className="block mt-1 rounded-lg border border-[#e8dcc9] px-2 py-2 font-normal">
            {['viewer', 'analyst', 'marketer', 'approver', 'owner'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        {['marketer', 'approver', 'owner'].includes(f.role) && (
          <label className="text-xs flex items-center gap-1 pb-2"><input type="checkbox" checked={f.execute} onChange={(e) => setF({ ...f, execute: e.target.checked })} /> May execute approved external actions</label>
        )}
        <Button type="submit" variant="primary">Add member</Button>
      </form>
      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
    </Card>
  );
}

export const DataPage: React.FC<{ account: Account; datasets: Dataset[]; perms: Set<string>; session: Session; onUseDataset: (datasetId: string | null) => void; showUpload?: boolean }> = ({ account, datasets, perms, session, onUseDataset, showUpload = true }) => {
  const imports = useImports(account.id);
  const [wizard, setWizard] = useState<string | null>(null);
  const canImport = perms.has('data.import');
  const pending = imports.data?.filter((i) => ['needs_mapping', 'ready_to_commit', 'committing'].includes(i.status)) ?? [];
  return (
    <div className="space-y-6">
      {!showUpload ? null : canImport ? (
        <UploadCard account={account} maxBytes={session.features.uploadMaxBytes} onUploaded={(imp) => setWizard(imp.id)} />
      ) : (
        <Notice>Your role ({session.workspace?.role}) can view data sources but cannot import files.</Notice>
      )}
      {wizard && (
        <Card title="Import" tone="white" right={<Button variant="ghost" onClick={() => setWizard(null)}>Close</Button>}>
          <ImportWizard
            key={wizard}
            account={account}
            importId={wizard}
            datasets={datasets}
            onClose={() => setWizard(null)}
            onDone={(datasetId) => {
              setWizard(null);
              onUseDataset(datasetId);
            }}
          />
        </Card>
      )}
      {!wizard && pending.length > 0 && (
        <Notice tone="warn">
          {pending.length} import(s) need attention:{' '}
          {pending.map((p) => (
            <button key={p.id} className="underline font-semibold mr-2 cursor-pointer" onClick={() => setWizard(p.id)}>{p.fileName}</button>
          ))}
        </Notice>
      )}

      <Card title="Data sources" subtitle="Each report uses exactly one data source. Sources are never added together.">
        {datasets.length === 0 ? <p className="text-xs text-[#6b554d]">No data sources yet.</p> : (
          <ul className="divide-y divide-[#eadfd2]">
            {datasets.map((d) => <DatasetRow key={d.id} d={d} canEdit={canImport} onUse={() => onUseDataset(d.id)} />)}
          </ul>
        )}
      </Card>

      <Card title="Import history" tone="white">
        {imports.isLoading && <Loading />}
        {imports.data?.length === 0 && <p className="text-xs text-[#6b554d]">No uploads yet.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {imports.data?.map((i) => (
                <tr key={i.id} className="border-t border-gray-100">
                  <td className="py-1.5 pr-2 font-semibold">{i.fileName}</td>
                  <td className="pr-2"><Pill tone={i.status === 'completed' ? 'good' : i.status === 'failed' ? 'bad' : 'neutral'}>{i.status.replace(/_/g, ' ')}</Pill></td>
                  <td className="pr-2">{i.format.replace('_', ' ')}</td>
                  <td className="pr-2">{new Date(i.createdAt).toLocaleString()}</td>
                  <td className="pr-2">{i.createdByEmail}</td>
                  <td className={cx('pr-2', i.status === 'failed' && 'text-rose-700')}>{i.duplicateOf ? 'Already imported' : i.errorMessage ?? ''}</td>
                  <td>{['needs_mapping', 'ready_to_commit', 'committing'].includes(i.status) && canImport && <Button variant="ghost" onClick={() => setWizard(i.id)}>Continue</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {(perms.has('workspace.manage') || perms.has('data.import')) && <ConnectionsCard account={account} canManage={perms.has('workspace.manage')} canSync={perms.has('data.import')} />}
      {perms.has('workspace.manage') && <SettingsCard key={account.id + account.dataRevision} account={account} />}
      {perms.has('workspace.manage') && <MembersCard />}
    </div>
  );
};
