/**
 * Shared UI primitives in the existing Oracle visual language (#C74634 accent, warm cards).
 */
import React, { useEffect, useRef } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Info, Loader2, Minus, RefreshCw, Search, X } from 'lucide-react';
import type { EvidenceItem, MetricChange, MetricValue } from '../lib/types';
import { fmtChange, fmtMetric, reasonText } from '../../shared/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const Card: React.FC<{ title?: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string; tone?: 'warm' | 'white' }> = ({
  title,
  subtitle,
  right,
  children,
  className,
  tone = 'warm',
}) => (
  <section className={cx('rounded-2xl border shadow-sm p-4 sm:p-5', tone === 'warm' ? 'border-[#e8dcc9] bg-[#fffaf5]' : 'border-gray-200 bg-white', className)}>
    {(title || right) && (
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          {title && <h3 className="text-base font-bold text-[#2d241d]">{title}</h3>}
          {subtitle && <p className="text-xs text-[#6b554d] mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
    )}
    {children}
  </section>
);

export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean; icon?: React.ElementType }> = ({
  variant = 'secondary',
  busy,
  icon: Icon,
  children,
  className,
  disabled,
  ...rest
}) => (
  <button
    {...rest}
    disabled={disabled || busy}
    className={cx(
      'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C74634]/60',
      variant === 'primary' && 'bg-[#C74634] hover:bg-[#b03d2d] text-white shadow',
      variant === 'secondary' && 'bg-white hover:bg-gray-50 text-gray-800 border border-gray-300',
      variant === 'ghost' && 'text-[#6b554d] hover:text-[#2d241d] hover:bg-[#f5eee6]',
      variant === 'danger' && 'bg-white text-rose-700 border border-rose-300 hover:bg-rose-50',
      className
    )}
  >
    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : Icon ? <Icon className="w-3.5 h-3.5" /> : null}
    {children}
  </button>
);

export const Pill: React.FC<{ tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'scenario'; children: React.ReactNode; title?: string }> = ({ tone = 'neutral', children, title }) => (
  <span
    title={title}
    className={cx(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap',
      tone === 'neutral' && 'bg-[#f1dfcf] text-[#7d4d35] border-[#e2c4a8]',
      tone === 'good' && 'bg-emerald-50 text-emerald-800 border-emerald-200',
      tone === 'bad' && 'bg-rose-50 text-rose-800 border-rose-200',
      tone === 'warn' && 'bg-amber-50 text-amber-900 border-amber-200',
      tone === 'info' && 'bg-sky-50 text-sky-800 border-sky-200',
      tone === 'scenario' && 'bg-indigo-50 text-indigo-800 border-indigo-200'
    )}
  >
    {children}
  </span>
);

export const Loading: React.FC<{ label?: string }> = ({ label = 'Loading…' }) => (
  <div className="flex items-center gap-2 text-xs text-[#6b554d] p-6 justify-center" role="status">
    <Loader2 className="w-4 h-4 animate-spin text-[#C74634]" /> {label}
  </div>
);

export const ErrorBox: React.FC<{ error: unknown; onRetry?: () => void; title?: string }> = ({ error, onRetry, title = 'Something went wrong' }) => {
  const e = error as { message?: string; requestId?: string; details?: unknown };
  // Validation errors carry the exact reasons; show them instead of only the summary.
  const reasons = Array.isArray(e?.details)
    ? (e.details as { message?: unknown; path?: unknown }[]).map((d) => (typeof d?.message === 'string' ? d.message : null)).filter((m): m is string => Boolean(m)).slice(0, 8)
    : [];
  return (
    <div className="p-4 rounded-2xl border border-rose-200 bg-rose-50/70 text-xs text-rose-900 flex items-start gap-2" role="alert">
      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-bold">{title}</div>
        <div>{e?.message || String(error)}</div>
        {reasons.length > 0 && (
          <ul className="list-disc pl-4 mt-1 space-y-0.5">
            {[...new Set(reasons)].map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
        {e?.requestId && <div className="text-[10px] text-rose-700/70 font-mono mt-1">Request {e.requestId}</div>}
      </div>
      {onRetry && (
        <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
};

export const Notice: React.FC<{ tone?: 'info' | 'warn' | 'good'; children: React.ReactNode; className?: string }> = ({ tone = 'info', children, className }) => (
  <div
    className={cx(
      'p-3 rounded-xl border text-xs flex items-start gap-2',
      tone === 'info' && 'bg-sky-50/70 border-sky-200 text-sky-950',
      tone === 'warn' && 'bg-amber-50 border-amber-200 text-amber-950',
      tone === 'good' && 'bg-emerald-50 border-emerald-200 text-emerald-950',
      className
    )}
  >
    <Info className="w-4 h-4 shrink-0 mt-0.5 opacity-70" />
    <div className="flex-1 space-y-1">{children}</div>
  </div>
);

export const Empty: React.FC<{ icon?: React.ElementType; title: string; children?: React.ReactNode; action?: React.ReactNode }> = ({ icon: Icon = Search, title, children, action }) => (
  <div className="rounded-2xl border-2 border-dashed border-[#e2c4a8] bg-white p-8 text-center">
    <Icon className="w-8 h-8 mx-auto text-[#C74634]" />
    <h3 className="mt-2 text-sm font-bold text-[#2d241d]">{title}</h3>
    {children && <div className="mt-1 text-xs text-[#6b554d] max-w-lg mx-auto">{children}</div>}
    {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
  </div>
);

export const ChangeBadge: React.FC<{ c: MetricChange | null | undefined }> = ({ c }) => {
  if (!c || c.absoluteChange === null) {
    return <span className="text-[10px] text-[#8a7668]" title={c?.note ?? ''}>{c?.note ? 'No comparison' : ''}</span>;
  }
  const Icon = c.direction === 'up' ? ArrowUpRight : c.direction === 'down' ? ArrowDownRight : Minus;
  const tone = c.interpretation === 'better' ? 'text-emerald-700' : c.interpretation === 'worse' ? 'text-rose-700' : 'text-gray-600';
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-[10px] font-bold', tone)} title={c.note ?? undefined}>
      <Icon className="w-3 h-3" />
      {fmtChange(c)}
    </span>
  );
};

export const MetricTile: React.FC<{ c: MetricChange | undefined; icon?: React.ElementType; onInspect?: (m: MetricValue) => void; sub?: React.ReactNode }> = ({ c, icon: Icon, onInspect, sub }) => {
  if (!c) return null;
  const m = c.current;
  const unavailable = m.value === null;
  return (
    <div className="bg-white border border-[#e8dcc9] rounded-xl p-3 shadow-xs flex flex-col justify-between hover:border-[#C74634]/40 transition-colors min-h-[104px]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-semibold text-[#6b554d] uppercase tracking-wider leading-tight">{m.label}</span>
        {Icon && <Icon className="w-3.5 h-3.5 text-[#C74634] shrink-0" />}
      </div>
      <div className={cx('text-lg font-bold font-mono truncate', unavailable ? 'text-gray-400 text-sm' : m.unit === 'money' || m.unit === 'money_per_message' ? 'text-emerald-800' : 'text-gray-900')} title={unavailable ? reasonText(m.reason) : undefined}>
        {fmtMetric(m)}
      </div>
      <div className="mt-1 flex items-center justify-between gap-1 min-h-[16px]">
        {unavailable ? <span className="text-[10px] text-[#8a7668] truncate">{reasonText(m.reason)}</span> : <ChangeBadge c={c} />}
        <span className="flex items-center gap-1">
          {m.availability === 'conflicted' && <Pill tone="bad">Conflict</Pill>}
          {onInspect && (
            <button onClick={() => onInspect(m)} className="text-[10px] font-semibold text-[#C74634] hover:underline cursor-pointer" aria-label={`Inspect data for ${m.label}`}>
              Inspect
            </button>
          )}
        </span>
      </div>
      {sub && <div className="text-[10px] text-[#8a7668] mt-0.5 truncate">{sub}</div>}
      {m.warnings.length > 0 && !unavailable && <div className="text-[10px] text-amber-700 mt-0.5 line-clamp-2" title={m.warnings.join(' · ')}>{m.warnings[0]}</div>}
    </div>
  );
};

export const Modal: React.FC<{ open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }> = ({ open, onClose, title, children, wide }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]')?.focus(), 0);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start sm:items-center justify-center p-2 sm:p-6 overflow-y-auto" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('bg-[#fffaf5] rounded-2xl shadow-2xl w-full border border-[#e8dcc9]', wide ? 'max-w-5xl' : 'max-w-2xl')}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#e8dcc9]">
          <h2 className="text-sm font-bold text-[#2d241d]">{title}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#f1dfcf] cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 max-h-[80vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

/** "Inspect data": where a number came from (blueprint 6.5). */
export const EvidenceModal: React.FC<{ metric: MetricValue | null; evidence: EvidenceItem[]; source?: { datasetName: string; version: number; importFileName: string | null; importSha256: string | null; sourceAsOf: string | null } | null; onClose: () => void }> = ({
  metric,
  evidence,
  source,
  onClose,
}) => {
  const items = metric ? evidence.filter((e) => metric.evidenceIds.includes(e.id)) : [];
  return (
    <Modal open={Boolean(metric)} onClose={onClose} title={metric ? `Inspect data · ${metric.label}` : ''}>
      {metric && (
        <div className="space-y-3 text-xs text-[#2d241d]">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Value" value={fmtMetric(metric)} />
            <Field label="Exact value" value={metric.value ?? 'Unavailable'} mono />
            <Field label="Availability" value={metric.availability + (metric.reason ? ` (${reasonText(metric.reason)})` : '')} />
            <Field label="Origin" value={metric.origin ?? '—'} />
            <Field label="Unit / currency" value={`${metric.unit}${metric.currency ? ` · ${metric.currency}` : ''}`} />
            <Field label="Definition version" value={metric.definitionVersion} mono />
          </div>
          {items.map((e) => (
            <div key={e.id} className="rounded-xl border border-[#e8dcc9] bg-white p-3 space-y-1">
              <div className="font-bold">{e.label}</div>
              {e.formula && <div>Formula: <span className="font-mono">{e.formula}</span></div>}
              {e.inputs.length > 0 && (
                <div>
                  Inputs: {e.inputs.map((i) => (
                    <span key={i.metricId} className="font-mono mr-2">{i.metricId} = {i.value ?? 'unavailable'}</span>
                  ))}
                </div>
              )}
              <div>Scope: {e.scope}</div>
              <div>
                Rows used: {e.source.rowCount}
                {e.source.sourceRows?.length ? ` · source file lines ${e.source.sourceRows.slice(0, 20).join(', ')}${e.source.sourceRows.length > 20 ? '…' : ''}` : ''}
              </div>
              <div className="font-mono text-[10px] text-[#8a7668]">Evidence {e.id} · dataset version {e.source.datasetVersionIds.join(', ')}</div>
            </div>
          ))}
          {source && (
            <div className="text-[11px] text-[#6b554d]">
              Source: <strong>{source.datasetName}</strong> (version {source.version}){source.importFileName ? ` · file ${source.importFileName}` : ''}
              {source.importSha256 ? <span className="font-mono"> · sha256 {source.importSha256.slice(0, 12)}…</span> : null}
              {source.sourceAsOf ? ` · as of ${source.sourceAsOf.slice(0, 10)}` : ''}
            </div>
          )}
          {metric.warnings.length > 0 && <Notice tone="warn">{metric.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
        </div>
      )}
    </Modal>
  );
};

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="rounded-lg bg-white border border-[#e8dcc9] p-2">
    <div className="text-[10px] uppercase tracking-wider text-[#8a7668] font-semibold">{label}</div>
    <div className={cx('text-xs break-all', mono && 'font-mono')}>{value}</div>
  </div>
);

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }> = ({ label, className, children, ...rest }) => (
  <label className="flex items-center gap-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
    {label && <span className="font-semibold text-gray-700 pl-1.5 whitespace-nowrap">{label}</span>}
    <select
      {...rest}
      className={cx('bg-white border border-gray-300 text-gray-800 text-xs rounded px-2 py-1.5 font-medium focus:outline-none focus:ring-2 focus:ring-[#C74634] max-w-[16rem] truncate', className)}
    >
      {children}
    </select>
  </label>
);

export const TextInput: React.FC<React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }> = ({ label, hint, className, ...rest }) => (
  <label className="block">
    <span className="text-xs font-bold text-[#2d241d]">{label}</span>
    <input {...rest} className={cx('mt-1 w-full text-xs rounded-lg border border-[#e8dcc9] bg-white px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-[#C74634]/50', className)} />
    {hint && <span className="text-[10px] text-[#8a7668]">{hint}</span>}
  </label>
);

/** Evidence behind a finding or chat statement. */
export const EvidenceListModal: React.FC<{ ids: string[] | null; evidence: EvidenceItem[]; onClose: () => void }> = ({ ids, evidence, onClose }) => {
  const items = ids ? evidence.filter((e) => ids.includes(e.id)) : [];
  return (
    <Modal open={Boolean(ids)} onClose={onClose} title="Evidence">
      <div className="space-y-2 text-xs">
        {items.length === 0 && <p>No evidence items were attached.</p>}
        {items.map((e) => (
          <div key={e.id} className="rounded-xl border border-[#e8dcc9] bg-white p-3 space-y-1">
            <div className="font-bold">{e.label}</div>
            <div>
              Value: <span className="font-mono">{e.value ?? 'Unavailable'}</span> {e.unit === 'percent' ? '%' : e.currency ?? ''}
            </div>
            {e.formula && <div>Formula: <span className="font-mono">{e.formula}</span></div>}
            {e.inputs.length > 0 && <div>Inputs: {e.inputs.map((i) => <span key={i.metricId} className="font-mono mr-2">{i.metricId} = {i.value ?? 'unavailable'}</span>)}</div>}
            <div>Scope: {e.scope} · rows used: {e.source.rowCount}</div>
            <div className="font-mono text-[10px] text-[#8a7668]">{e.id} · dataset version {e.source.datasetVersionIds.join(', ')}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
};
