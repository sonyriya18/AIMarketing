import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Download, PlugZap, Search, Settings2 } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { addDays, localDate } from '../../shared/time/zoned';
import type { ConnectAdvice, ConnectDiagnostics } from '../../shared/contracts/connect';
import type { Account } from '../lib/types';
import { apiGet } from '../lib/api';
import { Button, Card, ErrorBox, Loading, Notice, Pill } from './ui';
import { ConnectionsCard } from '../features/data/DataPage';

const labels: Record<string, string> = { missing_source_file: 'Missing source file', schema_mismatch: 'Field mapping', encoding: 'File encoding', data_format: 'Data format', transfer_or_auth: 'Transfer / authentication', other: 'Needs investigation' };
const colors = { succeeded: '#15803d', failed: '#c74634', running: '#2563eb', aborted: '#d97706', unknown: '#9ca3af' };
const pretty = (value: string | null, tz: string) => value ? new Date(value).toLocaleString(undefined, { timeZone: tz }) : 'Not available';
function Advice({ advice }: { advice: ConnectAdvice }) {
  return <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
    <h4 className="font-bold text-emerald-900">Suggested solution · {advice.title}</h4>
    <ol className="list-decimal pl-4 mt-2 space-y-1">{advice.steps.map(s => <li key={s}>{s}</li>)}</ol>
    <p className="mt-2 text-emerald-900"><strong>Verify:</strong> {advice.verification}</p>
    <a className="inline-block mt-2 underline" href={advice.reference} target="_blank" rel="noreferrer">Oracle API documentation ↗</a>
  </div>;
}
export function ConnectJobs({ account, perms }: { account: Account; perms: Set<string> }) {
  const today = useMemo(() => localDate(new Date(), account.timezone), [account.timezone]);
  const [range, setRange] = useState({ from: addDays(today, -13), to: today });
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [jobLimit, setJobLimit] = useState(6);
  const [runLimit, setRunLimit] = useState(10);
  useEffect(() => { setJobLimit(6); setRunLimit(10); }, [account.id, range.from, range.to]);
  useEffect(() => { setRunLimit(10); }, [filter, search]);
  const [configure, setConfigure] = useState(false);
  const q = useQuery({ queryKey: ['connect-diagnostics', account.id, range.from, range.to], queryFn: () => apiGet<ConnectDiagnostics>(`/accounts/${account.id}/connect-diagnostics?from=${range.from}&to=${range.to}`), refetchInterval: 5000 });
  const d = q.data;
  const exportData = () => {
    if (!d) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `responsys-connect-${range.from}-${range.to}.json`; a.click(); URL.revokeObjectURL(url);
  };
  const runs = d?.runs.filter(r => (filter === 'all' || r.status === filter) && `${r.jobName} ${r.externalJobId} ${r.externalRunId} ${r.errorMessage ?? ''}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const chart = useMemo(() => {
    if (!d) return [];
    const map = new Map(d.trend.map(t => [t.date, t]));
    const rows = [];
    for (let date = d.from; date <= d.to; date = addDays(date, 1)) rows.push(map.get(date) ?? { date, succeeded: 0, failed: 0, running: 0, aborted: 0, unknown: 0 });
    return rows;
  }, [d]);
  const outcomes = d ? Object.entries(colors).map(([status, color]) => ({ name: status, value: d.totals[status as keyof typeof colors], color })).filter(s => s.value > 0) : [];
  const jobChart = d?.jobs.slice().sort((a,b) => b.failed+b.aborted-a.failed-a.aborted || b.runs-a.runs).slice(0,12).map(j => ({ ...j, label: j.name.length > 26 ? j.name.slice(0,23)+'…' : j.name })) ?? [];
  return <div className="space-y-5">
    <section className="rounded-2xl bg-[#161616] text-white p-5 sm:p-7 flex flex-wrap items-center justify-between gap-4">
      <div><div className="text-xs text-orange-200 flex items-center gap-2"><Activity size={14} />RESPONSYS CONNECT</div><h2 className="text-2xl font-bold mt-1">Job health &amp; error diagnostics</h2><p className="text-xs text-gray-300 mt-2">Follow every run. Understand failures. Verify the fix.</p></div>
      <div className="flex flex-wrap gap-2">
        {perms.has('workspace.manage') && <Button icon={Settings2} onClick={() => setConfigure(!configure)}>Manage connection</Button>}
        <Button icon={Download} disabled={!d?.totals.runs} onClick={exportData}>Export diagnostics</Button>
      </div>
    </section>
    <div className="flex flex-wrap items-end gap-3 text-xs">
      <label className="font-semibold">From<input aria-label="Connect start date" type="date" value={range.from} max={range.to} onChange={e => e.target.value && setRange({ ...range, from: e.target.value })} className="block mt-1 rounded-lg border border-gray-300 p-2 bg-white" /></label>
      <label className="font-semibold">To<input aria-label="Connect end date" type="date" value={range.to} min={range.from} max={today} onChange={e => e.target.value && setRange({ ...range, to: e.target.value })} className="block mt-1 rounded-lg border border-gray-300 p-2 bg-white" /></label>
      <Button onClick={() => setRange({ from: addDays(today, -6), to: today })}>Last 7 days</Button><Button onClick={() => setRange({ from: addDays(today, -29), to: today })}>Last 30 days</Button>
      <span className="text-gray-500 pb-2">{account.timezone} · Up to 90 days · Refreshes every 5 seconds</span>
    </div>
    {q.isLoading && <Loading label="Loading Connect diagnostics…" />}
    {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
    {(configure || d?.connections.length === 0) && <ConnectionsCard account={account} canManage={perms.has('workspace.manage')} canSync={perms.has('data.import')} />}
    {d && <>
      {d.connections.length === 0 && <Notice tone="warn"><div><strong>Connect Responsys to see live jobs.</strong> Add your connection above, using API credentials stored on this server. Charts remain empty until real job runs are pulled.</div></Notice>}
      {d.connections.map(c => <Card key={c.id} tone="white" title={<span className="flex flex-wrap gap-2 items-center"><PlugZap size={16} />{c.name}<Pill tone={c.syncStatus === 'available' ? 'good' : c.syncStatus === 'unavailable' ? 'bad' : c.syncStatus === 'partial' ? 'warn' : 'info'}>{c.syncStatus ?? 'Not pulled'}</Pill></span>} subtitle={`Last pull update: ${pretty(c.lastSyncAt, account.timezone)}`}>
        <p className="text-xs whitespace-pre-wrap break-words">{c.syncDetail ?? 'Use Manage connection to synchronize run history, status and failure logs.'}</p>
        {c.lastError && <p className="text-xs text-rose-700 mt-2">Connection error: {c.lastError}</p>}
        {c.advice && <Advice advice={c.advice} />}
      </Card>)}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[{ label: 'Connect jobs', n: d.totals.jobs, color: '#161616' },{ label: 'Runs in period', n: d.totals.runs, color: '#161616' },{ label: 'Succeeded', n: d.totals.succeeded, color: colors.succeeded },{ label: 'Failed / aborted', n: d.totals.failed + d.totals.aborted, color: colors.failed },{ label: 'Success rate', n: d.totals.runs ? `${(100*d.totals.succeeded/d.totals.runs).toFixed(1)}%` : '—', color: colors.succeeded }].map(k => <div key={k.label} className="bg-white border border-gray-200 rounded-xl p-4"><p className="text-xs text-gray-500">{k.label}</p><p className="mt-2 text-2xl font-bold" style={{ color: k.color }}>{k.n}</p></div>)}
      </div>
      <div className="grid lg:grid-cols-3 gap-5">
        <Card tone="white" title="Run outcomes" subtitle="Every synchronized run, grouped by its latest provider status.">
          <div className="h-64 relative" role="img" aria-label="Run outcome distribution">
            {d.totals.runs ? <><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={outcomes} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={3}>{outcomes.map(s => <Cell key={s.name} fill={s.color} />)}</Pie><Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} /></PieChart></ResponsiveContainer><div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-8"><strong className="text-3xl">{d.totals.runs}</strong><span className="text-xs text-gray-500">total runs</span></div></> : <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-gray-400"><Activity size={30} />Pull real run data to see outcomes</div>}
          </div>
        </Card>
        <Card className="lg:col-span-2" tone="white" title="Performance by Connect job" subtitle="Up to 12 jobs, with failures first. Hover for counts by outcome.">
          <div style={{ height: Math.max(256,jobChart.length*42) }} role="img" aria-label="Run outcomes by Connect job">
            {jobChart.some(j => j.runs > 0) ? <ResponsiveContainer width="100%" height="100%"><BarChart data={jobChart} layout="vertical" margin={{ left: 8, right: 12 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="label" width={145} tick={{ fontSize: 10 }} /><Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload?.name ?? ''} /><Legend wrapperStyle={{ fontSize: 11 }} />{Object.entries(colors).map(([key,color]) => <Bar key={key} dataKey={key} stackId="jobs" fill={color} />)}</BarChart></ResponsiveContainer> : <div className="h-full flex items-center justify-center text-xs text-gray-400">Per-job graphs appear after a successful API pull</div>}
          </div>
        </Card>
      </div>
      <div className="grid lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2" tone="white" title="Job runs over time" subtitle="Daily results from synchronized Responsys runs, in the account timezone.">
          <div className="h-64" role="img" aria-label={`Daily run chart: ${d.totals.succeeded} succeeded, ${d.totals.failed} failed, ${d.totals.aborted} aborted`}>
            {d.totals.runs ? <ResponsiveContainer width="100%" height="100%"><BarChart data={chart}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" tickFormatter={s => s.slice(5)} tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} /><Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} />{Object.entries(colors).map(([key,color]) => <Bar key={key} dataKey={key} stackId="runs" fill={color} />)}</BarChart></ResponsiveContainer> : <div className="h-full flex flex-col items-center justify-center text-gray-400 text-xs gap-2"><Activity size={30} /><p>No synchronized runs in this period</p></div>}
          </div>
        </Card>
        <Card tone="white" title="Failure categories" subtitle="Failed and aborted runs. Suggested causes are inferred from error text.">
          <div className="h-64" role="img" aria-label="Failure category chart">
            {d.errors.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={d.errors.map(e => ({ ...e, label: labels[e.category] ?? e.category }))} layout="vertical" margin={{ left: 12 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="count" name="Runs" fill="#c74634" radius={[0,4,4,0]} /></BarChart></ResponsiveContainer> : <div className="h-full flex flex-col items-center justify-center text-gray-400 text-xs gap-2"><CheckCircle2 size={30} /><p>{d.totals.runs ? 'No failures in the synchronized runs' : 'Failure data not available yet'}</p></div>}
          </div>
        </Card>
      </div>
      <Card tone="white" title="Connect job health cards" subtitle="Job health at a glance. Show more to browse additional jobs.">
        <div id="connect-job-health-list" className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">{d.jobs.slice(0,jobLimit).map(j => <article key={j.id} className="rounded-xl border border-gray-200 p-4"><div className="flex justify-between items-start gap-2"><h4 className="font-bold text-sm">{j.name}</h4><Pill tone={j.failed+j.aborted ? 'bad' : j.runs ? 'good' : 'neutral'}>{j.failed+j.aborted ? 'Review failures' : j.runs ? 'No failed runs' : 'No runs'}</Pill></div><p className="text-[11px] text-gray-500 mt-1">{j.connectionName} · {j.jobType ?? 'Type unavailable'}</p><p className="text-[10px] text-gray-500 font-mono mt-1">Job ID {j.externalJobId}</p><div className="h-2 rounded-full overflow-hidden bg-gray-100 flex mt-4" role="img" aria-label={`${j.succeeded} succeeded, ${j.failed} failed, ${j.aborted} aborted, ${j.running} running, ${j.unknown} unknown`}>{Object.entries(colors).map(([status,color]) => <span key={status} style={{ backgroundColor: color, width: `${j.runs ? 100*j[status as keyof typeof colors]/j.runs : 0}%` }} />)}</div><div className="flex flex-wrap gap-2 mt-3 text-[11px]"><span>{j.runs} runs</span><span className="text-green-700">{j.succeeded} succeeded</span><span className="text-rose-700">{j.failed+j.aborted} failed / aborted</span>{j.running > 0 && <span className="text-blue-700">{j.running} running</span>}</div></article>)}</div>{!d.jobs.length && <p className="p-5 text-xs text-gray-500">No jobs synchronized yet. Use Manage connection to configure and synchronize Responsys.</p>}
        {d.jobs.length > 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs"><span className="text-gray-500">Showing {Math.min(jobLimit,d.jobs.length)} of {d.jobs.length} jobs</span><div className="flex gap-2">{jobLimit > 6 && <Button aria-label="Show fewer jobs" aria-controls="connect-job-health-list" onClick={() => setJobLimit(6)}>Show less</Button>}{jobLimit < d.jobs.length && <Button aria-label="Show more jobs" aria-controls="connect-job-health-list" onClick={() => setJobLimit(n => n+6)}>Show more</Button>}</div></div>}
      </Card>
      <Card tone="white" title="Run history & solutions" subtitle={`Latest ${d.runLimit} runs at most. Expand a run to inspect the provider message, logs and suggested next steps.`}>
        <div className="flex flex-wrap gap-3 mb-4 text-xs"><label className="flex items-center gap-2"><Search size={14} /><input aria-label="Search Connect runs" className="border rounded-lg p-2" placeholder="Search job, run ID or error" value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label="Filter run status" value={filter} onChange={e => setFilter(e.target.value)} className="border rounded-lg p-2"><option value="all">All statuses</option>{Object.keys(colors).map(s => <option key={s} value={s}>{s}</option>)}</select></div>
        {d.truncated && <Notice tone="warn">Only the latest {d.runLimit} runs appear below and in the export. Charts and totals include all runs in this period. Narrow the date range to inspect earlier runs.</Notice>}
        <div id="connect-run-history-list" className="divide-y divide-gray-100">{runs.slice(0,runLimit).map(r => <details key={r.id} className="py-3 group">
          <summary className="cursor-pointer flex flex-wrap items-center gap-3 text-xs"><Pill tone={r.status === 'succeeded' ? 'good' : ['failed','aborted'].includes(r.status) ? 'bad' : 'info'}>{r.status}</Pill><strong className="flex-1 min-w-40">{r.jobName}</strong><span className="font-mono text-gray-500">Run {r.externalRunId}</span><span className="text-gray-500">{pretty(r.startedAt, account.timezone)}</span><span className="text-[#C74634]">Details ↓</span></summary>
          <div className="mt-3 rounded-xl bg-gray-50 p-4 text-xs">
            <p>Provider job ID: <strong>{r.externalJobId}</strong> · Processed: <strong>{r.recordsProcessed ?? 'Not provided'}</strong> · Rejected: <strong>{r.recordsRejected ?? 'Not provided'}</strong></p>
            {r.errorMessage ? <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 p-3"><div className="font-bold text-rose-800 flex items-center gap-2"><AlertTriangle size={14} />Provider error · {labels[r.errorCategory ?? 'other'] ?? 'Other'}</div><pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px]">{r.errorMessage}</pre></div> : ['failed','aborted'].includes(r.status) ? <p className="mt-3 text-amber-800">Responsys did not provide an error message. Review logs and API access before drawing a conclusion.</p> : null}
            {r.detailWarning && <p className="mt-2 text-amber-800">Partial detail: {r.detailWarning}</p>}
            {r.advice && <Advice advice={r.advice} />}
            <h4 className="font-semibold mt-4">Provider logs · latest 50 entries · sensitive values redacted</h4>
            {r.logs.length ? <div className="mt-2 max-h-60 overflow-auto rounded-lg bg-[#161616] p-3 text-gray-200 font-mono text-[11px] space-y-2">{r.logs.map((l,i) => <div key={i} className="whitespace-pre-wrap break-words"><span className="text-gray-400">{l.logTime ? pretty(typeof l.logTime === 'number' ? new Date(l.logTime).toISOString() : l.logTime, account.timezone) : 'Time unavailable'}</span> [{l.logLevel}] {l.logMessage}</div>)}</div> : <p className="mt-1 text-gray-500">{r.status === 'failed' || r.status === 'aborted' ? 'No logs returned. Check the detail warning above.' : 'Detailed logs are fetched for failed and aborted runs.'}</p>}
          </div>
        </details>)}{!runs.length && <p className="p-5 text-xs text-gray-500">No runs match this view.</p>}</div>
        {runs.length > 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs"><span className="text-gray-500">Showing {Math.min(runLimit,runs.length)} of {runs.length} matching runs</span><div className="flex gap-2">{runLimit > 10 && <Button aria-label="Show fewer runs" aria-controls="connect-run-history-list" onClick={() => setRunLimit(10)}>Show less</Button>}{runLimit < runs.length && <Button aria-label="Show more runs" aria-controls="connect-run-history-list" onClick={() => setRunLimit(n => n+10)}>Show more</Button>}</div></div>}
      </Card>
      <p className="text-[11px] text-gray-500">Source: Oracle Responsys Connect API · Charts show synchronized evidence, not live execution status. Suggested solutions require validation in your account.</p>
    </>}
  </div>;
}
