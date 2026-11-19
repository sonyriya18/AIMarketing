/**
 * Versioned content packs for the creative builder (decision D10).
 * - starter: neutral templates; brand values come from account settings. No prices, plan
 *   benefits, payment instructions, or clinical claims.
 * - amil_example: the Amil Dental templates from the original project, available only when an
 *   account explicitly selects this example pack.
 */
import { AMIL_IMAGES, AMIL_TEMPLATES, RPL_TOKENS as AMIL_TOKENS, SAMPLE_PROFILES as AMIL_PROFILES, type AmilTemplate, type CampaignTopic, type EmailContent, type SampleProfile, type TemplateChannel } from '../data/amilTemplates';
import { AMIL_EXAMPLE_BRAND, neutralBrand, type BrandKit } from './brand';
import type { Account } from '../lib/types';
import { businessWebsite, configuredBusiness } from '../../shared/business/accounts';
import { journeyEmailTemplates } from './journeyTemplates';

export type PackId = 'starter' | 'amil_example' | 'amil_business';

export interface ContentPack {
  id: PackId;
  version: string;
  label: string;
  templates: AmilTemplate[];
  images: Record<string, { label: string; url: string }>;
  profiles: SampleProfile[];
  tokens: { label: string; token: string }[];
  brand: (account: Account) => BrandKit;
}

const U = (id: string, w = 1200) => `https://images.unsplash.com/${id}?w=${w}&auto=format&fit=crop&q=80`;
const STARTER_IMAGES = {
  lifestyle: { label: 'Lifestyle', url: U('photo-1490481651871-ab68de25d43d') },
  store: { label: 'Store', url: U('photo-1441986300917-64674bd600d8') },
  shopping: { label: 'Shopping', url: U('photo-1472851294608-062f824d29cc') },
  workspace: { label: 'Workspace', url: U('photo-1497366216548-37526070297c') },
};

const baseEmail = (o: Partial<EmailContent>): EmailContent => ({
  subject: '',
  preheader: '',
  eyebrow: '',
  headline: '',
  heroSub: '',
  heroImage: STARTER_IMAGES.lifestyle.url,
  trustBar: false,
  greeting: true,
  intro: '',
  bulletsTitle: '',
  bullets: [],
  highlightType: 'none',
  highlightLabel: '',
  highlightValue: '',
  highlightNote: '',
  ctaText: 'Learn more',
  ctaLink: 'MAIN_CTA',
  cta2Text: '',
  cta2Link: '',
  secondaryText: '',
  appBanner: false,
  statsBand: false,
  legal: 'You are receiving this email because you subscribed to our updates.',
  theme: 'navy',
  ...o,
});

const t = (id: string, name: string, channel: TemplateChannel, topic: CampaignTopic, bestFor: string, content: Pick<AmilTemplate, 'email' | 'sms' | 'push'>): AmilTemplate => ({
  id,
  name,
  channel,
  topic,
  bestFor,
  openLift: 0,
  clickLift: 0,
  convLift: 0,
  ...content,
});

const STARTER_TEMPLATES: AmilTemplate[] = [
  t('ST-EM-ANNOUNCE', 'Announcement', 'Email', 'promo', 'News or a new collection', {
    email: baseEmail({ subject: '${CONTACTS_LIST.FIRST_NAME}, something new is here', preheader: 'Take a first look today', eyebrow: 'NEW', headline: 'Something new is here', heroSub: 'Be among the first to see it.', intro: 'We have been working on something we think you will like. Here is a first look.', ctaText: 'See what’s new', ctaLink: 'NEW_ARRIVALS' }),
  }),
  t('ST-EM-OFFER', 'Offer with code', 'Email', 'promo', 'Time-limited promotions', {
    email: baseEmail({ subject: 'An offer for you, ${CONTACTS_LIST.FIRST_NAME}', preheader: 'Use your code before it expires', eyebrow: 'LIMITED TIME', headline: 'Your offer is ready', intro: 'Use the code below at checkout. Terms apply.', highlightType: 'promo', highlightLabel: 'Your code', highlightNote: 'CODE', ctaText: 'Shop now', ctaLink: 'SHOP_NOW', heroImage: STARTER_IMAGES.shopping.url }),
  }),
  t('ST-EM-WELCOME', 'Welcome', 'Email', 'welcome', 'New subscribers', {
    email: baseEmail({ subject: 'Welcome, ${CONTACTS_LIST.FIRST_NAME}', preheader: 'Here is how to get started', eyebrow: 'WELCOME', headline: 'Welcome aboard', intro: 'Thanks for joining. Here are a few ways to get started.', bulletsTitle: 'Get started', bullets: ['Complete your profile', 'Choose what you want to hear about', 'Explore our latest updates'], ctaText: 'Get started', ctaLink: 'GET_STARTED', heroImage: STARTER_IMAGES.workspace.url }),
  }),
  t('ST-EM-WINBACK', 'We miss you', 'Email', 'winback', 'Lapsed customers', {
    email: baseEmail({ subject: 'It’s been a while, ${CONTACTS_LIST.FIRST_NAME}', preheader: 'See what you have missed', eyebrow: 'WELCOME BACK', headline: 'We’ve missed you', intro: 'A lot has changed since your last visit. Come and see what’s new.', ctaText: 'Come back', ctaLink: 'WINBACK', heroImage: STARTER_IMAGES.store.url }),
  }),
  t('ST-EM-PREFS', 'Preferences check', 'Email', 'prefs', 'List health / fewer emails', {
    email: baseEmail({ subject: 'Choose what you hear from us', preheader: 'Update your preferences in one click', headline: 'Tell us what you want', intro: 'Choose the topics and how often you would like to hear from us.', ctaText: 'Update preferences', ctaLink: 'PREFERENCES', heroImage: '' }),
  }),
  t('ST-SMS-OFFER', 'Offer SMS', 'SMS', 'promo', 'Short promotion', { sms: { text: 'Hi ${CONTACTS_LIST.FIRST_NAME}, your offer is ready: ${clickthrough(\'SMS_OFFER\')} Reply STOP to opt out' } }),
  t('ST-SMS-REMIND', 'Reminder SMS', 'SMS', 'recall', 'Reminders', { sms: { text: 'Reminder: see your update here ${clickthrough(\'SMS_REMINDER\')} Reply STOP to opt out' } }),
  t('ST-SMS-WELCOME', 'Welcome SMS', 'SMS', 'welcome', 'New subscribers', { sms: { text: 'Welcome ${CONTACTS_LIST.FIRST_NAME}! Thanks for subscribing. Reply STOP to opt out' } }),
  t('ST-WP-OFFER', 'Offer push', 'WebPush', 'promo', 'Short promotion', { push: { title: 'An offer for you', body: 'Open to see today’s offer.', link: 'PUSH_OFFER', button1: 'See offer', button2: '', imageUrl: STARTER_IMAGES.shopping.url } }),
  t('ST-WP-NEW', 'New arrival push', 'WebPush', 'promo', 'Announcements', { push: { title: 'Something new is here', body: 'Take a first look.', link: 'PUSH_NEW', button1: 'Open', button2: '', imageUrl: '' } }),
  t('ST-WP-WINBACK', 'Comeback push', 'WebPush', 'winback', 'Lapsed visitors', { push: { title: 'We’ve missed you', body: 'See what’s new since your last visit.', link: 'PUSH_WINBACK', button1: 'Come back', button2: '', imageUrl: '' } }),
];

const STARTER_PROFILES: SampleProfile[] = [
  { id: 'alex', label: 'Sample: Alex (all fields)', offer: '', promo: 'WELCOME10', data: { 'CONTACTS_LIST.FIRST_NAME': 'Alex', 'CONTACTS_LIST.LAST_NAME': 'Morgan', 'CONTACTS_LIST.EMAIL_ADDRESS_': 'alex@example.com', 'CONTACTS_LIST.CITY_': 'Springfield', COMPANY_NAME: '' } },
  { id: 'business', label: 'Sample: business contact', offer: '', promo: 'TEAM15', data: { 'CONTACTS_LIST.FIRST_NAME': 'Sam', 'CONTACTS_LIST.LAST_NAME': 'Lee', 'CONTACTS_LIST.EMAIL_ADDRESS_': 'sam@company.example', 'CONTACTS_LIST.CITY_': 'Riverton', COMPANY_NAME: 'Example Co' } },
  { id: 'empty', label: 'No name on file (fallback test)', offer: '', promo: '', data: { 'CONTACTS_LIST.FIRST_NAME': '', 'CONTACTS_LIST.EMAIL_ADDRESS_': 'member@example.com', COMPANY_NAME: '' } },
];

const STARTER_TOKENS = [
  { label: 'First name', token: '${CONTACTS_LIST.FIRST_NAME}' },
  { label: 'Last name', token: '${CONTACTS_LIST.LAST_NAME}' },
  { label: 'City', token: '${CONTACTS_LIST.CITY_}' },
  { label: 'Company', token: '${COMPANY_NAME}' },
];

export const PACKS: Record<PackId, ContentPack> = {
  starter: {
    id: 'starter',
    version: 'starter-2026-10-15.1',
    label: 'Starter pack',
    templates: [...STARTER_TEMPLATES, ...journeyEmailTemplates('general')],
    images: STARTER_IMAGES,
    profiles: STARTER_PROFILES,
    tokens: STARTER_TOKENS,
    brand: (a) => neutralBrand(a.name, { ...a.brand, domain: a.brand.domain || (configuredBusiness(a.name) ? new URL(configuredBusiness(a.name)!.website).hostname : undefined) }),
  },
  amil_example: {
    id: 'amil_example',
    version: 'amil-example-2026-10-14',
    label: 'Example pack: Amil Dental',
    templates: [...AMIL_TEMPLATES, ...journeyEmailTemplates('dental')],
    images: AMIL_IMAGES,
    profiles: AMIL_PROFILES,
    tokens: AMIL_TOKENS,
    brand: () => AMIL_EXAMPLE_BRAND,
  },
  amil_business: {
    id: 'amil_business', version: 'amil-business-journeys-2026-11-16.1', label: 'Amil Dental business templates',
    templates: [...journeyEmailTemplates('dental'),
      t('AM-BIZ-SMS-INFO', 'Dental information SMS', 'SMS', 'promo', 'Official dental-plan information', { sms: { text: "Hi ${CONTACTS_LIST.FIRST_NAME}, explore official Amil Dental information: ${clickthrough('DENTAL_PLANS')} Reply STOP to opt out" } }),
      t('AM-BIZ-SMS-WELCOME', 'Dental welcome SMS', 'SMS', 'welcome', 'Verified new members', { sms: { text: "Welcome to Amil Dental. Read the official getting-started guidance: ${clickthrough('MEMBER_GUIDE')} Reply STOP to opt out" } }),
      t('AM-BIZ-PUSH-INFO', 'Dental information push', 'WebPush', 'promo', 'Official dental-plan information', { push: { title: 'Explore Amil Dental information', body: 'Review official dental-plan information for your next step.', link: 'DENTAL_PLANS', button1: 'Explore', button2: '', imageUrl: '' } }),
    ],
    images: AMIL_IMAGES, profiles: STARTER_PROFILES, tokens: STARTER_TOKENS,
    brand: (a) => ({ ...neutralBrand('Amil Dental', { ...a.brand, domain: a.brand.domain || 'amildental.com.br' }), wordmark: ['amil', ' dental'], name: 'Amil Dental', memberAreaLabel: null }),
  },
};

export function packFor(account: Account): ContentPack {
  if (account.contentPack === 'amil_example') return PACKS.amil_example;
  let officialAmil = false;
  try { officialAmil = /^(www\.)?amildental\.com\.br$/.test(new URL(businessWebsite(account) || '').hostname); } catch { /* Unknown business needs its own brand settings. */ }
  return configuredBusiness(account.name)?.key === 'amil_dental' || officialAmil ? PACKS.amil_business : PACKS.starter;
}

export function rankPackTemplates(pack: ContentPack, ch: TemplateChannel, topic: CampaignTopic): AmilTemplate[] {
  const list = pack.templates.filter((x) => x.channel === ch);
  return [...list.filter((x) => x.topic === topic), ...list.filter((x) => x.topic !== topic)];
}
