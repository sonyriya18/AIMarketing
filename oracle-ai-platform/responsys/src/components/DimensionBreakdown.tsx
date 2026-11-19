/**
 * Results grouped by a text column from the imported file (Subject Line, Creative Type, Offer).
 * Rows without a value are listed as "Not given". Leaders need at least one delivered message;
 * "best" is the highest observed rate, not a cause.
 */
import React from 'react';
import type { DimensionRow, MetricValue } from '../lib/types';
import { clickRate, metricOf, num, openRate, show } from '../lib/metrics';

const leader = (rows: DimensionRow[], pick: (m: MetricValue[]) => MetricValue | undefined) =>
  rows
    .map((row) => ({ row, v: num(pick(row.metrics)) }))
    .filter((x) => x.v !== null)
    .sort((a, b) => b.v! - a.v!)[0];

export const DimensionBreakdown: React.FC<{ rows: DimensionRow[]; noun: string; limit?: number; mono?: boolean }> = ({ rows, noun, limit = 10, mono = false }) => {
  const named = rows.filter((x) => x.value && (num(metricOf(x.metrics, 'delivered')) ?? 0) > 0);
  const missing = rows.find((x) => !x.value);
  const sorted = [...named].sort((a, b) => (num(metricOf(b.metrics, 'delivered')) ?? 0) - (num(metricOf(a.metrics, 'delivered')) ?? 0));
  const cards = [
    { t: `Best open rate`, b: leader(named, openRate), m: (x: DimensionRow) => show(openRate(x.metrics)) },
    { t: `Best click rate`, b: leader(named, clickRate), m: (x: DimensionRow) => show(clickRate(x.metrics)) },
    { t: `Best revenue per delivered`, b: leader(named, (m) => metricOf(m, 'revenue_per_delivered')), m: (x: DimensionRow) => show(metricOf(x.metrics, 'revenue_per_delivered')) },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cards.map((c) => (
          <div key={c.t} className="p-3 rounded-xl border border-[#e8dcc9] bg-white min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#8d563b]">{c.t} ({noun})</div>
            <div className={`text-sm font-bold text-[#2d241d] mt-1 truncate ${mono ? 'font-mono' : ''}`} title={c.b?.row.value}>{c.b ? c.b.row.value : 'Unavailable'}</div>
            <div className="text-[11px] text-[#6b554d]">{c.b ? `${c.m(c.b.row)} · ${c.b.row.launches} launch${c.b.row.launches === 1 ? '' : 'es'}` : 'Not measurable in this data'}</div>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-left text-[#8a7668]">
            <tr><th className="py-1 capitalize">{noun}</th><th>Campaigns</th><th>Launches</th><th>Delivered</th><th>Open rate</th><th>Click rate</th><th>Conversion rate</th><th>Revenue</th></tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((x) => (
              <tr key={x.value} className="border-t border-[#efe3d6] font-mono">
                <td className="py-1 font-sans font-semibold max-w-xs truncate" title={x.value}>{x.value}</td>
                <td>{x.campaigns}</td>
                <td>{x.launches}</td>
                <td>{show(metricOf(x.metrics, 'delivered'))}</td>
                <td>{show(openRate(x.metrics))}</td>
                <td>{show(clickRate(x.metrics))}</td>
                <td>{show(metricOf(x.metrics, 'conversion_event_rate'))}</td>
                <td>{show(metricOf(x.metrics, 'revenue'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#8a7668]">
        {sorted.length > limit ? `Showing the ${limit} with the most delivered messages of ${sorted.length}. ` : ''}
        {missing ? `${missing.launches} launch${missing.launches === 1 ? '' : 'es'} had no ${noun} in the file and are not included. ` : ''}
        Differences are observed results, not proof that the {noun} caused them.
      </p>
    </div>
  );
};
