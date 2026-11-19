import React, { useMemo } from 'react';
import { ArrowRight, CheckCircle2, Filter, Mail, ShieldCheck, Users } from 'lucide-react';
import type { ProgramFlow } from '../features/planner/flow';
import { campaignObjects, conditionObjects, programObjects } from '../features/planner/details';
import { RESPONSYS_FIELDS_SOURCE, type JourneyCampaign, type JourneyCondition, type JourneyPlan } from '../../shared/scenario/journeys';
import type { ContentPack } from '../content/packs';
import type { Account } from '../lib/types';
import type { AmilTemplate } from '../data/amilTemplates';
import { buildEmailRpl, renderRpl } from '../utils/rplEngine';
import { EmailFrame } from './TemplatePreviews';

function Conditions({ title, hint, rows, icon: Icon }: { title: string; hint: string; rows: JourneyCondition[]; icon: React.ElementType }) {
  return <div className="rounded-xl border border-[#e8dcc9] bg-white p-4">
    <h4 className="flex items-center gap-2 text-sm font-bold"><Icon className="h-4 w-4 text-[#C74634]" />{title}</h4>
    <p className="mt-1 text-[11px] text-[#8a7668]">{hint}</p>
    <ul className="mt-3 space-y-3">{rows.map((row, i) => <li key={`${row.field}-${i}`} className="text-[11px]">
      <code className="block break-all font-semibold text-indigo-800">{row.field}</code>
      <span className="block mt-0.5 font-bold">{row.condition}</span>
      <span className="block text-[#6b554d]">{row.purpose}</span>
      <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-semibold ${row.source === 'standard' ? 'bg-sky-50 text-sky-800' : 'bg-amber-50 text-amber-900'}`}>{row.source === 'standard' ? 'Responsys standard field · verify list mapping' : row.source === 'custom' ? 'Proposed custom field · mapping required' : 'Program activity · configure tracking'}</span>
    </li>)}</ul>
  </div>;
}

export function JourneyCampaigns({ flow, journey, account, pack, campaign, templates, template, onCampaign, onTemplate, offerControl }: {
  flow: ProgramFlow; journey: JourneyPlan; account: Account; pack: ContentPack; campaign: JourneyCampaign | null; templates: AmilTemplate[]; template: AmilTemplate | null;
  onCampaign: (id: string) => void; onTemplate: (id: string) => void;
  offerControl?: React.ReactNode;
}) {
  const preview = useMemo(() => template?.email ? renderRpl(buildEmailRpl(template.email, { mode: 'rpl', preferencesLink: true, brand: pack.brand(account) }), pack.profiles[0]!.data) : '', [template, pack, account]);
  const conditions = conditionObjects(flow, journey);
  const campaigns = campaignObjects(flow, journey);
  const otherObjects = programObjects(flow).filter((node) => !node.conditionGroup && node.type !== 'email');
  return <div className="space-y-5">
    <div className="rounded-xl bg-indigo-50 p-3 text-xs text-indigo-950">
      <strong>Details of the program shown above.</strong> Each section below corresponds to an object in that flow. CONTACTS_LIST is a placeholder for your profile list; map the suggested PETs and fields to your account. The aggregate report cannot verify these fields or count matching recipients.
      <a className="ml-1 underline" href={RESPONSYS_FIELDS_SOURCE} target="_blank" rel="noreferrer">System field reference</a>
    </div>
    <div className={`grid grid-cols-1 ${conditions.length > 2 ? 'lg:grid-cols-3' : 'lg:grid-cols-2'} gap-3`} data-testid="journey-conditions">
      {conditions.map(({ node, group, rows }) => <Conditions key={node.id} title={group === 'entry' ? 'Entry conditions' : group === 'exclusions' ? 'Exclusion conditions' : 'Filter conditions'} hint={`${node.title} · ${group === 'entry' ? 'All entry conditions must match.' : group === 'exclusions' ? 'Exclude matching records at this object.' : 'All conditions must match at this filter.'}`} rows={rows} icon={group === 'entry' ? Users : group === 'exclusions' ? ShieldCheck : Filter} />)}
    </div>
    {otherObjects.length > 0 && <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3" data-testid="program-object-details">
      {otherObjects.map((node) => <div key={node.id} data-program-object={node.id} className="rounded-xl border border-[#e8dcc9] bg-white p-3 text-xs">
        <span className="block text-[10px] uppercase font-semibold text-[#8a7668]">{node.type}</span>
        <strong className="block mt-1">{node.title}</strong>
        {node.type === 'decision' ? <div className="mt-2 space-y-2 text-[11px] text-[#6b554d]">
          {node.criteria?.map((row, i) => <div key={i}><code className="block break-all text-indigo-800">{row.field}</code><span className="font-semibold">{row.condition}</span><span className="block text-[10px]">{row.purpose}</span><span className="inline-block mt-1 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-900">{row.source === 'standard' ? 'Standard field · verify mapping' : row.source === 'activity' ? 'Campaign activity · configure tracking' : 'Proposed field · mapping required'}</span></div>)}
          <p>Yes → {node.branches?.yes.map((item) => item.title).join(' → ')}</p><p>No → {node.branches?.no.map((item) => item.title).join(' → ')}</p>
        </div> : node.sub ? <p className="mt-1 text-[11px] text-[#6b554d]">{node.sub}</p> : null}
      </div>)}
    </div>}
    <div>
      <h4 className="text-sm font-bold">{campaigns.length === 2 ? 'Two email campaigns in this program' : `${campaigns.length} email campaign${campaigns.length === 1 ? '' : 's'} in this program`}</h4>
      <p className="text-xs text-[#8a7668] mt-1">Select an email object from this program to view its matching templates.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">{campaigns.map(({ node, campaign: item }) => <button key={node.id} type="button" data-journey-campaign={item.id} aria-pressed={campaign?.id === item.id} onClick={() => onCampaign(item.id)} className={`rounded-2xl border-2 bg-white p-4 text-left transition ${campaign?.id === item.id ? 'border-[#C74634] shadow-md' : 'border-[#ece6df] hover:border-[#C74634]/50'}`}>
        <span className="flex items-center gap-2 text-[10px] font-semibold text-[#8a7668]"><Mail className="h-4 w-4 text-[#C74634]" />{node.sub || 'Email campaign'}</span>
        <span className="block mt-2 text-sm font-bold">{item.name}</span>
        <span className="block mt-1 text-xs text-[#6b554d]">{item.purpose}</span>
        <span className="inline-flex items-center gap-1 mt-3 text-[11px] font-semibold text-indigo-700">{campaign?.id === item.id ? <><CheckCircle2 className="h-3 w-3" />Selected · templates below</> : <>Choose campaign and view templates <ArrowRight className="h-3 w-3" /></>}</span>
      </button>)}</div>
    </div>
    {!campaign ? <p className="rounded-xl border border-dashed border-[#d9cfc4] p-5 text-center text-xs text-[#6b554d]">Select an initial or follow-up campaign to view its email templates.</p> : <div className="rounded-xl border border-[#e8dcc9] bg-white p-4" data-testid="campaign-template-area">
      <h4 className="text-sm font-bold">{campaign.name} · email templates</h4>
      <p className="mt-1 text-[11px] text-[#8a7668]">{pack.label}. Each layout contains copy for this campaign. Review link-table destinations and business copy before using the draft.</p>
      {offerControl}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-4 mt-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 content-start gap-3">
          {templates.map((item) => <button key={item.id} type="button" data-template={item.id} aria-pressed={item.id === template?.id} onClick={() => onTemplate(item.id)} className={`rounded-xl border-2 overflow-hidden text-left ${item.id === template?.id ? 'border-violet-600 shadow-md' : 'border-[#ece6df]'}`}>
            <div className={`relative h-28 p-4 overflow-hidden ${journey.business === 'dental' ? 'bg-gradient-to-r from-[#461bff] to-[#00adff]' : 'bg-[#243551]'} text-white`}>
              {item.email?.heroImage && <img alt="" src={item.email.heroImage} className="absolute inset-0 w-full h-full object-cover opacity-25" />}
              <span className="relative block text-[10px] uppercase font-bold">{account.name}</span>
              <span className="relative block mt-2 text-sm font-bold">{item.email?.headline}</span>
            </div>
            <span className="block p-3"><span className="block text-xs font-bold">{item.name}</span><span className="block mt-1 text-[10px] text-[#8a7668]">{item.bestFor}</span></span>
          </button>)}
        </div>
        <div className="min-w-0 rounded-xl border border-[#e8dcc9] overflow-hidden">
          <p className="bg-[#faf6f1] px-3 py-2 text-[11px] font-semibold">Selected email preview · {template?.name}</p>
          <div className="max-w-full overflow-x-auto"><EmailFrame html={preview} width={600} height={480} title="Selected campaign email preview" /></div>
        </div>
      </div>
    </div>}
  </div>;
}
