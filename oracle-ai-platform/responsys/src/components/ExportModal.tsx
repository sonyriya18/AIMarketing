/**
 * Save Report: every format is produced from the same immutable snapshot shown on screen —
 * the Summary, the analysed campaign, or the comparison — with scope, revision and definitions.
 */
import React, { useState } from 'react';
import { CheckCircle2, FileDown, FileJson, FileSpreadsheet, FileText } from 'lucide-react';
import { ErrorBox, Modal } from './ui';
import { apiDownload } from '../lib/api';
import { exportSnapshotPdf, type AnyReport } from '../utils/pdfReport';

const TITLE: Record<string, string> = { overview: 'Account Performance Summary', campaign: 'Single Campaign Deep-Dive', comparison: 'Campaign Comparison' };

export const ExportModal: React.FC<{ isOpen: boolean; report: AnyReport | null; onClose: () => void }> = ({ isOpen, report, onClose }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!isOpen || !report) return null;
  const id = report.meta.reportId;
  const get = async (format: 'csv' | 'json' | 'md') => {
    setBusy(format);
    setError(null);
    try {
      await apiDownload(`/reports/${id}/export?format=${format}`, `report-${report.meta.kind}-${id.slice(0, 8)}.${format}`);
      setDone(format.toUpperCase());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const options: { key: string; label: string; sub: string; icon: React.ElementType; run: () => void }[] = [
    { key: 'pdf', label: 'PDF report', sub: 'Formatted report to share or print', icon: FileDown, run: () => { exportSnapshotPdf(report); setDone('PDF'); } },
    { key: 'csv', label: 'CSV (spreadsheet-safe)', sub: 'Every metric and finding, for Excel', icon: FileSpreadsheet, run: () => void get('csv') },
    { key: 'md', label: 'Markdown', sub: 'Readable text summary', icon: FileText, run: () => void get('md') },
    { key: 'json', label: 'JSON (with lineage)', sub: 'Full snapshot with evidence', icon: FileJson, run: () => void get('json') },
  ];
  return (
    <Modal open onClose={onClose} title="Save Report">
      <div className="space-y-3 text-xs text-[#2d241d]">
        <div className="rounded-xl border border-[#e8dcc9] bg-[#fffaf5] p-3">
          <div className="text-[10px] uppercase tracking-wider font-bold text-[#8d563b]">{TITLE[report.meta.kind]}</div>
          <div className="font-semibold">{report.period?.label ?? 'Selected period'} · {report.source.datasetName}</div>
          <div className="text-[11px] text-[#6b554d]">Report <span className="font-mono">{id.slice(0, 8)}</span> · data revision {report.meta.dataRevision} — exactly the values on screen, with definitions and limitations.</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {options.map((o) => (
            <button key={o.key} type="button" onClick={o.run} disabled={busy !== null} className="text-left flex items-start gap-2.5 p-3 rounded-xl border border-[#e8dcc9] bg-white hover:border-[#C74634]/50 disabled:opacity-50">
              <o.icon className="w-5 h-5 text-[#C74634] shrink-0" />
              <span>
                <span className="block font-bold">{busy === o.key ? 'Preparing…' : o.label}</span>
                <span className="block text-[11px] text-[#6b554d]">{o.sub}</span>
              </span>
            </button>
          ))}
        </div>
        {done && <div className="flex items-center gap-2 text-emerald-800"><CheckCircle2 className="w-4 h-4" /> {done} downloaded.</div>}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </Modal>
  );
};
