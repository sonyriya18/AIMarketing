import React from 'react';
import { usableWebsiteOffer, type WebsiteOffer } from '../../shared/business/offers';

export function WebsiteOfferPicker({ offers, strategy, selectedId, confirmed, loading, onSelect, onConfirm }: {
  offers: WebsiteOffer[]; strategy: string; selectedId: string; confirmed: boolean; loading: boolean;
  onSelect: (id: string) => void; onConfirm: (value: boolean) => void;
}) {
  const selected = offers.find((offer) => offer.id === selectedId && usableWebsiteOffer(offer, strategy));
  return <div className="my-4 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-xs" data-testid="website-offer-picker">
    <label className="block font-bold" htmlFor="website-offer">Include a published website offer (optional)</label>
    <p className="mt-1 text-[#6b554d]">Offers are copied from the official website in their published language. No discount or performance uplift is assumed.</p>
    <select id="website-offer" value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)} className="mt-3 w-full rounded-lg border border-cyan-200 bg-white p-2">
      <option value="">Keep this campaign without an offer</option>
      {offers.map((offer) => <option key={offer.id} value={offer.id} disabled={!usableWebsiteOffer(offer, strategy)}>{offer.title}{!usableWebsiteOffer(offer, strategy) ? offer.audience === 'members' && strategy === 'reengage' ? ' · members only; excluded for inactive prospects' : ' · refresh website research' : ''}</option>)}
    </select>
    {!offers.length && <p className="mt-2">{loading ? 'Checking official website offers…' : 'No readable published offers were found. The campaign keeps its business guidance.'}</p>}
    {offers.length > 0 && !offers.some((offer) => usableWebsiteOffer(offer, strategy)) && <p className="mt-2">The retrieved offers do not match this audience or need refreshed research. This campaign keeps its business guidance.</p>}
    {selected && <div className="mt-3 space-y-2">
      <p className="font-semibold">{selected.text}</p>
      <p>Audience: {selected.audience === 'members' ? 'Existing members' : 'Not specified in the extracted copy'} · Retrieved {new Date(selected.checkedAt).toLocaleDateString()}</p>
      <p><a href={selected.landingUrl} target="_blank" rel="noreferrer" className="underline">View official offer</a> · <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="underline">Content source</a></p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} />I checked the official terms, validity and eligibility for this campaign’s audience. Include this offer in the template.</label>
      {confirmed && <p className="font-semibold">Included in both layouts below. In Responsys, map WEBSITE_OFFER to <span className="break-all">{selected.landingUrl}</span>.</p>}
    </div>}
  </div>;
}
