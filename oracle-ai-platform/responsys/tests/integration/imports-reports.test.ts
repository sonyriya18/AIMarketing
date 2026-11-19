/**
 * M2/M3: real-file vertical slice. Uploads synthetic fixtures through the API, confirms mappings,
 * commits through the durable job, and checks that reports and exports show exact figures.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, setupWorkspace, signIn, upload, type Client, type Harness } from '../helpers/harness';
import { sha256, stableStringify } from '../../server/modules/reports/snapshots';

const GOLDEN = readFileSync('tests/fixtures/golden-campaigns.csv', 'utf8');
const LEGACY = readFileSync('tests/fixtures/legacy-summary.csv', 'utf8');

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(async () => {
  await h.close();
});

async function importFile(c: Client, accountId: string, content: string | Buffer, mapping: Record<string, unknown>, fileName = 'file.csv') {
  const up = await upload(c, accountId, content, fileName);
  expect(up.status).toBe(201);
  const imp = up.body.data;
  if (imp.status !== 'needs_mapping') return { imp, up };
  const proposal = imp.detection.proposal;
  const val = await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { ...proposal, timezoneConfirmed: true, ...mapping } });
  return { imp, up, val };
}

async function commit(c: Client, importId: string) {
  const res = await c.post(`/api/v1/imports/${importId}/commit`);
  expect(res.status).toBe(202);
  await h.drainJobs();
  return (await c.get(`/api/v1/imports/${importId}`)).body.data;
}

const metric = (report: any, id: string) => report.totals.find((t: any) => t.metricId === id);

describe('campaign-level import and golden reports', () => {
  let c: Client;
  let accountId: string;
  let datasetId: string;

  beforeAll(async () => {
    c = await signIn(h.app);
    ({ accountId } = await setupWorkspace(c, { timezone: 'America/New_York', currency: 'USD' }));
  });

  it('detects the format and requires explicit confirmations before committing', async () => {
    const up = await upload(c, accountId, GOLDEN, 'golden.csv');
    expect(up.status).toBe(201);
    const imp = up.body.data;
    expect(imp.status).toBe('needs_mapping');
    expect(imp.format).toBe('campaign_metrics');
    expect(imp.detection.requiredDecisions).toEqual(expect.arrayContaining(['currency', 'timezone', 'coverage']));
    // Commit before validation is refused.
    expect((await c.post(`/api/v1/imports/${imp.id}/commit`)).status).toBe(409);
    // Missing timezone confirmation is a mapping error (T06).
    const bad = await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { ...imp.detection.proposal, datasetName: 'x' } });
    expect(bad.status).toBe(422);
    await c.post(`/api/v1/imports/${imp.id}/cancel`);
  });

  it('commits through the durable job and activates one dataset version', async () => {
    const { imp, val } = await importFile(c, accountId, GOLDEN, { datasetName: 'Golden', coverageStart: '2026-09-01', coverageEnd: '2026-10-14' }, 'golden.csv');
    expect(val!.status).toBe(200);
    expect(val!.body.data.ok).toBe(true);
    expect(val!.body.data.acceptedRows).toBe(3);
    const done = await commit(c, imp.id);
    expect(done.status).toBe('completed');
    const ds = await c.get(`/api/v1/accounts/${accountId}/datasets`);
    expect(ds.body.data).toHaveLength(1);
    datasetId = ds.body.data[0].id;
    expect(ds.body.data[0].activeVersion).toBe(1);
    expect(ds.body.data[0].coverageStart).toBe('2026-09-01');
  });

  it('overview matches the golden calculations exactly (T51 source values)', async () => {
    const res = await c.post('/api/v1/reports/overview', {
      accountId,
      datasetId,
      period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' },
      comparison: 'preceding_equal_duration',
    });
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(metric(r, 'sent').current.value).toBe('10200');
    expect(metric(r, 'delivered').current.value).toBe('10000');
    expect(metric(r, 'revenue').current.value).toBe('9500');
    expect(metric(r, 'revenue').current.currency).toBe('USD');
    expect(metric(r, 'delivered_rate').current.value.startsWith('98.039215686')).toBe(true);
    expect(metric(r, 'total_open_rate').current.value).toBe('28');
    expect(metric(r, 'total_click_rate').current.value).toBe('4.7');
    expect(metric(r, 'conversion_event_rate').current.value).toBe('0.95');
    expect(metric(r, 'unsubscribe_rate').current.value).toBe('0.1');
    expect(metric(r, 'revenue_per_delivered').current.value).toBe('0.95');
    expect(metric(r, 'revenue_per_1000_delivered').current.value).toBe('950');
    // Comparison: preceding 7 days contains TEST-CAMP-C (open rate 25%, revenue 10,000).
    expect(metric(r, 'total_open_rate').absoluteChange).toBe('3');
    expect(metric(r, 'total_open_rate').absoluteChangeUnit).toBe('pp');
    expect(metric(r, 'total_open_rate').relativeChangePct).toBe('12');
    expect(metric(r, 'revenue').absoluteChange).toBe('-500');
    expect(metric(r, 'revenue').absoluteChangeUnit).toBe('money');
    expect(metric(r, 'revenue').relativeChangePct).toBe('-5');
    // Unique measures are not in the file: unavailable, never zero.
    expect(metric(r, 'unique_open_rate').current.value).toBeNull();
    expect(metric(r, 'average_order_value').current.value).toBeNull();
    expect(r.campaigns).toHaveLength(2);
    expect(r.meta.datasetVersionIds).toHaveLength(1);
    expect(r.meta.coverageStatus).toBe('complete');
    // Every finding cites evidence that exists in the report.
    const ids = new Set(r.evidence.map((e: any) => e.id));
    for (const f of r.findings) for (const id of f.evidenceIds) expect(ids.has(id)).toBe(true);
  });

  it('identical requests reuse one snapshot; exports read that snapshot (T51)', async () => {
    const body = { accountId, datasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' } };
    const a = (await c.post('/api/v1/reports/overview', body)).body.data;
    const b = (await c.post('/api/v1/reports/overview', body)).body.data;
    expect(b.meta.reportId).toBe(a.meta.reportId);
    const fetched = await c.get(`/api/v1/reports/${a.meta.reportId}`);
    expect(fetched.body.data.meta.resultHash).toBe(a.meta.resultHash);
    const csv = await c.get(`/api/v1/reports/${a.meta.reportId}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(a.meta.reportId);
    expect(csv.text).toContain('total_open_rate,Total open rate,28,percent');
    expect(csv.text).toContain('unique_open_rate,Unique open rate,Unavailable');
    const md = await c.get(`/api/v1/reports/${a.meta.reportId}/export?format=md`);
    expect(md.text).toContain('Measured results');
    const json = await c.get(`/api/v1/reports/${a.meta.reportId}/export?format=json`);
    expect(JSON.parse(json.text).meta.resultHash).toBe(a.meta.resultHash);
  });

  it('T02: a covered period with no launches gives zero counts, unavailable ratios, and no fabricated totals', async () => {
    const res = await c.post('/api/v1/reports/overview', { accountId, datasetId, period: { preset: 'custom', startDate: '2026-09-05', endDate: '2026-09-06' } });
    const r = res.body.data;
    expect(metric(r, 'sent').current.value).toBe('0');
    expect(metric(r, 'revenue').current.value).toBe('0');
    expect(metric(r, 'total_open_rate').current.value).toBeNull();
    expect(r.campaigns).toEqual([]);
  });

  it('a period outside coverage is unavailable, not zero, and claims no trend', async () => {
    const res = await c.post('/api/v1/reports/overview', { accountId, datasetId, period: { preset: 'custom', startDate: '2025-01-01', endDate: '2025-01-31' } });
    const r = res.body.data;
    expect(r.meta.coverageStatus).toBe('outside_coverage');
    expect(metric(r, 'sent').current.value).toBeNull();
    expect(metric(r, 'sent').current.reason).toBe('missing_history');
    expect(metric(r, 'sent').absoluteChange).toBeNull();
  });

  it('campaign report, benchmarks, and T35 unknown campaign 404', async () => {
    const list = await c.get(`/api/v1/datasets/${datasetId}/campaigns`);
    const a = list.body.data.find((x: any) => x.externalId === 'TEST-CAMP-A');
    const b = list.body.data.find((x: any) => x.externalId === 'TEST-CAMP-B');
    const rep = await c.post('/api/v1/reports/campaign', {
      accountId,
      datasetId,
      campaignId: a.campaignId,
      period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' },
      benchmark: { type: 'campaign', campaignId: b.campaignId },
    });
    expect(rep.status).toBe(200);
    const r = rep.body.data;
    expect(r.metrics.find((m: any) => m.metricId === 'total_open_rate').current.value).toBe('10');
    expect(r.benchmarkComparison.find((m: any) => m.metricId === 'total_open_rate').previous.value).toBe('30');
    expect(r.launches).toHaveLength(1);
    const missing = await c.post('/api/v1/reports/campaign', { accountId, datasetId, campaignId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
  });

  it('comparison report computes differences against the chosen baseline', async () => {
    const list = (await c.get(`/api/v1/datasets/${datasetId}/campaigns`)).body.data;
    const ids = list.map((x: any) => x.campaignId);
    const res = await c.post('/api/v1/reports/comparison', { accountId, datasetId, campaignIds: ids, period: { preset: 'custom', startDate: '2026-09-01', endDate: '2026-10-14' } });
    expect(res.status).toBe(200);
    expect(res.body.data.campaigns).toHaveLength(3);
    expect(res.body.data.compatibility.compatible).toBe(true);
    expect(res.body.data.differences).toHaveLength(2);
  });

  it('T11: uploading the identical file again is recognised as already imported', async () => {
    const up = await upload(c, accountId, GOLDEN, 'golden-again.csv');
    expect(up.status).toBe(201);
    expect(up.body.data.status).toBe('cancelled');
    expect(up.body.data.duplicateOf).toBeTruthy();
    const ds = await c.get(`/api/v1/accounts/${accountId}/datasets`);
    expect(ds.body.data).toHaveLength(1);
  });

  it('T12: a corrected file supersedes atomically and rollback restores the previous revision', async () => {
    const corrected = GOLDEN.replace('TEST-CAMP-A,Test campaign A,L-A1,Email,2026-10-01,1020,1000,20,100', 'TEST-CAMP-A,Test campaign A,L-A1,Email,2026-10-01,1020,1000,20,300');
    const { imp, val } = await importFile(c, accountId, corrected, { datasetName: 'Golden', targetDatasetId: datasetId, coverageStart: '2026-09-01', coverageEnd: '2026-10-14' }, 'golden-corrected.csv');
    expect(val!.body.data.ok).toBe(true);
    expect((await commit(c, imp.id)).status).toBe('completed');
    const body = { accountId, datasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' } };
    const after = (await c.post('/api/v1/reports/overview', body)).body.data;
    expect(metric(after, 'total_opens').current.value).toBe('3000');
    const versions = (await c.get(`/api/v1/datasets/${datasetId}/versions`)).body.data;
    expect(versions.map((v: any) => [v.version, v.status])).toEqual([[2, 'active'], [1, 'superseded']]);
    const rb = await c.post(`/api/v1/datasets/${datasetId}/rollback`, { versionId: versions[1].id });
    expect(rb.status).toBe(200);
    const restored = (await c.post('/api/v1/reports/overview', body)).body.data;
    expect(metric(restored, 'total_opens').current.value).toBe('2800');
    expect(restored.meta.dataRevision).not.toBe(after.meta.dataRevision);
  });

  it('T28: a crash after staging leaves no partial activation and no duplicated totals on retry', async () => {
    const changed = GOLDEN + 'TEST-CAMP-D,Test campaign D,L-D1,Email,2026-10-03,100,100,0,10,1,0,0.00,0\n';
    const { imp } = await importFile(c, accountId, changed, { datasetName: 'Golden', targetDatasetId: datasetId, coverageStart: '2026-09-01', coverageEnd: '2026-10-14' }, 'golden-d.csv');
    await c.post(`/api/v1/imports/${imp.id}/commit`);
    // Simulate a crashed earlier attempt: a staged version for this import with stray facts.
    const s = await c.get('/api/v1/session');
    const ws = s.body.data.workspace.id;
    await h.db.withTenant({ workspaceId: ws }, async (tx) => {
      const v = await tx.query(
        `INSERT INTO dataset_versions (workspace_id, dataset_id, account_id, version, status, import_job_id, timezone, currency, content_signature)
         VALUES ($1, $2, $3, 99, 'staged', $4, 'America/New_York', 'USD', 'crashed') RETURNING id`,
        [ws, datasetId, accountId, imp.id]
      );
      const camp = await tx.query(`SELECT id FROM campaigns WHERE external_id = 'TEST-CAMP-A'`);
      await tx.query(
        `INSERT INTO campaign_launch_facts (workspace_id, account_id, dataset_version_id, campaign_id, channel, launch_date, campaign_name, currency, sent, source_row)
         VALUES ($1, $2, $3, $4, 'Email', '2026-10-01', 'stray', 'USD', 999999, 2)`,
        [ws, accountId, v.rows[0].id, camp.rows[0].id]
      );
    });
    await h.drainJobs();
    expect((await c.get(`/api/v1/imports/${imp.id}`)).body.data.status).toBe('completed');
    const r = (await c.post('/api/v1/reports/overview', { accountId, datasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' } })).body.data;
    expect(metric(r, 'sent').current.value).toBe('10300');
    const versions = (await c.get(`/api/v1/datasets/${datasetId}/versions`)).body.data;
    expect(versions.filter((v: any) => v.status === 'active')).toHaveLength(1);
    expect(versions.some((v: any) => v.status === 'staged')).toBe(false);
  });
});

describe('legacy account-period summary import', () => {
  let c: Client;
  let accountId: string;
  let datasetId: string;

  beforeAll(async () => {
    c = await signIn(h.app);
    ({ accountId } = await setupWorkspace(c, { timezone: 'UTC', currency: 'USD' }));
  });

  it('T05/T06: requires meaning of dates and rates, then shows only supported KPIs', async () => {
    const up = await upload(c, accountId, LEGACY, 'legacy.csv');
    const imp = up.body.data;
    expect(imp.format).toBe('legacy_summary');
    expect(imp.detection.requiredDecisions).toEqual(expect.arrayContaining(['asOfDate', 'windowEnd', 'openRateMeaning', 'clickRateMeaning', 'conversionsMeaning']));
    const noMeaning = await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Legacy', asOfDate: '2026-10-15', windowEnd: 'end_of_previous_day' } });
    expect(noMeaning.status).toBe(200);
    expect(noMeaning.body.data.ok).toBe(false);
    expect(noMeaning.body.data.errors.map((e: any) => e.code)).toContain('meaning_required');
    const ok = await c.post(`/api/v1/imports/${imp.id}/validate`, {
      mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Legacy', asOfDate: '2026-10-15', windowEnd: 'end_of_previous_day', openRateMeaning: 'unique', clickRateMeaning: 'not_stated', conversionsMeaning: 'events' },
    });
    expect(ok.body.data.ok).toBe(true);
    expect(ok.body.data.windows).toEqual(['Last 7 Days', 'Last 14 Days', 'Last 30 Days']);
    expect((await commit(c, imp.id)).status).toBe('completed');
    datasetId = (await c.get(`/api/v1/accounts/${accountId}/datasets`)).body.data[0].id;

    const rep = await c.post('/api/v1/reports/overview', { accountId, datasetId, windowKey: 'last_7_days' });
    expect(rep.status).toBe(200);
    const r = rep.body.data;
    expect(r.period.startDate).toBe('2026-10-08');
    expect(r.period.endDateExclusive).toBe('2026-10-15');
    expect(metric(r, 'sent').current.value).toBe('10200');
    expect(metric(r, 'revenue').current.value).toBe('9500');
    // Derived previous window: Last 14 Days − Last 7 Days.
    expect(metric(r, 'sent').previous.value).toBe('10200');
    expect(metric(r, 'revenue').previous.value).toBe('9500');
    expect(metric(r, 'conversion_events').previous.value).toBe('85');
    expect(r.comparison.derivation).toContain('Last 14 Days');
    // Source rates are kept as reported, with the confirmed meaning, and are not differenced.
    const open = r.sourceRates.find((s: any) => s.metricId === 'reported_unique_open_rate');
    expect(open.current.value).toBe('28');
    expect(open.absoluteChange).toBeNull();
    expect(r.sourceRates.find((s: any) => s.metricId === 'reported_click_rate').current.value).toBe('4.7');
    // Summary data does not establish campaign or hourly facts.
    expect(r.campaigns).toEqual([]);
    expect(r.capabilities.find((x: any) => x.key === 'campaign_detail').status).toBe('unavailable');
    expect(r.capabilities.find((x: any) => x.key === 'hourly').status).toBe('unavailable');
  });

  it('a window with no nested double-length window has no comparison', async () => {
    const r = (await c.post('/api/v1/reports/overview', { accountId, datasetId, windowKey: 'last_30_days' })).body.data;
    expect(r.comparison).toBeNull();
    expect(metric(r, 'sent').note).toBe('No comparison period');
  });

  it('a window not in the file is refused rather than invented', async () => {
    const res = await c.post('/api/v1/reports/overview', { accountId, datasetId, windowKey: 'last_90_days' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Last 7 Days');
  });

  it('campaign reports are refused for summary data', async () => {
    const res = await c.post('/api/v1/reports/campaign', { accountId, datasetId, campaignId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(422);
  });

  it('T14: shrinking cumulative windows are a data-quality conflict, never clamped to zero', async () => {
    const bad = LEGACY.replace('"20,400","20,000"', '"9,000","9,000"').replace('"$19,000.00"', '"$19,000.01"');
    const { imp, val } = await importFile(c, accountId, bad, { datasetName: 'Legacy bad', asOfDate: '2026-10-15', windowEnd: 'end_of_previous_day', openRateMeaning: 'unique', clickRateMeaning: 'unique', conversionsMeaning: 'events' }, 'legacy-bad.csv');
    expect(val!.body.data.ok).toBe(true);
    expect(val!.body.data.conflicts.join(' ')).toMatch(/smaller than/);
    await commit(c, imp.id);
    const ds = (await c.get(`/api/v1/accounts/${accountId}/datasets`)).body.data.find((d: any) => d.name === 'Legacy bad');
    const r = (await c.post('/api/v1/reports/overview', { accountId, datasetId: ds.id, windowKey: 'last_7_days' })).body.data;
    const sent = metric(r, 'sent');
    expect(sent.previous.value).toBeNull();
    expect(sent.previous.availability).toBe('conflicted');
    expect(r.meta.warnings.join(' ')).toMatch(/negative/);
  });
});

describe('strict parsing (T07, T08, T09, T47)', () => {
  let c: Client;
  let accountId: string;
  beforeAll(async () => {
    c = await signIn(h.app);
    ({ accountId } = await setupWorkspace(c));
  });

  it('handles BOM, quoted delimiters, embedded newlines, CRLF and semicolons', async () => {
    const csv = '﻿Campaign ID;Campaign Name;Channel;Launch Date;Sent;Delivered;Revenue\r\nC1;"Name; with ""quotes""\r\nand newline";Email;2026-10-01;"1.000";"900";"1.234,50"\r\n';
    const up = await upload(c, accountId, csv, 'semi.csv');
    const imp = up.body.data;
    expect(imp.detection.delimiter).toBe(';');
    expect(imp.detection.numberFormatCandidates.length).toBeGreaterThan(0);
    const val = await c.post(`/api/v1/imports/${imp.id}/validate`, {
      mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Semi', numberFormat: { decimal: ',', thousands: '.' } },
    });
    expect(val.body.data.ok).toBe(true);
    expect(val.body.data.preview[0].campaignName).toBe('Name; with "quotes"\r\nand newline');
    expect(val.body.data.preview[0].sent).toBe('1000');
    expect(val.body.data.preview[0].revenue).toBe('1234.5');
  });

  it('ambiguous thousands/decimal values require a number-format decision', async () => {
    const csv = 'Campaign ID,Channel,Launch Date,Sent,Revenue\nC1,Email,2026-10-01,"1,234","1,500"\n';
    const imp = (await upload(c, accountId, csv, 'amb.csv')).body.data;
    expect(imp.detection.requiredDecisions).toContain('numberFormat');
  });

  it('rejects invalid numbers, negatives, and fractional counts with row/column references', async () => {
    const csv = 'Campaign ID,Channel,Launch Date,Sent,Delivered,Revenue\nC1,Email,2026-10-01,12abc,10,5\nC2,Email,2026-10-01,-5,1,5\nC3,Email,2026-10-01,10.5,1,5\nC4,Email,2026-02-30,10,1,5\n';
    const imp = (await upload(c, accountId, csv, 'bad.csv')).body.data;
    const val = await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { ...imp.detection.proposal, dateFormat: 'YYYY-MM-DD', timezoneConfirmed: true, datasetName: 'Bad' } });
    const codes = val.body.data.errors.map((e: any) => `${e.row}:${e.code}`);
    expect(codes).toEqual(expect.arrayContaining(['2:invalid_number', '3:negative_count', '4:fractional_count', '5:invalid_date']));
    expect(val.body.data.ok).toBe(false);
    expect((await c.post(`/api/v1/imports/${imp.id}/commit`)).status).toBe(409);
  });

  it('T09: blank stays unavailable while zero stays zero', async () => {
    const csv = 'Campaign ID,Channel,Launch Date,Sent,Delivered,Total Opens\nC1,Email,2026-10-01,100,100,0\nC2,Email,2026-10-02,100,100,\n';
    const { imp, val } = await importFile(c, accountId, csv, { datasetName: 'Blank', coverageStart: '2026-10-01', coverageEnd: '2026-10-02' }, 'blank.csv');
    expect(val!.body.data.ok).toBe(true);
    await commit(c, imp.id);
    const ds = (await c.get(`/api/v1/accounts/${accountId}/datasets`)).body.data.find((d: any) => d.name === 'Blank');
    const r1 = (await c.post('/api/v1/reports/overview', { accountId, datasetId: ds.id, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-01' } })).body.data;
    expect(metric(r1, 'total_opens').current.value).toBe('0');
    const r2 = (await c.post('/api/v1/reports/overview', { accountId, datasetId: ds.id, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-02' } })).body.data;
    expect(metric(r2, 'total_opens').current.value).toBeNull();
    expect(metric(r2, 'total_opens').current.reason).toBe('partial_field');
  });

  it('T47: binary/spreadsheet uploads are refused and formula text stays inert', async () => {
    const xlsx = await upload(c, accountId, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'data.xlsx');
    expect(xlsx.status).toBe(422);
    const bin = await upload(c, accountId, Buffer.from([0x41, 0x00, 0x42, 0x2c, 0x0a]), 'data.csv');
    expect(bin.status).toBe(422);
    const formula = 'Campaign ID,Campaign Name,Channel,Launch Date,Sent\nC1,"=HYPERLINK(""http://x"")",Email,2026-10-01,5\n';
    const imp = (await upload(c, accountId, formula, 'f.csv')).body.data;
    expect(imp.detection.sampleRows[1][1]).toBe(`'=HYPERLINK("http://x")`);
    // A bare quote inside an unquoted cell is malformed CSV and is reported, not guessed.
    const malformed = (await upload(c, accountId, 'Campaign ID,Channel,Launch Date,Sent\nC1,=X("y"),Email,5\n', 'm.csv')).body.data;
    expect(malformed.format).toBe('unknown');
    expect(malformed.errorMessage).toMatch(/could not be parsed/);
  });

  it('empty or unrecognised files cannot produce a dashboard', async () => {
    const empty = await upload(c, accountId, '   \n', 'empty.csv');
    expect(empty.body.data.status).toBe('needs_mapping');
    expect(empty.body.data.format).toBe('unknown');
    expect(empty.body.data.errorMessage).toMatch(/empty/i);
    const unknown = (await upload(c, accountId, 'foo,bar\n1,2\n', 'u.csv')).body.data;
    expect(unknown.format).toBe('unknown');
    const val = await c.post(`/api/v1/imports/${unknown.id}/validate`, { mapping: { format: 'campaign_metrics' } });
    expect(val.status).toBe(422);
  });

  it('T15: rows in a different currency are rejected, never summed', async () => {
    const csv = 'Campaign ID,Channel,Launch Date,Sent,Revenue,Currency\nC1,Email,2026-10-01,10,5,USD\nC2,Email,2026-10-01,10,5,BRL\n';
    const imp = (await upload(c, accountId, csv, 'cur.csv')).body.data;
    const val = await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Cur' } });
    expect(val.body.data.errors.map((e: any) => e.code)).toContain('currency_mismatch');
  });
});

describe('settings from a different file are refused', () => {
  it('rejects a summary-export mapping sent for a campaign file instead of misreading its columns', async () => {
    const c = await signIn(h.app);
    const { accountId } = await setupWorkspace(c, { timezone: 'UTC', currency: 'USD' });
    const legacy = (await upload(c, accountId, LEGACY, 'summary.csv')).body.data;
    const campaign = (await upload(c, accountId, GOLDEN, 'campaigns.csv')).body.data;
    expect(legacy.format).toBe('legacy_summary');
    expect(campaign.format).toBe('campaign_metrics');

    const wrongKind = await c.post(`/api/v1/imports/${campaign.id}/validate`, {
      mapping: { ...legacy.detection.proposal, timezoneConfirmed: true, datasetName: 'Old', asOfDate: '2026-10-15', windowEnd: 'end_of_previous_day', openRateMeaning: 'unique', clickRateMeaning: 'unique', conversionsMeaning: 'events' },
    });
    expect(wrongKind.status).toBe(422);
    expect(wrongKind.body.error.message).toMatch(/different kind of file/);

    const farColumn = await c.post(`/api/v1/imports/${campaign.id}/validate`, {
      mapping: { ...campaign.detection.proposal, timezoneConfirmed: true, columns: { ...campaign.detection.proposal.columns, revenue: 99 } },
    });
    expect(farColumn.status).toBe(422);

    // The import is untouched and still validates with its own settings.
    const ok = await c.post(`/api/v1/imports/${campaign.id}/validate`, { mapping: { ...campaign.detection.proposal, timezoneConfirmed: true } });
    expect(ok.status).toBe(200);
  });
});

describe('program and weekday breakdowns', () => {
  it('groups the golden fixture by launch weekday and program exactly', async () => {
    const c = await signIn(h.app);
    const { accountId } = await setupWorkspace(c, { timezone: 'UTC', currency: 'USD' });
    const { imp, val } = await importFile(c, accountId, GOLDEN, { datasetName: 'Golden' }, 'golden-breakdowns.csv');
    expect(val!.status).toBe(200);
    const done = await commit(c, imp.id);
    expect(done.status).toBe('completed');
    const datasetId = done.targetDatasetId;
    const r = (await c.post('/api/v1/reports/overview', { accountId, datasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' } })).body.data;
    const m = (row: any, id: string) => row.metrics.find((x: any) => x.metricId === id)?.value;
    expect(r.byWeekday.map((w: any) => [w.label, m(w, 'delivered')])).toEqual([['Thursday', '1000'], ['Friday', '9000']]);
    expect(r.byProgram).toHaveLength(1);
    expect(r.byProgram[0].program).toBe('');
    expect(m(r.byProgram[0], 'delivered')).toBe('10000');
    expect(m(r.byProgram[0], 'total_open_rate')).toBe('28');
  });
});

describe('Save Report for every report kind', () => {
  it('exports campaign and comparison snapshots as CSV, Markdown and JSON', async () => {
    const c = await signIn(h.app);
    const { accountId } = await setupWorkspace(c, { timezone: 'UTC', currency: 'USD' });
    const { imp } = await importFile(c, accountId, GOLDEN, { datasetName: 'Golden' }, 'golden-exports.csv');
    const datasetId = (await commit(c, imp.id)).targetDatasetId;
    const camps = (await c.get(`/api/v1/datasets/${datasetId}/campaigns`)).body.data;
    const period = { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' };
    const camp = (await c.post('/api/v1/reports/campaign', { accountId, datasetId, campaignId: camps[0].campaignId, period })).body.data;
    const cmp = (await c.post('/api/v1/reports/comparison', { accountId, datasetId, campaignIds: camps.slice(0, 2).map((x: any) => x.campaignId), period })).body.data;
    for (const r of [camp, cmp]) {
      for (const format of ['csv', 'md', 'json']) {
        const res = await c.get(`/api/v1/reports/${r.meta.reportId}/export?format=${format}`);
        expect(res.status, `${r.meta.kind} ${format}`).toBe(200);
        expect(res.text.length).toBeGreaterThan(50);
      }
    }
  });
});

describe('report snapshots from older code', () => {
  it('never serves a snapshot saved in an older format (it lacks the new sections)', async () => {
    const c = await signIn(h.app);
    const { accountId, workspaceId } = await setupWorkspace(c, { timezone: 'UTC', currency: 'USD' });
    const { imp } = await importFile(c, accountId, GOLDEN, { datasetName: 'Golden' }, 'golden-format.csv');
    const datasetId = (await commit(c, imp.id)).targetDatasetId;
    const body = { accountId, datasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' } };
    const fresh = (await c.post('/api/v1/reports/overview', body)).body.data;

    // Replace it with what the previous release stored: same request, no format in the key,
    // and no byProgram/byWeekday in the result.
    await h.db.withTenant({ workspaceId }, async (tx) => {
      const { rows } = await tx.query<{ scope: any; result: any }>('SELECT scope, result FROM report_snapshots WHERE id = $1', [fresh.meta.reportId]);
      const { format: _f, ...oldScope } = rows[0]!.scope;
      const { byProgram: _p, byWeekday: _w, ...oldResult } = rows[0]!.result;
      const oldId = crypto.randomUUID();
      await tx.query('DELETE FROM report_snapshots WHERE id = $1', [fresh.meta.reportId]);
      await tx.query(
        `INSERT INTO report_snapshots (workspace_id, id, account_id, kind, scope, scope_hash, data_revision, dataset_version_ids, definition_version, result, result_hash, created_by)
         SELECT $1, $2, $3, 'overview', $4, $5, a.data_revision, $6, $7, $8, 'old', NULL FROM accounts a WHERE a.id = $3`,
        [workspaceId, oldId, accountId, JSON.stringify(oldScope), sha256(stableStringify(oldScope)), fresh.meta.datasetVersionIds, fresh.meta.definitionVersion, JSON.stringify({ ...oldResult, meta: { ...oldResult.meta, reportId: oldId } })]
      );
    });

    const again = (await c.post('/api/v1/reports/overview', body)).body.data;
    expect(Array.isArray(again.byProgram)).toBe(true);
    expect(Array.isArray(again.byWeekday)).toBe(true);
  });
});

describe('content and offer breakdowns', () => {
  it('imports account-local launch times and aggregates hour and weekday evidence independently', async () => {
    const c = await signIn(h.app);
    const { accountId } = await setupWorkspace(c, { timezone: 'America/Sao_Paulo', currency: 'BRL' });
    const csv = [
      'Campaign ID,Launch Date,Launch Time,Channel,Sent,Delivered,Unique Opens,Unique Clicks,Revenue',
      'C1,2026-10-05,09:15,Email,1000,1000,200,20,100',
      'C2,2026-10-12,09:45,Email,1000,1000,300,30,100',
      'C3,2026-10-19,09:00,Email,1000,1000,400,40,100',
      'C4,2026-10-05,15:00,Email,1000,1000,500,50,100',
      'C5,2026-10-12,15:30,Email,1000,1000,500,50,100',
      'C6,2026-10-19,15:59,Email,1000,1000,500,50,100',
    ].join('\n');
    const { imp, val } = await importFile(c, accountId, csv, { datasetName: 'Launch times' }, 'timed.csv');
    expect(val!.body.data.ok).toBe(true);
    const done = await commit(c, imp.id);
    const report = (await c.post('/api/v1/reports/overview', { accountId, datasetId: done.targetDatasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-20' } })).body.data;
    const morning = report.sendTime.find((r: any) => r.hour === 9);
    expect(morning).toMatchObject({ channel: 'Email', weekday: 1, hour: 9, launches: 3 });
    expect(morning.metrics.find((m: any) => m.metricId === 'unique_open_rate').value).toBe('30');
    expect(report.sendTime.find((r: any) => r.hour === 15).metrics.find((m: any) => m.metricId === 'unique_open_rate').value).toBe('50');
    expect(report.sendTime.find((r: any) => r.hour === null).launches).toBe(6);
    expect(report.capabilities.find((r: any) => r.key === 'hourly').status).toBe('available');
    const invalid = await importFile(c, accountId, csv.replace('09:15', '27:00'), { datasetName: 'Invalid time' }, 'bad-time.csv');
    expect(invalid.val!.body.data.errors.some((e: any) => e.code === 'invalid_launch_time')).toBe(true);
  });
  it('groups by subject line, creative type and offer exactly as written; blanks stay "not given"', async () => {
    const c = await signIn(h.app);
    const { accountId } = await setupWorkspace(c, { timezone: 'UTC', currency: 'USD' });
    const csv = [
      'Campaign ID,Campaign Name,Launch Date,Channel,Subject Line,Creative Type,Offer,Sent,Delivered,Total Opens,Total Clicks,Revenue',
      'C1,One,2026-10-01,Email,Hello,Hero image,10% off,1000,1000,300,50,100.00',
      'C2,Two,2026-10-02,Email,Hello,Plain text,,2000,2000,400,40,50.00',
      'C3,Three,2026-10-03,Email,Bye,Hero image,10% off,1000,1000,100,10,0.00',
    ].join('\n');
    const { imp, val } = await importFile(c, accountId, csv, { datasetName: 'Content' }, 'content.csv');
    expect(val!.status).toBe(200);
    const done = await commit(c, imp.id);
    expect(done.status).toBe('completed');
    const r = (await c.post('/api/v1/reports/overview', { accountId, datasetId: done.targetDatasetId, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-03' } })).body.data;
    const m = (row: any, id: string) => row.metrics.find((x: any) => x.metricId === id)?.value;
    const rows = (list: any[]) => list.map((x) => [x.value, x.launches, m(x, 'delivered'), m(x, 'total_open_rate')]);
    expect(rows(r.bySubjectLine)).toEqual([['Bye', 1, '1000', '10'], ['Hello', 2, '3000', '23.3333333333']]);
    expect(rows(r.byCreativeType)).toEqual([['Hero image', 2, '2000', '20'], ['Plain text', 1, '2000', '20']]);
    expect(rows(r.byOffer)).toEqual([['', 1, '2000', '20'], ['10% off', 2, '2000', '20']]);
  });
});
