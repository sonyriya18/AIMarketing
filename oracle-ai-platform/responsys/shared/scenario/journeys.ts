import { z } from 'zod';
import { STRATEGY_KEYS, type StrategyKey } from './strategies';
import { WebsiteOfferSchema } from '../business/offers';

export const RESPONSYS_FIELDS_SOURCE = 'https://docs.oracle.com/en/cloud/saas/marketing/responsys-user/List_SystemFields.htm';
const ConditionSchema = z.object({ field: z.string().max(120), condition: z.string().max(220), purpose: z.string().max(240), source: z.enum(['standard', 'custom', 'activity']) }).strict();
const CampaignSchema = z.object({ id: z.string().max(80), role: z.enum(['initial', 'follow_up']), name: z.string().max(120), purpose: z.string().max(300), subject: z.string().max(220), cta: z.string().max(80), link: z.string().max(80) }).strict();
const ProgramSchema = z.object({
  summary: z.string().max(400).optional(),
  nodes: z.array(z.object({ id: z.string().max(80), type: z.enum(['entry', 'filter', 'email', 'sms', 'push', 'wait', 'decision', 'exit']), title: z.string().max(160), sub: z.string().max(160).optional(), conditionGroup: z.enum(['entry', 'filters', 'exclusions']).optional(), campaignId: z.string().max(80).optional(), criteria: z.array(ConditionSchema).max(10).optional() }).strict()).max(60),
  edges: z.array(z.object({ from: z.string().max(80), to: z.string().max(80), label: z.enum(['Yes', 'No']).optional() }).strict()).max(80),
}).strict();
export const JourneySchema = z.object({
  strategyKey: z.enum(STRATEGY_KEYS), business: z.enum(['dental', 'general']), name: z.string().max(160),
  entry: z.array(ConditionSchema).max(10), filters: z.array(ConditionSchema).max(10), exclusions: z.array(ConditionSchema).max(12),
  waitDays: z.number().int().min(1).max(30), decision: z.enum(['clicked', 'converted']),
  campaigns: z.tuple([CampaignSchema, CampaignSchema]),
}).strict();
export const JourneyRecordSchema = JourneySchema.extend({ selectedCampaignId: z.string().min(1).max(80), selectedTemplateId: z.string().min(1).max(80), program: ProgramSchema.optional(), websiteOffer: WebsiteOfferSchema.optional() }).superRefine((plan, ctx) => {
  if (plan.campaigns[0].role !== 'initial' || plan.campaigns[1].role !== 'follow_up' || plan.campaigns[0].id === plan.campaigns[1].id) ctx.addIssue({ code: 'custom', path: ['campaigns'], message: 'Use distinct initial and follow-up campaigns' });
  if (!plan.campaigns.some((c) => c.id === plan.selectedCampaignId)) ctx.addIssue({ code: 'custom', path: ['selectedCampaignId'], message: 'The selected campaign must belong to this journey' });
  if (plan.program) {
    const ids = new Set(plan.program.nodes.map((n) => n.id));
    if (ids.size !== plan.program.nodes.length || plan.program.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) ctx.addIssue({ code: 'custom', path: ['program'], message: 'Program objects must be unique and connections must reference existing objects' });
    if (!plan.program.nodes.some((n) => n.type === 'email' && n.campaignId === plan.selectedCampaignId)) ctx.addIssue({ code: 'custom', path: ['selectedCampaignId'], message: 'The selected campaign must appear in the saved program' });
  }
});
export type JourneyPlan = z.infer<typeof JourneySchema>;
export type JourneyCondition = z.infer<typeof ConditionSchema>;
export type JourneyCampaign = z.infer<typeof CampaignSchema>;
export type JourneyRecord = z.infer<typeof JourneyRecordSchema>;

type Recipe = { first: string; next: string; goal: string; follow: string; cta: string; link: string; field: string; value: string; wait: number; decision: 'clicked' | 'converted'; excludeField: string; excludeValue: string };
const DENTAL: Record<StrategyKey, Recipe> = {
  engagement: { first: 'Discover Your Dentist Network', next: 'Need Help Finding a Dentist?', goal: 'Introduce the official dentist-network and dental-plan information.', follow: 'Offer a focused dentist-finder guide to prospects who have not clicked the initial email.', cta: 'Explore the dentist network', link: 'DENTIST_NETWORK', field: 'PET_DENTAL_LEAD.LEAD_STATUS', value: "= 'OPEN'", wait: 2, decision: 'clicked', excludeField: 'PET_DENTAL_PROFILE.MEMBER_STATUS', excludeValue: "= 'ACTIVE'" },
  revenue: { first: 'Explore Your Dental Plan Options', next: 'Your Dental Plan Questions Answered', goal: 'Help opted-in prospects compare official dental-plan information before enrolling.', follow: 'Share a plan-selection checklist with prospects who have not completed enrollment.', cta: 'Explore dental plans', link: 'DENTAL_PLANS', field: 'PET_DENTAL_LEAD.LEAD_STATUS', value: "= 'QUALIFIED'", wait: 3, decision: 'converted', excludeField: 'PET_DENTAL_PROFILE.ENROLLMENT_STATUS', excludeValue: "= 'COMPLETED'" },
  welcome: { first: 'Welcome to Your Dental Plan', next: 'Your Dental Plan Getting-Started Guide', goal: 'Welcome verified new members and point them to official plan-use information.', follow: 'Continue a scheduled getting-started series for verified new members after the welcome email.', cta: 'Get started with your plan', link: 'MEMBER_GUIDE', field: 'PET_DENTAL_PROFILE.ENROLLED_AT', value: 'within the last 7 days', wait: 2, decision: 'clicked', excludeField: 'PET_DENTAL_PROFILE.MEMBER_STATUS', excludeValue: "IN ('CANCELLED', 'INELIGIBLE')" },
  retention: { first: 'Make the Most of Your Dental Plan', next: 'Dental Plan Support and Preferences', goal: 'Share official plan-use resources with current members who have a verified support request.', follow: 'Continue the support sequence with plan guidance and communication-preference information.', cta: 'Explore member guidance', link: 'MEMBER_SUPPORT', field: 'PET_DENTAL_PROFILE.MEMBER_STATUS', value: "= 'ACTIVE'", wait: 4, decision: 'clicked', excludeField: 'PET_DENTAL_PROFILE.MEMBER_STATUS', excludeValue: "IN ('CANCELLED', 'INELIGIBLE')" },
  hygiene: { first: 'Choose Your Dental Email Preferences', next: 'Your Dental Communication Preferences Guide', goal: 'Invite opted-in, deliverable contacts to confirm useful communication preferences.', follow: 'Share preference-management guidance only after a verified preference update and an eligibility recheck.', cta: 'Review email preferences', link: 'PREFERENCES', field: 'PET_MARKETING_CONTROL.PREFERENCE_REVIEW_DUE', value: "= 'Y'", wait: 7, decision: 'clicked', excludeField: 'PET_MARKETING_CONTROL.PREFERENCE_CONFIRMED', excludeValue: "= 'Y'" },
  reengage: { first: 'Revisit Your Dental Plan Options', next: 'Your Next Step With Dental Plan Information', goal: 'Invite consented inactive prospects to revisit official dental-plan information.', follow: 'Offer next-step plan information only to contacts with renewed click activity.', cta: 'Explore dental plan information', link: 'DENTAL_PLANS', field: 'PET_ENGAGEMENT.LAST_CLICK_AT', value: 'more than 90 days ago (proposed window)', wait: 5, decision: 'clicked', excludeField: 'PET_DENTAL_PROFILE.MEMBER_STATUS', excludeValue: "= 'ACTIVE'" },
  cart: { first: 'Continue Your Dental Plan Enrollment', next: 'Help With Your Dental Enrollment', goal: 'Offer help after a verified enrollment-start event without a completed enrollment.', follow: 'Offer a final enrollment-help reminder to eligible prospects who have not enrolled.', cta: 'Review enrollment information', link: 'ENROLLMENT_HELP', field: 'PET_DENTAL_LEAD.ENROLLMENT_STARTED_AT', value: 'within the last 24 hours (requires event tracking)', wait: 1, decision: 'converted', excludeField: 'PET_DENTAL_PROFILE.ENROLLMENT_STATUS', excludeValue: "= 'COMPLETED'" },
  winback: { first: 'Explore Dental Plans Again', next: 'Dental Plan Information for Your Next Step', goal: 'Invite verified former members with current marketing consent to review available plan information.', follow: 'Offer a plan-information guide to eligible former members who have not enrolled again.', cta: 'Review dental plans', link: 'DENTAL_PLANS', field: 'PET_DENTAL_PROFILE.MEMBER_STATUS', value: "= 'FORMER' (verify eligibility and consent)", wait: 4, decision: 'converted', excludeField: 'PET_DENTAL_PROFILE.MEMBER_STATUS', excludeValue: "= 'ACTIVE'" },
};
const GENERAL: Record<StrategyKey, [string, string, string, string]> = {
  engagement: ['Discover What Is Relevant to You', 'A Helpful Guide for Your Next Step', 'Introduce the selected business offering with one clear action.', 'Offer a shorter guide to contacts who have not clicked.'],
  revenue: ['Explore Your Options', 'Help Choosing Your Next Step', 'Guide qualified, opted-in prospects toward the official offering.', 'Answer common selection questions for prospects who have not converted.'],
  welcome: ['Welcome and Get Started', 'Your Getting-Started Checklist', 'Help verified new customers get started.', 'Send the scheduled getting-started checklist after the welcome email.'],
  retention: ['Useful Resources for You', 'Support and Communication Preferences', 'Share resources with verified customers who have requested support.', 'Continue the support sequence with guidance and preference choices.'],
  hygiene: ['Review Your Email Preferences', 'Confirm Your Communication Choices', 'Ask opted-in, deliverable contacts to review their preferences.', 'Share preference guidance only with contacts whose preference update is verified.'],
  reengage: ['Rediscover What Matters to You', 'Would You Like to Stay in Touch?', 'Invite consented inactive contacts to revisit the official offering.', 'Offer a next-step guide only after renewed click activity.'],
  cart: ['Continue Where You Left Off', 'Help Completing Your Next Step', 'Follow up after a verified incomplete checkout or application event.', 'Offer help to contacts who have not completed the tracked action.'],
  winback: ['Explore What Is Available Today', 'A Guide to Returning', 'Invite verified former customers with current consent to revisit the offering.', 'Offer a useful guide to eligible contacts who have not converted.'],
};

export function journeyFor(strategyKey: StrategyKey, business: 'dental' | 'general'): JourneyPlan {
  const recipe = DENTAL[strategyKey];
  const generic = GENERAL[strategyKey];
  const dental = business === 'dental';
  const first = dental ? recipe.first : generic[0], next = dental ? recipe.next : generic[1];
  const custom = (field: string, condition: string, purpose: string): JourneyCondition => ({ field, condition, purpose, source: 'custom' });
  return {
    strategyKey, business, name: `${first} journey`, waitDays: recipe.wait, decision: recipe.decision,
    entry: [
      { field: 'CONTACTS_LIST.RIID_', condition: 'IS NOT NULL', purpose: 'Use the mapped profile list as the recipient source; one journey entry per RIID.', source: 'standard' },
      custom(dental ? recipe.field : `PET_CUSTOMER.${strategyKey === 'welcome' ? 'JOINED_AT' : strategyKey === 'reengage' ? 'LAST_CLICK_AT' : 'JOURNEY_SEGMENT'}`, dental ? recipe.value : `matches the ${strategyKey} audience (map the business rule)`, 'Proposed audience signal; join the mapped PET to the profile list by RIID_. Do not assume this field exists.'),
      ...(dental && strategyKey === 'welcome' ? [custom('PET_DENTAL_PROFILE.MEMBER_STATUS', "= 'ACTIVE'", 'Verify current member status before sending a member welcome.')] : []),
    ],
    filters: [
      { field: 'CONTACTS_LIST.EMAIL_ADDRESS_', condition: 'IS NOT NULL and not blank', purpose: 'Require an email address.', source: 'standard' },
      { field: 'CONTACTS_LIST.EMAIL_PERMISSION_STATUS_', condition: "= 'I'", purpose: 'Send only to contacts with email opt-in.', source: 'standard' },
      { field: 'CONTACTS_LIST.EMAIL_DELIVERABILITY_STATUS_', condition: "= 'D'", purpose: 'Require a deliverable email status.', source: 'standard' },
    ],
    exclusions: [
      { field: 'CONTACTS_LIST.EMAIL_PERMISSION_STATUS_', condition: "is not 'I', including blank", purpose: 'Exclude opted-out or unknown-consent contacts before both sends.', source: 'standard' },
      { field: 'CONTACTS_LIST.EMAIL_DELIVERABILITY_STATUS_', condition: "is not 'D', including blank", purpose: 'Exclude undeliverable or unknown-status contacts before both sends.', source: 'standard' },
      custom('PET_MARKETING_CONTROL.SUPPRESS_FLAG', "= 'Y'", 'Exclude contacts on the mapped account suppression source.'),
      custom('PET_MARKETING_CONTROL.LAST_EMAIL_SENT_AT', 'within the last 72 hours (proposed frequency cap)', 'Apply the agreed contact policy; verify this timestamp is populated.'),
      custom(dental ? recipe.excludeField : 'PET_CUSTOMER.JOURNEY_GOAL_COMPLETED', dental ? recipe.excludeValue : "= 'Y'", 'Exclude contacts who have met the goal or are not eligible for this journey.'),
    ],
    campaigns: [
      { id: `${business}-${strategyKey}-initial`, role: 'initial', name: first, purpose: dental ? recipe.goal : generic[2], subject: first, cta: dental ? recipe.cta : 'Explore your options', link: dental ? recipe.link : 'MAIN_CTA' },
      { id: `${business}-${strategyKey}-follow-up`, role: 'follow_up', name: next, purpose: dental ? recipe.follow : generic[3], subject: next, cta: dental ? (strategyKey === 'hygiene' || strategyKey === 'retention' ? 'Review your preferences' : 'View the helpful guide') : 'View your guide', link: dental ? (strategyKey === 'hygiene' || strategyKey === 'retention' ? 'PREFERENCES' : recipe.link) : 'FOLLOW_UP' },
    ],
  };
}
