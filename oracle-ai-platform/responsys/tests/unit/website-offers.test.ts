import { describe, expect, it } from 'vitest';
import { websiteOffers } from '../../server/modules/insights/business-offers';
import { usableWebsiteOffer, WebsiteOfferSchema } from '../../shared/business/offers';
import { withWebsiteOffer, journeyEmailTemplates } from '../../src/content/journeyTemplates';
import { EmailContentSchema } from '../../shared/contracts/drafts';
import { JourneyRecordSchema, journeyFor } from '../../shared/scenario/journeys';

const checkedAt = new Date().toISOString();
const source = 'https://dental.example.com/ccstore/v1/pages/home';
const landing = 'https://dental.example.com/';
const raw = JSON.stringify({ regions: [{ benefitsCardsConfiguration: "[{'1':'Pharmacy discount','2':'Up to 20% discount at participating stores. Terms apply.','3':'pharmacy'},{'1':'Exclusive offer','2':'Members only: exclusive aligner conditions.','3':'aligners'}]" }] });

describe('published website offers', () => {
  it('reads structured storefront offers without executing configuration and preserves qualified wording', () => {
    const offers = websiteOffers(raw, source, landing, checkedAt, true);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ text: 'Up to 20% discount at participating stores. Terms apply.', landingUrl: `${landing}#pharmacy`, sourceUrl: source, checkedAt });
    expect(offers[1]!.audience).toBe('members');
    offers.forEach((offer) => expect(WebsiteOfferSchema.safeParse(offer).success).toBe(true));
    expect(websiteOffers('{bad data}', source, landing, checkedAt, true)).toEqual([]);
  });
  it('reads complete HTML promotion blocks and ignores scripts, external links and dynamic placeholders', () => {
    const html = '<script><section><h2>Fake offer</h2>Free everything for everyone.</section></script><section><h2>Welcome offer</h2><p>Save 10% on selected plans. New customers only.</p></section>';
    const offers = websiteOffers(html, landing, landing, checkedAt);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.text).toContain('New customers only.');
    expect(websiteOffers('<section><h2>Discount</h2><p>${UNTRUSTED} discount is available</p></section>', landing, landing, checkedAt)).toEqual([]);
  });
  it('inherits member-only eligibility and the terms destination from its surrounding benefit section', () => {
    const data = JSON.parse(raw);
    Object.assign(data.regions[0], { benefitsSectionTitleMobile: 'Benefícios por ser Amil Dental', benefitsSectionCTALink: '/beneficios-dental' });
    const offers = websiteOffers(JSON.stringify(data), source, landing, checkedAt, true);
    expect(offers.every((offer) => offer.audience === 'members')).toBe(true);
    expect(offers[0]!.landingUrl).toBe('https://dental.example.com/beneficios-dental#pharmacy');
    data.regions[0].hidden = true;
    expect(websiteOffers(JSON.stringify(data), source, landing, checkedAt, true)).toEqual([]);
    data.regions[0].hidden = false;
    data.regions[0].benefitsSectionCTALink = 'https://unrelated.example.com/';
    expect(websiteOffers(JSON.stringify(data), source, landing, checkedAt, true)).toEqual([]);
  });
  it('does not add offers to other strategies, stale research or member-only re-engagement prospects', () => {
    const [offer, memberOffer] = websiteOffers(raw, source, landing, checkedAt, true);
    expect(usableWebsiteOffer(offer!, 'welcome')).toBe(true);
    expect(usableWebsiteOffer(memberOffer!, 'reengage')).toBe(false);
    expect(usableWebsiteOffer(offer!, 'retention')).toBe(false);
    expect(usableWebsiteOffer(offer!, 'welcome', Date.parse(checkedAt) + 24 * 60 * 60_000)).toBe(false);
  });
  it('keeps the selected offer in valid email content and saved journey metadata with no assumed lift', () => {
    const offer = websiteOffers(raw, source, landing, checkedAt, true)[0]!;
    const template = journeyEmailTemplates('dental').find((t) => t.journeyCampaignId === 'dental-welcome-initial')!;
    const enriched = withWebsiteOffer(template, offer, 'welcome');
    expect(enriched.email!.intro).toBe(template.email!.intro);
    expect(enriched.email!.highlightType).toBe('offer');
    expect(enriched.email!.highlightLabel).toBe(offer.title);
    expect(enriched.email!.highlightValue).toBe(offer.text);
    expect(enriched.email!.ctaLink).toBe('WEBSITE_OFFER');
    expect(enriched.email!.cta2Link).toBe(template.email!.ctaLink);
    expect(enriched.email!.legal).toContain(offer.landingUrl);
    expect(EmailContentSchema.safeParse(enriched.email).success).toBe(true);
    expect(enriched.openLift).toBe(0);
    expect(withWebsiteOffer(template, undefined, 'welcome')).toBe(template);
    const journey = journeyFor('welcome', 'dental');
    expect(JourneyRecordSchema.parse({ ...journey, selectedCampaignId: journey.campaigns[0].id, selectedTemplateId: template.id, websiteOffer: offer }).websiteOffer).toEqual(offer);
  });
});
