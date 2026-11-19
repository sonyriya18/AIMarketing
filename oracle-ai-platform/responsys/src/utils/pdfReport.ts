/**
 * PDF export rendered from a report snapshot (decision D09). It contains the same values, scope,
 * revision, definitions and limitations as the screen. Unavailable values are written as such.
 */
import { jsPDF } from 'jspdf';
import type { CampaignReportResult, ComparisonResult, MetricChange, OverviewResult } from '../lib/types';
import { fmtChange, fmtMetric, reasonText } from '../../shared/format';

export type AnyReport = OverviewResult | CampaignReportResult | ComparisonResult;

const ACCENT: [number, number, number] = [199, 70, 52];

export function exportReportPdf(r: OverviewResult) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  let y = M;
  const ensure = (h: number) => {
    if (y + h > H - 50) {
      doc.addPage();
      y = M;
    }
  };
  const text = (s: string, size = 10, bold = false, color: [number, number, number] = [45, 36, 29]) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(s, W - 2 * M) as string[];
    for (const line of lines) {
      ensure(size + 4);
      doc.text(line, M, y);
      y += size + 4;
    }
  };

  doc.setFillColor(22, 22, 22);
  doc.rect(0, 0, W, 56, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Account Performance Report — measured results', M, 34);
  y = 80;
  if (r.meta.dataMode === 'demo') text('DEMO — NOT CUSTOMER DATA', 14, true, [79, 70, 229]);

  const meta: [string, string][] = [
    ['Account', r.meta.accountName],
    ['Period', r.period?.label ?? '—'],
    ['Comparison', r.comparison?.label ?? 'None'],
    ['Data source', `${r.source.datasetName} (version ${r.source.version})`],
    ['Source file', r.source.importFileName ? `${r.source.importFileName} · sha256 ${r.source.importSha256?.slice(0, 16)}…` : 'n/a'],
    ['Timezone / currency', `${r.meta.timezone} / ${r.meta.currency}`],
    ['Coverage', r.meta.coverageStatus],
    ['Report ID', r.meta.reportId],
    ['Data revision', r.meta.dataRevision],
    ['Definitions', r.meta.definitionVersion],
    ['Generated', r.meta.generatedAt],
    ['AI', 'Not used — all values are deterministic'],
  ];
  for (const [k, v] of meta) text(`${k}: ${v}`, 9);
  if (r.meta.warnings.length) {
    y += 6;
    text('Warnings', 11, true, [146, 64, 14]);
    r.meta.warnings.forEach((w) => text(`• ${w}`, 9, false, [146, 64, 14]));
  }

  const table = (title: string, rows: MetricChange[]) => {
    if (!rows.length) return;
    y += 10;
    text(title, 12, true, ACCENT);
    const cols = [M, M + 190, M + 290, M + 390];
    ensure(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(107, 85, 77);
    ['Metric', 'Value', 'Comparison', 'Change'].forEach((h, i) => doc.text(h, cols[i]!, y));
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(45, 36, 29);
    for (const c of rows) {
      ensure(14);
      doc.text(doc.splitTextToSize(c.label, 180)[0] as string, cols[0]!, y);
      doc.text(c.current.value === null ? `Unavailable (${reasonText(c.current.reason)})` : fmtMetric(c.current), cols[1]!, y);
      doc.text(c.previous ? fmtMetric(c.previous) : '—', cols[2]!, y);
      doc.text(c.absoluteChange !== null ? fmtChange(c) : '—', cols[3]!, y);
      y += 13;
    }
  };
  table('Metrics', r.totals.filter((t) => t.current.value !== null || ['unique_open_rate', 'total_open_rate', 'unique_click_rate', 'average_order_value'].includes(t.metricId)));
  table('Rates as reported in the export', r.sourceRates);

  if (r.campaigns.length) {
    y += 10;
    text(`Campaigns (${r.campaigns.length})`, 12, true, ACCENT);
    for (const c of r.campaigns.slice(0, 60)) {
      const open = c.metrics.unique_open_rate?.value !== null ? c.metrics.unique_open_rate : c.metrics.total_open_rate;
      text(`${c.name} (${c.externalId}) — delivered ${fmtMetric(c.metrics.delivered)}, open ${fmtMetric(open)}, revenue ${fmtMetric(c.metrics.revenue)}`, 8);
    }
    if (r.campaigns.length > 60) text(`…and ${r.campaigns.length - 60} more in the CSV export.`, 8);
  }

  y += 10;
  text('Findings (observed differences, not measured causes)', 12, true, ACCENT);
  r.findings.forEach((f) => text(`• ${f.text}`, 9));
  y += 6;
  text('What this data cannot show', 12, true, ACCENT);
  r.capabilities.filter((c) => c.status === 'unavailable').forEach((c) => text(`• ${c.label}: ${c.reason}`, 9));

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(138, 118, 104);
    doc.text(`Report ${r.meta.reportId} · revision ${r.meta.dataRevision} · page ${i}/${pages}`, M, H - 24);
  }
  doc.save(`report-overview-${r.meta.reportId.slice(0, 8)}.pdf`);
}

/** Campaign and comparison snapshots: same header, metrics and findings, from the snapshot. */
function startDoc(title: string, r: AnyReport) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  let y = M;
  const ensure = (h: number) => {
    if (y + h > H - 50) {
      doc.addPage();
      y = M;
    }
  };
  const text = (s: string, size = 10, bold = false, color: [number, number, number] = [45, 36, 29]) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(s, W - 2 * M) as string[]) {
      ensure(size + 4);
      doc.text(line, M, y);
      y += size + 4;
    }
  };
  const row = (cells: string[], widths: number[], bold = false) => {
    ensure(14);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(8);
    doc.setTextColor(bold ? 107 : 45, bold ? 85 : 36, bold ? 77 : 29);
    let x = M;
    cells.forEach((c, i) => {
      doc.text((doc.splitTextToSize(c, widths[i]! - 6) as string[])[0] ?? '', x, y);
      x += widths[i]!;
    });
    y += 12;
  };
  doc.setFillColor(22, 22, 22);
  doc.rect(0, 0, W, 56, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(title, M, 34);
  y = 80;
  if (r.meta.dataMode === 'demo') text('DEMO — NOT CUSTOMER DATA', 14, true, [79, 70, 229]);
  const meta: [string, string][] = [
    ['Account', r.meta.accountName],
    ['Period', r.period?.label ?? '—'],
    ['Data source', `${r.source.datasetName} (version ${r.source.version})`],
    ['Timezone / currency', `${r.meta.timezone} / ${r.meta.currency}`],
    ['Report ID', r.meta.reportId],
    ['Data revision', r.meta.dataRevision],
    ['Definitions', r.meta.definitionVersion],
    ['Generated', r.meta.generatedAt],
  ];
  for (const [k, v] of meta) text(`${k}: ${v}`, 9);
  const finish = (name: string) => {
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(138, 118, 104);
      doc.text(`Report ${r.meta.reportId} · revision ${r.meta.dataRevision} · page ${i}/${pages}`, M, H - 24);
    }
    doc.save(name);
  };
  return { text, row, finish, gap: (h = 10) => (y += h), width: W - 2 * M };
}

export function exportSnapshotPdf(r: AnyReport) {
  if (r.meta.kind === 'overview') return exportReportPdf(r as OverviewResult);
  const accent: [number, number, number] = [199, 70, 52];
  if (r.meta.kind === 'campaign') {
    const c = r as CampaignReportResult;
    const p = startDoc(`Campaign report — ${c.campaign.name}`.slice(0, 70), r);
    p.text(`Campaign ID ${c.campaign.externalId} · ${c.campaign.channel}${c.campaign.program ? ` · program ${c.campaign.program}` : ''}`, 9);
    p.text(`Compared with: ${c.benchmark?.label ?? 'no benchmark'}`, 9);
    p.gap();
    p.text('Metrics', 12, true, accent);
    const w = [170, 100, 100, 145];
    p.row(['Metric', 'This campaign', c.benchmark ? 'Benchmark' : 'Previous', 'Difference'], w, true);
    const list = c.benchmark ? c.benchmarkComparison : c.metrics;
    for (const m of list.filter((x) => x.current.value !== null || x.previous?.value !== null)) {
      p.row([m.label, fmtMetric(m.current), m.previous ? fmtMetric(m.previous) : '—', m.absoluteChange !== null ? fmtChange(m) : '—'], w);
    }
    p.gap();
    p.text(`Launches (${c.launches.length})`, 12, true, accent);
    for (const l of c.launches.slice(0, 40)) p.text(`${l.launchDate} · ${l.launchExternalId ?? '—'} · delivered ${fmtMetric(l.metrics.delivered)} · revenue ${fmtMetric(l.metrics.revenue)}${l.subjectLine ? ` · "${l.subjectLine}"` : ''}`, 8);
    p.gap();
    p.text('Findings (observed differences, not measured causes)', 12, true, accent);
    c.findings.forEach((f) => p.text(`• ${f.text}`, 9));
    return p.finish(`report-campaign-${c.meta.reportId.slice(0, 8)}.pdf`);
  }
  const k = r as ComparisonResult;
  const p = startDoc('Campaign comparison — measured results', r);
  p.gap();
  p.text('Campaigns', 12, true, accent);
  const ids = ['delivered', 'unique_open_rate', 'total_open_rate', 'unique_click_rate', 'total_click_rate', 'conversion_event_rate', 'revenue', 'revenue_per_delivered', 'unsubscribe_rate'];
  const w = [150, ...k.campaigns.map(() => Math.max(60, Math.floor(365 / Math.max(1, k.campaigns.length))))];
  p.row(['Metric', ...k.campaigns.map((c) => c.name)], w, true);
  for (const id of ids) {
    const first = k.campaigns.find((c) => c.metrics[id])?.metrics[id];
    if (!first || k.campaigns.every((c) => c.metrics[id]?.value === null)) continue;
    p.row([first.label, ...k.campaigns.map((c) => (c.metrics[id] ? fmtMetric(c.metrics[id]) : '—'))], w);
  }
  if (!k.compatibility.compatible) {
    p.gap();
    p.text(`Note: ${k.compatibility.issues.join(' ')}`, 9, false, [146, 64, 14]);
  }
  p.gap();
  p.text('Findings (observed differences, not measured causes)', 12, true, accent);
  k.findings.forEach((f) => p.text(`• ${f.text}`, 9));
  return p.finish(`report-comparison-${k.meta.reportId.slice(0, 8)}.pdf`);
}
