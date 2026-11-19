import { describe, expect, it } from 'vitest';
import { JourneyRecordSchema, JourneySchema, journeyFor } from '../../shared/scenario/journeys';
import { STRATEGY_KEYS } from '../../shared/scenario/strategies';
import { EmailContentSchema } from '../../shared/contracts/drafts';
import { journeyEmailTemplates } from '../../src/content/journeyTemplates';
import { packFor } from '../../src/content/packs';
import { buildFlow } from '../../src/features/planner/flow';
import type { Account } from '../../src/lib/types';

describe('strategy-specific email journeys', () => {
  it.each(STRATEGY_KEYS)('recommends exactly two campaigns and valid consent filters for %s', (key) => {
    const journey = JourneySchema.parse(journeyFor(key, 'dental'));
    expect(journey.campaigns.map((c) => c.role)).toEqual(['initial', 'follow_up']);
    expect(journey.filters).toContainEqual(expect.objectContaining({ field: 'CONTACTS_LIST.EMAIL_PERMISSION_STATUS_', condition: "= 'I'", source: 'standard' }));
    expect(journey.filters).toContainEqual(expect.objectContaining({ field: 'CONTACTS_LIST.EMAIL_DELIVERABILITY_STATUS_', condition: "= 'D'", source: 'standard' }));
    expect(journey.exclusions.some((c) => c.field.includes('SUPPRESS_FLAG'))).toBe(true);
    expect(journey.entry.filter((r) => r.field.startsWith('PET_')).every((r) => r.source === 'custom')).toBe(true);
  });
  it('changes entry and exclusion rules between prospects and new members', () => {
    const discovery = journeyFor('engagement', 'dental'), welcome = journeyFor('welcome', 'dental');
    expect(discovery.entry.some((r) => r.field.includes('LEAD_STATUS'))).toBe(true);
    expect(welcome.entry.some((r) => r.field.includes('ENROLLED_AT'))).toBe(true);
    expect(welcome.entry.some((r) => r.field.includes('MEMBER_STATUS') && r.condition === "= 'ACTIVE'")).toBe(true);
    expect(discovery.exclusions).not.toEqual(welcome.exclusions);
  });
  it('keeps flow campaign names, timing and branches aligned with the recommendations', () => {
    const journey = journeyFor('engagement', 'dental');
    const flow = buildFlow({ audienceName: 'Prospects', suppressionRule: 'Opt-in and deliverable', first: 'email', followUp: 'email', waitDays: journey.waitDays, decisionMetric: journey.decision, firstName: journey.campaigns[0].name, followUpName: journey.campaigns[1].name });
    expect(flow.main.find((n) => n.id === 'first')?.title).toBe(journey.campaigns[0].name);
    expect(flow.no[0]!.title).toBe(journey.campaigns[1].name);
    expect(flow.decision.title).toBe('Clicked?');
  });
  it('retains the selected campaign and criteria in validated draft metadata', () => {
    const journey = journeyFor('engagement', 'dental');
    const record = { ...journey, selectedCampaignId: journey.campaigns[1].id, selectedTemplateId: 'chosen-template' };
    expect(JourneyRecordSchema.parse(record).exclusions).toEqual(journey.exclusions);
    expect(JourneyRecordSchema.safeParse({ ...record, selectedCampaignId: 'unrelated' }).success).toBe(false);
  });
});

describe('campaign-specific business email templates', () => {
  it('provides separate initial/follow-up templates with valid business email content', () => {
    const templates = journeyEmailTemplates('dental');
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length);
    for (const key of STRATEGY_KEYS) {
      const journey = journeyFor(key, 'dental');
      const first = templates.filter((t) => t.journeyCampaignId === journey.campaigns[0].id);
      const follow = templates.filter((t) => t.journeyCampaignId === journey.campaigns[1].id);
      expect(first).toHaveLength(2); expect(follow).toHaveLength(2);
      expect(first[0]!.email!.subject).not.toBe(follow[0]!.email!.subject);
      expect(first[0]!.email!.intro).not.toBe(follow[0]!.email!.intro);
    }
    for (const template of templates) {
      expect(EmailContentSchema.safeParse(template.email).success).toBe(true);
      expect(template.email!.statsBand).toBe(false);
      expect(template.email!.highlightType).toBe('none');
      expect(template.openLift).toBe(0);
    }
  });
  it('automatically uses the safe dental pack for Amil and preserves explicit customer example packs', () => {
    const account = { name: 'Amil', brand: {}, contentPack: 'starter' } as Account;
    const pack = packFor(account);
    expect(pack.id).toBe('amil_business');
    expect(pack.brand(account).name).toBe('Amil Dental');
    expect(pack.templates.filter((t) => t.channel === 'Email').every((t) => t.journeyCampaignId)).toBe(true);
    expect(packFor({ ...account, contentPack: 'amil_example' }).id).toBe('amil_example');
    expect(packFor({ ...account, name: 'Another business' }).id).toBe('starter');
    const dm = { ...account, name: 'Endeavour Group - DM' };
    expect(packFor(dm).id).toBe('starter');
    expect(packFor(dm).brand(dm).name).toBe('Endeavour Group - DM');
    expect(packFor(dm).templates.some((t) => t.id.startsWith('JB-DENTAL'))).toBe(false);
  });
});
