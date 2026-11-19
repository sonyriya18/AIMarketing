/**
 * "Upload an export" card (Summary page), in the original design. Uploading opens the import
 * wizard; data becomes active only after validation and server-side activation.
 */
import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import type { Account, Dataset, ImportRecord, Session } from '../lib/types';
import { apiUpload } from '../lib/api';
import { useImports } from '../lib/queries';
import { ImportWizard } from '../features/data/ImportWizard';
import { DataPage, SOURCE_LABEL } from '../features/data/DataPage';
import { Modal } from './ui';
import { addDays } from '../../shared/time/zoned';

const TEMPLATE_HEADERS = ['Campaign ID', 'Campaign Name', 'Launch ID', 'Channel', 'Launch Date', 'Launch Time', 'Program', 'Subject Line', 'Creative Type', 'Offer', 'Currency', 'Sent', 'Delivered', 'Bounces', 'Unique Opens', 'Total Opens', 'Unique Clicks', 'Total Clicks', 'Conversions', 'Orders', 'Revenue', 'Unsubscribes', 'Complaints'];

interface Props {
  account: Account;
  session: Session;
  perms: Set<string>;
  datasets: Dataset[];
  active: Dataset | null;
  onUseDataset: (datasetId: string | null) => void;
  compact?: boolean;
  manageOpen: boolean;
  setManageOpen: (open: boolean) => void;
}

export const UploadExport: React.FC<Props> = ({ account, session, perms, datasets, active, onUseDataset, compact, manageOpen: manage, setManageOpen: setManage }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<string | null>(null);
  const imports = useImports(account.id);
  const canImport = perms.has('data.import');
  const pending = (imports.data ?? []).filter((i) => ['needs_mapping', 'ready_to_commit', 'committing'].includes(i.status));
  const maxMb = (session.features.uploadMaxBytes / 1_000_000).toFixed(0);

  const handleFile = async (file?: File) => {
    if (!file) return;
    setError(null);
    if (file.size > session.features.uploadMaxBytes) {
      setError(`This file is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is ${maxMb} MB.`);
      return;
    }
    setUploading(true);
    try {
      const imp = await apiUpload<ImportRecord>(`/accounts/${account.id}/imports`, file);
      setWizard(imp.id);
    } catch (e) {
      setError((e as Error).message || 'Upload failed.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([`${TEMPLATE_HEADERS.join(',')}\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'campaign-metrics-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const coverage = active?.coverageStart && active.coverageEndExclusive ? `${active.coverageStart} – ${addDays(active.coverageEndExclusive, -1)}` : null;

  return (
    <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-[#C74634] text-white flex items-center justify-center shrink-0"><FileSpreadsheet className="w-4.5 h-4.5" /></span>
          <div>
            <h3 className="text-base font-bold text-[#2d241d]">Upload an export</h3>
            <p className="text-xs text-[#6b554d]">Campaign Performance report or campaign metrics file · CSV · up to {maxMb} MB · for {account.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[#e8dcc9] hover:border-[#C74634]/50 text-[#2d241d]">
            <Download className="w-3.5 h-3.5 text-[#C74634]" /> Template
          </button>
          <button type="button" onClick={() => setManage(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[#e8dcc9] hover:border-[#C74634]/50 text-[#2d241d]">
            <Database className="w-3.5 h-3.5 text-[#C74634]" /> Data &amp; connections
          </button>
        </div>
      </div>

      {canImport ? (
        !compact && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => !uploading && inputRef.current?.click()}
            onKeyDown={(e) => { if (!uploading && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (!uploading) void handleFile(e.dataTransfer.files?.[0]); }}
            className={`mt-4 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors ${uploading ? 'cursor-wait opacity-70' : 'cursor-pointer'} ${dragging ? 'border-[#C74634] bg-[#fdf0eb]' : 'border-[#dcc7b0] bg-white hover:border-[#C74634]/60'}`}
          >
            {uploading ? <Loader2 className="w-7 h-7 mx-auto text-[#C74634] animate-spin" /> : <Upload className="w-7 h-7 mx-auto text-[#C74634]" />}
            <p className="mt-2 text-sm font-semibold text-[#2d241d]">{uploading ? 'Uploading your file…' : 'Drop your CSV here or click to browse'}</p>
            <p className="mt-1 text-[11px] text-[#8a7668] font-mono">Responsys → Insight → Campaign Performance → Export</p>
          </div>
        )
      ) : (
        <p className="mt-3 text-xs text-[#6b554d]">Your role ({session.workspace?.role}) can view data but cannot import files.</p>
      )}
      <input id="file-input" ref={inputRef} type="file" accept=".csv,.tsv,.txt,text/csv" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
      {compact && canImport && (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#C74634] text-white disabled:opacity-50">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload a new file
        </button>
      )}

      {error && (
        <div className="mt-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-rose-700" aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {pending.length > 0 && !wizard && (
        <div className="mt-3 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
          {pending.length} import(s) need attention:{' '}
          {pending.map((p) => <button key={p.id} className="underline font-semibold mr-2" onClick={() => setWizard(p.id)}>{p.fileName}</button>)}
        </div>
      )}
      {active && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#4d4039]">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>
            Using <strong>{active.name}</strong> · {SOURCE_LABEL[active.sourceType] ?? active.sourceType} · version {active.activeVersion}
            {coverage ? ` · covers ${coverage}` : ''}
            {active.rowCount !== null ? ` · ${active.rowCount.toLocaleString()} rows` : ''}
          </span>
        </div>
      )}

      <Modal open={Boolean(wizard)} onClose={() => setWizard(null)} title="Import your file" wide>
        {wizard && (
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
        )}
      </Modal>
      <Modal open={manage} onClose={() => setManage(false)} title="Data sources & Responsys connection" wide>
        <DataPage account={account} datasets={datasets} perms={perms} session={session} showUpload={false} onUseDataset={(id) => { setManage(false); onUseDataset(id); }} />
      </Modal>
    </section>
  );
};
