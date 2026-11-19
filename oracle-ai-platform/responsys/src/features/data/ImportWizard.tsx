/**
 * Import wizard: upload → inspect → confirm meaning → validate → commit → result.
 * "Uploaded" only means the bytes were stored; success is shown only after the server reports
 * the import as completed and the new dataset version active.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { Button, ErrorBox, Notice, Pill, cx } from '../../components/ui';
import { apiGet, apiSend, apiUpload } from '../../lib/api';
import { invalidateAccountData, qk } from '../../lib/queries';
import type { Account, Dataset, ImportRecord } from '../../lib/types';

const LEGACY_HEADERS = ['Channel', 'Sent Date Range', 'Sent', 'Delivered', 'Skipped', 'Bounce Rate', 'Soft Bounce Rate', 'Hard Bounce Rate', 'Open Rate', 'Click-Through Rate', 'Revenue', 'Unsubscribe Rate', 'Conversions'];
const LEGACY_RANGES = ['Last 7 Days', 'Last 14 Days', 'Last 30 Days', 'Last 60 Days', 'Last 90 Days', 'Last 180 Days', 'Last 3 Months', 'Last 6 Months', 'Last 12 Months', 'Last 2 Years'];
const CAMPAIGN_HEADERS = ['Campaign ID', 'Campaign Name', 'Launch ID', 'Channel', 'Launch Date', 'Launch Time', 'Program', 'Subject Line', 'Currency', 'Sent', 'Delivered', 'Skipped', 'Bounces', 'Total Opens', 'Unique Opens', 'Total Clicks', 'Unique Clicks', 'Conversions', 'Orders', 'Revenue', 'Unsubscribes', 'Complaints'];

function downloadCsv(name: string, rows: string[][]) {
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const showDelim = (d: string) => (d === '\t' ? 'Tab' : d === ',' ? 'Comma (,)' : d === ';' ? 'Semicolon (;)' : d === '|' ? 'Pipe (|)' : d);
const nf = (f: { decimal: string; thousands: string }) => `1${f.thousands === ' ' ? ' ' : f.thousands}234${f.decimal}56 (decimal "${f.decimal}", thousands "${f.thousands || 'none'}")`;

export const UploadCard: React.FC<{ account: Account; maxBytes: number; onUploaded: (imp: ImportRecord) => void }> = ({ account, maxBytes, onUploaded }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = async (file?: File | null) => {
    if (!file) return;
    setError(null);
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) return setError('Choose a .csv, .tsv or .txt file. Spreadsheets (.xlsx) must be saved as CSV first.');
    if (file.size > maxBytes) return setError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    setBusy(true);
    try {
      onUploaded(await apiUpload<ImportRecord>(`/accounts/${account.id}/imports`, file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  return (
    <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-[#C74634] text-white flex items-center justify-center shrink-0"><FileSpreadsheet className="w-4 h-4" /></span>
          <div>
            <h3 className="text-base font-bold text-[#2d241d]">Upload an export</h3>
            <p className="text-xs text-[#6b554d]">Account performance export or campaign metrics file · CSV/TSV · for {account.name}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button icon={Download} onClick={() => downloadCsv('Account_Performance_Template.csv', [LEGACY_HEADERS, ...LEGACY_RANGES.map((r) => ['Email', r, ...LEGACY_HEADERS.slice(2).map(() => '')])])}>Summary template</Button>
          <Button icon={Download} onClick={() => downloadCsv('Campaign_Metrics_Template.csv', [CAMPAIGN_HEADERS])}>Campaign template</Button>
        </div>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !busy && (e.preventDefault(), inputRef.current?.click())}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) void handle(e.dataTransfer.files?.[0]); }}
        className={cx('mt-4 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors', busy ? 'cursor-wait opacity-70' : 'cursor-pointer', dragging ? 'border-[#C74634] bg-[#fdf0eb]' : 'border-[#dcc7b0] bg-white hover:border-[#C74634]/60')}
      >
        <input ref={inputRef} id="file-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="hidden" onChange={(e) => handle(e.target.files?.[0])} />
        {busy ? <Loader2 className="w-7 h-7 mx-auto text-[#C74634] animate-spin" /> : <Upload className="w-7 h-7 mx-auto text-[#C74634]" />}
        <p className="mt-2 text-sm font-semibold text-[#2d241d]">{busy ? 'Uploading and reading your file…' : 'Drop your CSV here or click to browse'}</p>
        <p className="mt-1 text-[11px] text-[#8a7668] font-mono">Responsys → Insight → Campaign Performance → Export</p>
      </div>
      {error && (
        <div className="mt-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-start gap-2" role="alert">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" /><span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </section>
  );
};

type Mapping = Record<string, any>;

export const ImportWizard: React.FC<{ account: Account; importId: string; datasets: Dataset[]; onDone: (datasetId: string | null) => void; onClose: () => void }> = ({ account, importId, datasets, onDone, onClose }) => {
  const qc = useQueryClient();
  const imp = useQuery({
    queryKey: ['import', importId],
    queryFn: () => apiGet<ImportRecord>(`/imports/${importId}`),
    refetchInterval: (q) => (q.state.data?.status === 'committing' ? 1000 : false),
  });
  const d = imp.data;
  const det = d?.detection;
  const [m, setM] = useState<Mapping | null>(null);
  const [validation, setValidation] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (det && !m) {
      setM({ ...det.proposal, timezoneConfirmed: false, ...(d?.mapping ?? {}) });
      if (d?.validation) setValidation(d.validation);
    }
  }, [det, d, m]);
  useEffect(() => {
    if (d?.status === 'completed') {
      invalidateAccountData(qc, account.id);
      void qc.invalidateQueries({ queryKey: qk.datasets(account.id) });
    }
  }, [d?.status, qc, account.id]);

  const required: string[] = det?.requiredDecisions ?? [];
  const sameType = useMemo(() => datasets.filter((x) => x.sourceType === (d?.format === 'legacy_summary' ? 'upload_legacy_summary' : 'upload_campaign_metrics')), [datasets, d?.format]);
  const set = (patch: Mapping) => setM((x) => ({ ...(x ?? {}), ...patch }));

  if (imp.isLoading || !d) return <div className="p-4 text-xs"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading import…</div>;
  if (imp.error) return <ErrorBox error={imp.error} />;

  const reinspect = async (patch: { encoding?: string; delimiter?: string }) => {
    setBusy('reinspect');
    setError(null);
    try {
      await apiSend('POST', `/imports/${importId}/reinspect`, patch);
      setM(null);
      setValidation(null);
      await imp.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const validate = async () => {
    setBusy('validate');
    setError(null);
    try {
      setValidation(await apiSend('POST', `/imports/${importId}/validate`, { mapping: m }));
      await imp.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const commit = async () => {
    setBusy('commit');
    setError(null);
    try {
      await apiSend('POST', `/imports/${importId}/commit`);
      await imp.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    await apiSend('POST', `/imports/${importId}/cancel`).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: qk.imports(account.id) });
    onClose();
  };

  const legacy = d.format === 'legacy_summary';
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-sm font-bold text-[#2d241d]">{d.fileName}</div>
        <div className="text-[11px] text-[#6b554d]">
          {Number(d.byteSize).toLocaleString()} bytes · sha256 <span className="font-mono">{d.sha256.slice(0, 12)}…</span> · {d.format === 'unknown' ? 'format not recognised' : legacy ? 'Account-period summary export' : 'Campaign metrics file'} · {det?.dataRowCount ?? 0} data rows
        </div>
      </div>
      <Pill tone={d.status === 'completed' ? 'good' : d.status === 'failed' || d.status === 'cancelled' ? 'bad' : 'info'}>{d.status.replace(/_/g, ' ')}</Pill>
    </div>
  );

  if (d.status === 'completed') {
    return (
      <div className="space-y-3">
        {header}
        <Notice tone="good">
          <strong>Import complete.</strong> {d.errorMessage ?? 'A new dataset version is active and all reports now use it.'}
        </Notice>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => onDone(d.targetDatasetId)}>View the report</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }
  if (d.status === 'cancelled') {
    return (
      <div className="space-y-3">
        {header}
        <Notice tone={d.duplicateOf ? 'info' : 'warn'}>{d.duplicateOf ? 'This exact file was already imported for this account, so nothing was added. Your existing data is unchanged.' : 'This import was cancelled.'}</Notice>
        <Button onClick={onClose}>Close</Button>
      </div>
    );
  }
  if (d.status === 'committing') {
    return (
      <div className="space-y-3">
        {header}
        <Notice><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Saving and activating the data. Reports update automatically when this finishes.</Notice>
      </div>
    );
  }
  if (d.status === 'failed') {
    return (
      <div className="space-y-3">
        {header}
        <ErrorBox error={{ message: d.errorMessage ?? 'The import failed.' }} title="Import failed — no data was changed" />
        <Button onClick={onClose}>Close</Button>
      </div>
    );
  }

  const needs = (k: string) => required.includes(k);
  const radio = (field: string, options: [string, string][], label: string, help?: string) => (
    <fieldset className="text-xs">
      <legend className="font-bold">{label}{help && <span className="block font-normal text-[10px] text-[#8a7668]">{help}</span>}</legend>
      <div className="mt-1 flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <label key={v} className={cx('px-2 py-1 rounded-lg border cursor-pointer', m?.[field] === v ? 'border-[#C74634] bg-white' : 'border-[#e8dcc9]')}>
            <input type="radio" className="mr-1" name={field} checked={m?.[field] === v} onChange={() => set({ [field]: v })} />
            {l}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="space-y-4 text-[#2d241d]">
      {header}
      {d.errorMessage && <Notice tone="warn">{d.errorMessage}</Notice>}
      {(needs('encoding') || needs('delimiter') || det?.delimiterCandidates?.length > 1) && (
        <div className="flex flex-wrap gap-3 items-end text-xs">
          {needs('encoding') && (
            <label>File encoding
              <select className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1" onChange={(e) => reinspect({ encoding: e.target.value })} defaultValue="">
                <option value="" disabled>Choose…</option><option value="windows-1252">Windows-1252 (Excel on Windows)</option><option value="iso-8859-1">ISO-8859-1</option><option value="utf-8">UTF-8</option>
              </select>
            </label>
          )}
          {(det?.delimiterCandidates?.length ?? 0) > 0 && (
            <label>Column separator
              <select className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1" value={det?.delimiter ?? ''} onChange={(e) => reinspect({ delimiter: e.target.value, encoding: det?.encoding ?? undefined })}>
                {!det?.delimiter && <option value="">Choose…</option>}
                {det.delimiterCandidates.map((x: string) => <option key={x} value={x}>{showDelim(x)}</option>)}
              </select>
            </label>
          )}
          {busy === 'reinspect' && <Loader2 className="w-4 h-4 animate-spin" />}
        </div>
      )}

      {det?.sampleRows?.length > 0 && (
        <details className="rounded-xl border border-[#e8dcc9] bg-white">
          <summary className="px-3 py-2 text-xs font-bold cursor-pointer">File preview (first rows, as written in the file)</summary>
          <div className="overflow-x-auto p-2">
            <table className="text-[11px] font-mono">
              <tbody>{det.sampleRows.map((r: string[], i: number) => <tr key={i} className={i === 0 ? 'font-bold' : ''}>{r.map((c, j) => <td key={j} className="border border-gray-100 px-1.5 py-0.5 whitespace-nowrap">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      )}

      {d.format !== 'unknown' && m && (
        <div className="rounded-xl border border-[#e8dcc9] bg-white p-4 space-y-4">
          <div className="text-xs font-bold uppercase tracking-wider text-[#8d563b]">Confirm what this file means</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <label>Dataset name
              <input value={m.datasetName ?? ''} onChange={(e) => set({ datasetName: e.target.value })} className="block mt-1 w-full rounded border border-[#e8dcc9] px-2 py-1" />
            </label>
            <label>Add as
              <select value={m.targetDatasetId ?? ''} onChange={(e) => set({ targetDatasetId: e.target.value || null })} className="block mt-1 w-full rounded border border-[#e8dcc9] px-2 py-1">
                <option value="">A new data source</option>
                {sameType.map((x) => <option key={x.id} value={x.id}>Replace "{x.name}" (new version; the old one is kept for rollback)</option>)}
              </select>
            </label>
            <label>Currency of revenue values
              <input value={m.currency ?? ''} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} className="block mt-1 w-28 rounded border border-[#e8dcc9] px-2 py-1 font-mono" />
              <span className="text-[10px] text-[#8a7668]">Account currency is {account.currency}. Amounts are never converted.</span>
            </label>
            <label className={`flex items-start gap-2 mt-4 rounded-lg p-2 border ${m.timezoneConfirmed === true ? 'border-transparent' : 'border-amber-300 bg-amber-50'}`}>
              <input type="checkbox" checked={m.timezoneConfirmed === true} onChange={(e) => set({ timezoneConfirmed: e.target.checked })} />
              <span>Dates in this file are in the account timezone <strong>{account.timezone}</strong></span>
            </label>
            {(det.numberFormatCandidates?.length ?? 0) > 0 && (
              <label>Number format{needs('numberFormat') && <Pill tone="warn">Choose — ambiguous</Pill>}
                <select value={JSON.stringify(m.numberFormat)} onChange={(e) => set({ numberFormat: JSON.parse(e.target.value) })} className="block mt-1 w-full rounded border border-[#e8dcc9] px-2 py-1">
                  {[...det.numberFormatCandidates, ...[{ decimal: '.', thousands: ',' }, { decimal: ',', thousands: '.' }].filter((f: any) => !det.numberFormatCandidates.some((c: any) => c.decimal === f.decimal && c.thousands === f.thousands))].map((f: any) => (
                    <option key={JSON.stringify(f)} value={JSON.stringify(f)}>{nf(f)}</option>
                  ))}
                </select>
              </label>
            )}
            {needs('defaultChannel') && (
              <label>Channel (the file has no channel column)
                <select value={m.defaultChannel ?? ''} onChange={(e) => set({ defaultChannel: e.target.value || undefined })} className="block mt-1 w-full rounded border border-[#e8dcc9] px-2 py-1">
                  <option value="">Choose…</option><option>Email</option><option>SMS</option><option>Mobile App</option><option>Web Push</option>
                </select>
              </label>
            )}
          </div>

          {legacy ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-xs">Export date (the day the report was run)
                <input type="date" value={m.asOfDate ?? ''} onChange={(e) => set({ asOfDate: e.target.value })} className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1 font-mono" />
                <span className="text-[10px] text-[#8a7668]">The upload date is not used — "Last 7 Days" is measured from this date.</span>
              </label>
              {radio('windowEnd', [['end_of_previous_day', 'End the day before the export date'], ['end_of_as_of_day', 'Include the export date']], 'Where do the "Last N days" windows end?')}
              {radio('rateScale', [['percent', 'Percent (25 = 25%)'], ['fraction', 'Fraction (0.25 = 25%)']], 'How are rates written?', det.rateScaleAmbiguous ? 'All rate values are ≤ 1 — please confirm.' : undefined)}
              {needs('openRateMeaning') && radio('openRateMeaning', [['unique', 'Unique opens'], ['total', 'Total opens'], ['not_stated', 'Not stated']], '"Open Rate" measures…')}
              {needs('clickRateMeaning') && radio('clickRateMeaning', [['unique', 'Unique clicks'], ['total', 'Total clicks'], ['not_stated', 'Not stated']], '"Click-Through Rate" measures…')}
              {needs('conversionsMeaning') && radio('conversionsMeaning', [['events', 'Conversion events'], ['not_stated', 'Not stated']], '"Conversions" are…', 'Only confirmed events can be used in rates and comparisons.')}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <label>Date format{needs('dateFormat') && <Pill tone="warn">Choose — ambiguous</Pill>}
                <select value={m.dateFormat ?? ''} onChange={(e) => set({ dateFormat: e.target.value })} className="block mt-1 w-full rounded border border-[#e8dcc9] px-2 py-1">
                  <option value="">Choose…</option>
                  {(det.dateFormatCandidates?.length ? det.dateFormatCandidates : ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD']).map((f: string) => <option key={f}>{f}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>Data covers from<input type="date" value={m.coverageStart ?? ''} onChange={(e) => set({ coverageStart: e.target.value })} className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1 font-mono" /></label>
                <label>to (inclusive)<input type="date" value={m.coverageEnd ?? ''} onChange={(e) => set({ coverageEnd: e.target.value })} className="block mt-1 rounded border border-[#e8dcc9] px-2 py-1 font-mono" /></label>
                <span className="col-span-2 text-[10px] text-[#8a7668]">Days inside this range with no rows are reported as zero activity; days outside it are "no data".</span>
              </div>
              {needs('opensMeaning') && radio('opensMeaning', [['total', 'Total opens'], ['unique', 'Unique opens']], '"Opens" column contains…')}
              {needs('clicksMeaning') && radio('clicksMeaning', [['total', 'Total clicks'], ['unique', 'Unique clicks']], '"Clicks" column contains…')}
            </div>
          )}

          <details className="text-xs">
            <summary className="font-bold cursor-pointer">Column mapping ({Object.keys(m.columns ?? {}).length} columns recognised)</summary>
            <table className="mt-2 text-[11px]">
              <tbody>
                {Object.entries(m.columns ?? {}).map(([field, idx]) => (
                  <tr key={field}><td className="pr-3 font-mono">{field}</td><td>{det.detection?.headers?.[idx as number] ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
            {det.detection?.unmappedHeaders?.length > 0 && <p className="mt-1 text-[#8a7668]">Ignored columns: {det.detection.unmappedHeaders.join(', ')}</p>}
          </details>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'validate'} onClick={validate} disabled={m.timezoneConfirmed !== true}>Validate</Button>
            <Button variant="ghost" onClick={cancel}>Cancel import</Button>
            {m.timezoneConfirmed !== true && (
              <span className="self-center text-[11px] font-semibold text-amber-800">Confirm the timezone (the highlighted box above) to continue.</span>
            )}
          </div>
        </div>
      )}
      {d.format === 'unknown' && <Button variant="ghost" onClick={cancel}>Discard this file</Button>}

      {error ? <ErrorBox error={error} /> : null}

      {validation && (
        <div className="rounded-xl border border-[#e8dcc9] bg-white p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2">
            {validation.ok ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <AlertTriangle className="w-5 h-5 text-rose-600" />}
            <strong>{validation.ok ? `Ready: ${validation.acceptedRows} rows passed validation` : `${validation.errorCount} problem(s) must be fixed — nothing will be imported`}</strong>
          </div>
          {validation.errors?.length > 0 && (
            <div className="overflow-x-auto max-h-56">
              <table className="w-full">
                <thead><tr className="text-left text-[#6b554d]"><th className="pr-2">Line</th><th className="pr-2">Column</th><th className="pr-2">Problem</th><th>Value</th></tr></thead>
                <tbody>{validation.errors.map((e: any, i: number) => <tr key={i} className="border-t border-gray-100"><td className="pr-2 font-mono">{e.row || '—'}</td><td className="pr-2">{e.column ?? '—'}</td><td className="pr-2">{e.message}</td><td className="font-mono">{e.value ?? ''}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {validation.conflicts?.length > 0 && <Notice tone="warn"><strong>Data-quality conflicts</strong>{validation.conflicts.map((c: string) => <div key={c}>{c}</div>)}</Notice>}
          {validation.warnings?.length > 0 && <Notice tone="warn">{validation.warnings.slice(0, 8).map((w: string) => <div key={w}>{w}</div>)}</Notice>}
          {validation.ok && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="rounded-lg bg-[#faf6f1] p-2"><div className="text-[10px] text-[#8a7668]">Coverage</div><div className="font-mono">{validation.coverage ? `${validation.coverage.start} → ${validation.coverage.endExclusive} (excl.)` : '—'}</div></div>
                <div className="rounded-lg bg-[#faf6f1] p-2"><div className="text-[10px] text-[#8a7668]">Channels</div><div>{validation.channels.join(', ')}</div></div>
                <div className="rounded-lg bg-[#faf6f1] p-2"><div className="text-[10px] text-[#8a7668]">{validation.campaignCount !== null ? 'Campaigns' : 'Windows'}</div><div>{validation.campaignCount ?? validation.windows?.join(', ')}</div></div>
                <div className="rounded-lg bg-[#faf6f1] p-2"><div className="text-[10px] text-[#8a7668]">Grain</div><div>{validation.grain.replace('_', ' ')} · {validation.timeBasis.replace('_', ' ')}</div></div>
              </div>
              <div>
                <div className="font-bold mb-1">What this data can and cannot support</div>
                <ul className="list-disc pl-5 text-[#4d4039]">{validation.limitations.map((l: string) => <li key={l}>{l}</li>)}</ul>
              </div>
              <Button variant="primary" busy={busy === 'commit'} onClick={commit}>Import {validation.acceptedRows} rows</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
