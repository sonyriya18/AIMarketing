/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Amil Dental — Oracle Responsys template library
 * ---------------------------------------------------------------
 * Email templates marked with `source` are rebuilt (in English) from the
 * Amil Responsys campaigns supplied by the account team (ResponseForm.htm,
 * AMIL DENTAL5.html, Amil Dentale4.html, Amilr3.html, a6.html, r2.html),
 * keeping their structure, offers and brand colours (#461bff / #00adff).
 * The original image slices (the *_files folders) were not in the upload,
 * so banners use the dental photography already used in this app
 * (campaignConcepts.ts). Any banner can be replaced in the Campaign Builder.
 *
 * Personalisation uses the account's real RPL fields where known
 * (CONTACTS_LIST, PET_ULTIMO_CARRINHO, CARRINHO_VANTAGENS, CORRETOR,
 * COMPANY_NAME). Fields under PET_BOLETO are a proposed table — map
 * them to your billing PET before launch.
 */

export type TemplateChannel = 'Email' | 'SMS' | 'WebPush';
export type CampaignTopic =
  | 'cart'
  | 'billing'
  | 'promo'
  | 'welcome'
  | 'recall'
  | 'upsell'
  | 'pme'
  | 'winback'
  | 'nps'
  | 'prefs'
  | 'referral'
  | 'paid'
  | 'kids';

export const TOPIC_LABEL: Record<CampaignTopic, string> = {
  cart: 'Cart recovery',
  billing: 'Billing',
  promo: 'Promotion',
  welcome: 'Welcome',
  recall: 'Check-up recall',
  upsell: 'Upsell',
  pme: 'Business (PME)',
  winback: 'Win-back',
  nps: 'Survey',
  prefs: 'Preferences',
  referral: 'Referral',
  paid: 'Payment confirmed',
  kids: 'Kids',
};

export type HighlightType = 'none' | 'price' | 'boleto' | 'discount' | 'nps' | 'steps' | 'promo' | 'offer';

export interface EmailContent {
  subject: string;
  preheader: string;
  eyebrow: string;
  headline: string;
  heroSub: string; // short line under the headline, inside the banner
  heroImage: string; // banner image URL ('' = colour banner only)
  trustBar: boolean; // icon strip under the banner
  greeting: boolean;
  intro: string;
  bulletsTitle: string;
  bullets: string[];
  highlightType: HighlightType;
  highlightLabel: string;
  highlightValue: string;
  highlightNote: string;
  ctaText: string;
  ctaLink: string; // Responsys link-table name
  cta2Text: string; // optional second (outline) button
  cta2Link: string;
  secondaryText: string;
  appBanner: boolean; // "Amil Clientes app" banner module
  statsBand: boolean; // Amil facts band (members, service points, years)
  legal: string;
  theme: 'purple' | 'cyan' | 'navy';
}

export interface SmsContent {
  text: string;
}

export interface PushContent {
  title: string;
  body: string;
  link: string; // link-table name
  button1: string;
  button2: string;
  imageUrl: string; // '' = no large image
}

export interface AmilTemplate {
  id: string;
  name: string;
  channel: TemplateChannel;
  topic: CampaignTopic;
  source?: string;
  journeyCampaignId?: string;
  bestFor: string;
  openLift: number;
  clickLift: number;
  convLift: number;
  email?: EmailContent;
  sms?: SmsContent;
  push?: PushContent;
}

/* ------------------------------------------------------------------ */
/* Banner images (from the app's existing Amil campaign concepts)      */
/* ------------------------------------------------------------------ */

const U = (id: string, w = 1200) => `https://images.unsplash.com/${id}?w=${w}&auto=format&fit=crop&q=80`;

export const AMIL_IMAGES = {
  care: { label: 'Dental care', url: U('photo-1629909613654-28e377c37b09') },
  smile: { label: 'Bright smile', url: U('photo-1606811841689-23dfddce3e95') },
  checkup: { label: 'Check-up', url: U('photo-1598256989800-fe5f95da9787') },
  payment: { label: 'Payment', url: U('photo-1563986768609-322da13575f3') },
  family: { label: 'Family & business', url: U('photo-1588776814546-1ffcf47267a5') },
};
export type AmilImageKey = keyof typeof AMIL_IMAGES;
const IMG = (k: AmilImageKey) => AMIL_IMAGES[k].url;

/* ------------------------------------------------------------------ */
/* Shared copy                                                        */
/* ------------------------------------------------------------------ */

const LEGAL_CRO =
  'Amil Dental – CRO SP 4,722 / Technical lead: Maria A. F. A. Araújo – CRO SP 35,448. Amil Dental – CRO RJ 960 / Technical lead: Patrícia I. C. de Almeida – CRO RJ 20,121.';

const base = (o: Partial<EmailContent>): EmailContent => ({
  subject: '',
  preheader: '',
  eyebrow: 'AMIL DENTAL',
  headline: '',
  heroSub: '',
  heroImage: IMG('care'),
  trustBar: true,
  greeting: true,
  intro: '',
  bulletsTitle: '',
  bullets: [],
  highlightType: 'none',
  highlightLabel: '',
  highlightValue: '',
  highlightNote: '',
  ctaText: '',
  ctaLink: 'CTA_MAIN',
  cta2Text: '',
  cta2Link: 'CTA_SECONDARY',
  secondaryText: '',
  appBanner: false,
  statsBand: false,
  legal: LEGAL_CRO,
  theme: 'purple',
  ...o,
});

/* ------------------------------------------------------------------ */
/* Email templates                                                    */
/* ------------------------------------------------------------------ */

const EMAIL: AmilTemplate[] = [
  {
    id: 'AM-EM-CART-PF',
    name: 'Abandoned cart – individual',
    channel: 'Email',
    topic: 'cart',
    source: 'ResponseForm.htm',
    bestFor: 'Cart left, no purchase',
    openLift: 0.04,
    clickLift: 0.2,
    convLift: 0.18,
    email: base({
      subject: '${CONTACTS_LIST.FIRST_NAME}, any questions about your plan?',
      preheader: 'Your ${PET_ULTIMO_CARRINHO.NOME_PRODUTO} plan is saved and waiting for you.',
      eyebrow: 'YOUR CART IS SAVED',
      headline: 'Your plan is almost ready',
      heroSub: 'Finish in 2 minutes — we kept everything for you.',
      heroImage: IMG('care'),
      intro:
        'We noticed you were interested in ${PET_ULTIMO_CARRINHO.NOME_PRODUTO} but didn’t finish your purchase. Did something go wrong, or do you have a question we can answer?',
      bulletsTitle: 'Your plan includes',
      bullets: [
        '${CARRINHO_VANTAGENS.VANTAGEM_1}',
        '${CARRINHO_VANTAGENS.VANTAGEM_2}',
        '${CARRINHO_VANTAGENS.VANTAGEM_3}',
        '${CARRINHO_VANTAGENS.VANTAGEM_4}',
      ],
      highlightType: 'price',
      highlightLabel: 'From',
      highlightValue: 'R$ ${PRODUCT_DETAIL.CARD_0}',
      highlightNote: 'per member / month',
      ctaText: 'Complete my purchase',
      ctaLink: 'COMPLETE_PURCHASE',
      cta2Text: 'Talk to a broker',
      cta2Link: 'BROKER_CONTACT',
      secondaryText: '',
      statsBand: true,
    }),
  },
  {
    id: 'AM-EM-CART-PME',
    name: 'Abandoned cart – business (PME)',
    channel: 'Email',
    topic: 'pme',
    source: 'AMIL DENTAL5.html',
    bestFor: 'Company proposals not finished',
    openLift: 0.05,
    clickLift: 0.16,
    convLift: 0.15,
    email: base({
      subject: '${COMPANY_NAME}: your dental proposal is saved',
      preheader: 'Dental E30 for 2 to 99 employees. Finish in a few clicks.',
      eyebrow: 'AMIL DENTAL FOR BUSINESS',
      headline: 'Your team is one step from Amil Dental',
      heroSub: 'Classic Line – Dental E30 · 2 to 99 members',
      heroImage: IMG('family'),
      intro:
        'You started a dental plan for ${PET_ULTIMO_CARRINHO.BENEFICIARIOS} employees. Finish now and give your whole team nationwide coverage.',
      bulletsTitle: 'Classic Line – Dental E30',
      bullets: ['Check-ups and cleaning', '24-hour emergency care', 'Root canal treatment', 'Nationwide dentist network'],
      highlightType: 'price',
      highlightLabel: 'From',
      highlightValue: 'R$ 16.83',
      highlightNote: 'per member / month (30–99 members)',
      ctaText: 'Finish my proposal',
      ctaLink: 'FINISH_PME',
      cta2Text: 'Compare business plans',
      cta2Link: 'COMPARE_PME',
      statsBand: true,
      secondaryText: 'or talk to your broker ${CORRETOR}',
      theme: 'navy',
    }),
  },
  {
    id: 'AM-EM-PROMO-24H',
    name: '24h coverage + 20% off',
    channel: 'Email',
    topic: 'promo',
    source: 'Amil Dentale4.html',
    bestFor: 'Time-limited promotion',
    openLift: 0.08,
    clickLift: 0.12,
    convLift: 0.14,
    email: base({
      subject: 'Use your plan in 24h + 20% off',
      preheader: 'No waiting: 24-hour waiting period on Dental 205.',
      eyebrow: 'LIMITED-TIME OFFER',
      headline: 'No waiting. Use your plan in 24 hours.',
      heroSub: 'Plus 20% off with card or annual boleto',
      heroImage: IMG('smile'),
      intro: 'This is your chance to enjoy every Amil Dental benefit within 24 hours of signing up.',
      bulletsTitle: 'Dental E35 Prosthesis includes',
      bullets: [
        'Emergency appointments',
        'Standard teeth whitening',
        'Single resin crown',
        'Full and partial dentures',
        'Bruxism night guard (TMJ/TMD)',
      ],
      highlightType: 'discount',
      highlightLabel: 'Save',
      highlightValue: '20% OFF',
      highlightNote: 'with credit card or annual boleto',
      ctaText: 'Sign up now',
      ctaLink: 'SIGNUP_PROMO',
      cta2Text: 'Compare plans',
      cta2Link: 'COMPARE_PLANS',
      statsBand: true,
      secondaryText: 'or talk to your broker',
      legal:
        '20% discount valid for individual contracts paid by credit card or annual boleto, upon proof of payment. 24-hour waiting period applies to Dental 205. ' +
        LEGAL_CRO,
      theme: 'cyan',
    }),
  },
  {
    id: 'AM-EM-BOLETO',
    name: 'Boleto due reminder',
    channel: 'Email',
    topic: 'billing',
    source: 'Amilr3.html',
    bestFor: 'Payment due in 1–3 days',
    openLift: 0.1,
    clickLift: 0.14,
    convLift: 0.2,
    email: base({
      subject: 'Your Amil Dental boleto is due ${PET_BOLETO.DATA_VENCIMENTO}',
      preheader: 'Copy the code and pay in your banking app.',
      eyebrow: 'PAYMENT REMINDER',
      headline: 'Your boleto is about to expire',
      heroSub: 'Pay by ${PET_BOLETO.DATA_VENCIMENTO} to keep all your benefits',
      heroImage: IMG('payment'),
      trustBar: false,
      intro:
        'Just a reminder: you have until ${PET_BOLETO.DATA_VENCIMENTO} to pay request no. ${PET_BOLETO.NUM_SOLICITACAO} and keep all your Amil Dental benefits.',
      highlightType: 'boleto',
      highlightLabel: 'Copy and paste this code into your banking app',
      highlightValue: '${PET_BOLETO.LINHA_DIGITAVEL}',
      highlightNote: 'Already paid? Please ignore this message.',
      ctaText: 'View my boleto',
      ctaLink: 'VIEW_BOLETO',
      cta2Text: 'Pay with PIX',
      cta2Link: 'PAY_PIX',
      appBanner: true,
      secondaryText: 'Still have questions? See why Amil Dental is worth it.',
      theme: 'cyan',
    }),
  },
  {
    id: 'AM-EM-REFACA',
    name: 'Complete your purchase again',
    channel: 'Email',
    topic: 'winback',
    source: 'a6.html',
    bestFor: 'Cancelled proposals',
    openLift: 0.07,
    clickLift: 0.12,
    convLift: 0.12,
    email: base({
      subject: 'Come back with 20% off your plan',
      preheader: 'Unbeatable conditions to finish your purchase.',
      eyebrow: 'WE SAVED YOUR OFFER',
      headline: 'Restart your purchase and save',
      heroSub: '20% off + 24-hour waiting period*',
      heroImage: IMG('smile'),
      intro: 'Your proposal was cancelled, but Amil Dental’s best conditions are still available to you.',
      bulletsTitle: 'Plans for you with',
      bullets: ['24-hour waiting period*', '20% off annual payment*', '40,000+ service points across Brazil'],
      highlightType: 'discount',
      highlightLabel: 'This month only',
      highlightValue: '20% OFF',
      highlightNote: 'credit card or annual boleto',
      ctaText: 'Restart my purchase',
      ctaLink: 'COMPLETE_PURCHASE',
      secondaryText: 'or talk to your broker',
      legal: '*Valid only for individual contracts on CL80 NNE, Dental 205, E35 and E45 plans. ' + LEGAL_CRO,
    }),
  },
  {
    id: 'AM-EM-PME-205',
    name: 'Business cross-sell – Dental 205',
    channel: 'Email',
    topic: 'pme',
    source: 'r2.html',
    bestFor: 'Companies with health plan, no dental',
    openLift: 0.06,
    clickLift: 0.13,
    convLift: 0.1,
    email: base({
      subject: '230 dental procedures for your team from R$ 16.83',
      preheader: 'Amil Dental 205 for companies with 30–99 members.',
      eyebrow: 'AMIL DENTAL FOR BUSINESS',
      headline: '230 procedures to care for your team',
      heroSub: 'Amil Dental 205 · from R$ 16.83 per member',
      heroImage: IMG('family'),
      intro: 'With Amil Dental 205, you and your employees get 230 dental procedures covered.',
      bulletsTitle: 'What’s covered',
      bullets: ['Cleaning and prevention', 'Fillings', 'Root canal treatment', 'Extractions', '24h emergency care'],
      highlightType: 'price',
      highlightLabel: 'Only',
      highlightValue: 'R$ 16.83',
      highlightNote: 'per member / month*',
      ctaText: 'Get a quote',
      ctaLink: 'QUOTE_PME',
      cta2Text: 'Talk to a broker',
      cta2Link: 'BROKER_CONTACT',
      statsBand: true,
      secondaryText: 'Need whitening, braces or dentures? Discover the Aesthetic Line.',
      legal: '*Based on Dental 205 business plan, 30–99 members, subject to company registration check. ' + LEGAL_CRO,
      theme: 'navy',
    }),
  },
  // ---- New templates ------------------------------------------------
  {
    id: 'AM-EM-WELCOME',
    name: 'Welcome new member',
    channel: 'Email',
    topic: 'welcome',
    bestFor: 'First 7 days after purchase',
    openLift: 0.12,
    clickLift: 0.15,
    convLift: 0.04,
    email: base({
      subject: 'Welcome to Amil Dental, ${CONTACTS_LIST.FIRST_NAME}!',
      preheader: 'Your digital member card is ready.',
      eyebrow: 'WELCOME',
      headline: 'Welcome to Amil Dental',
      heroSub: 'Your smile is in good hands',
      heroImage: IMG('care'),
      intro: 'We’re glad to have you! Here’s how to start using your plan in 3 easy steps.',
      highlightType: 'steps',
      highlightLabel: 'Get started',
      highlightValue: 'Download the app|Open your digital member card|Find a dentist near you',
      ctaText: 'Download the app',
      ctaLink: 'APP_DOWNLOAD',
      cta2Text: 'Find a dentist near me',
      cta2Link: 'FIND_DENTIST',
      appBanner: true,
      secondaryText: 'Questions? Chat with us in the app or call 0800.',
    }),
  },
  {
    id: 'AM-EM-RECALL',
    name: '6-month check-up recall',
    channel: 'Email',
    topic: 'recall',
    bestFor: 'No appointment in 180 days',
    openLift: 0.1,
    clickLift: 0.14,
    convLift: 0.05,
    email: base({
      subject: '${CONTACTS_LIST.FIRST_NAME}, it’s been 6 months since your last check-up',
      preheader: 'Prevention is the best care — and it’s already covered.',
      eyebrow: 'TIME FOR YOUR CHECK-UP',
      headline: 'Your 6-month check-up is due',
      heroSub: 'Cleaning and exam are already covered',
      heroImage: IMG('checkup'),
      intro: 'A visit every 6 months prevents bigger treatments later. Your cleaning and exam are already covered by your plan.',
      bulletsTitle: 'At your check-up',
      bullets: ['Full dental exam', 'Professional cleaning', 'Fluoride treatment'],
      ctaText: 'Find a dentist',
      ctaLink: 'FIND_DENTIST',
      cta2Text: 'Book in the app',
      cta2Link: 'APP_BOOKING',
      appBanner: true,
      secondaryText: 'No extra cost for covered procedures.',
      theme: 'cyan',
    }),
  },
  {
    id: 'AM-EM-ESTETICA',
    name: 'Aesthetic line upgrade',
    channel: 'Email',
    topic: 'upsell',
    bestFor: 'Active members, upsell',
    openLift: 0.07,
    clickLift: 0.16,
    convLift: 0.12,
    email: base({
      subject: 'Whitening and braces, now in your plan',
      preheader: 'Discover the Amil Dental Aesthetic Line.',
      eyebrow: 'AESTHETIC LINE',
      headline: 'Your smile deserves more',
      heroSub: 'Whitening · Braces · Dentures',
      heroImage: IMG('smile'),
      intro: 'Upgrade to the Aesthetic Line and get coverage for treatments that make your smile even brighter.',
      bulletsTitle: 'The Aesthetic Line includes',
      bullets: ['Standard teeth whitening', 'Orthodontic braces', 'Orthodontic records', 'Dentures'],
      highlightType: 'price',
      highlightLabel: 'Upgrade from',
      highlightValue: 'R$ 29.90',
      highlightNote: 'extra per month',
      ctaText: 'Upgrade my plan',
      ctaLink: 'UPGRADE_AESTHETIC',
      cta2Text: 'See what’s covered',
      cta2Link: 'AESTHETIC_COVERAGE',
    }),
  },
  {
    id: 'AM-EM-WINBACK',
    name: 'We miss you',
    channel: 'Email',
    topic: 'winback',
    bestFor: 'Inactive > 180 days',
    openLift: 0.09,
    clickLift: 0.1,
    convLift: 0.08,
    email: base({
      subject: 'We miss you, ${CONTACTS_LIST.FIRST_NAME}',
      preheader: 'Come back to Amil Dental with a special offer.',
      eyebrow: 'A SPECIAL OFFER FOR YOU',
      headline: 'We miss you',
      heroSub: '15% off your first 3 months back',
      heroImage: IMG('smile'),
      intro: 'It’s been a while. We prepared a special offer so you can start caring for your smile again.',
      highlightType: 'discount',
      highlightLabel: 'Welcome-back offer',
      highlightValue: '15% OFF',
      highlightNote: 'your first 3 monthly payments',
      ctaText: 'Come back now',
      ctaLink: 'WINBACK',
      theme: 'cyan',
    }),
  },
  {
    id: 'AM-EM-NPS',
    name: 'Satisfaction survey (NPS)',
    channel: 'Email',
    topic: 'nps',
    bestFor: '30 days after first visit',
    openLift: 0.05,
    clickLift: 0.22,
    convLift: 0,
    email: base({
      subject: 'From 0 to 10, how likely are you to recommend us?',
      preheader: 'It takes less than a minute.',
      eyebrow: 'YOUR OPINION MATTERS',
      headline: 'How was your experience?',
      heroSub: 'One question · less than 1 minute',
      heroImage: IMG('checkup'),
      trustBar: false,
      intro: 'Tell us how your experience was. It takes less than a minute.',
      highlightType: 'nps',
      highlightLabel: 'How likely are you to recommend Amil Dental?',
      highlightValue: '0-10',
      highlightNote: '0 = not at all likely · 10 = extremely likely',
      ctaText: 'Answer the survey',
      ctaLink: 'NPS_FORM',
    }),
  },
  {
    id: 'AM-EM-PREFS',
    name: 'Update your details',
    channel: 'Email',
    topic: 'prefs',
    bestFor: 'List hygiene, re-permission',
    openLift: 0.03,
    clickLift: 0.18,
    convLift: 0,
    email: base({
      subject: 'Are your details up to date?',
      preheader: 'Confirm your mobile and choose what you receive.',
      eyebrow: 'KEEP IN TOUCH',
      headline: 'Keep your details up to date',
      heroSub: 'Choose how we remind you',
      heroImage: IMG('care'),
      trustBar: false,
      intro: 'Confirm your email and mobile number to get payment and appointment reminders on the channel you prefer.',
      bulletsTitle: 'You choose to receive',
      bullets: ['Payment reminders', 'Appointment reminders', 'Offers and news'],
      ctaText: 'Update my details',
      ctaLink: 'PREFERENCES',
      secondaryText: 'Don’t want our emails anymore? You can unsubscribe at any time.',
      theme: 'navy',
    }),
  },
  {
    id: 'AM-EM-PAGO',
    name: 'Payment confirmed',
    channel: 'Email',
    topic: 'paid',
    bestFor: 'Right after payment',
    openLift: 0.14,
    clickLift: 0.1,
    convLift: 0.02,
    email: base({
      subject: 'Payment confirmed ✔',
      preheader: 'Everything is set with your Amil Dental plan.',
      eyebrow: 'ALL SET',
      headline: 'Payment confirmed',
      heroSub: 'Your plan is active',
      heroImage: IMG('payment'),
      intro: 'We received payment for request no. ${PET_BOLETO.NUM_SOLICITACAO}. Your plan is active.',
      highlightType: 'steps',
      highlightLabel: 'Next steps',
      highlightValue: 'Open your digital member card|Book your first appointment|Turn on automatic debit',
      ctaText: 'Open my member card',
      ctaLink: 'MEMBER_CARD',
      appBanner: true,
      theme: 'cyan',
    }),
  },
  {
    id: 'AM-EM-INDIQUE',
    name: 'Refer a friend',
    channel: 'Email',
    topic: 'referral',
    bestFor: 'Happy, long-term members',
    openLift: 0.05,
    clickLift: 0.12,
    convLift: 0.06,
    email: base({
      subject: 'Refer Amil Dental and get 1 month free',
      preheader: 'Great smiles are worth sharing.',
      eyebrow: 'REFER & EARN',
      headline: 'Share a smile, get a month free',
      heroSub: '1 free month for every friend who joins',
      heroImage: IMG('family'),
      intro: 'Refer friends and family. For every contract signed, you get one monthly payment free.',
      highlightType: 'steps',
      highlightLabel: 'How it works',
      highlightValue: 'Share your link|Your friend signs up|You get 1 month free',
      ctaText: 'Get my link',
      ctaLink: 'REFER',
    }),
  },
  // ---- From your campaign concepts (campaignConcepts.ts) ------------
  {
    id: 'AM-EM-ZERO',
    name: 'Cart recovery – zero waiting period',
    channel: 'Email',
    topic: 'cart',
    source: 'Concept 01 · PROG_CARR_INFINITY_PF',
    bestFor: 'Cart left, pay by card',
    openLift: 0.08,
    clickLift: 0.22,
    convLift: 0.2,
    email: base({
      subject: 'Your Amil Dental plan: finish with zero waiting period',
      preheader: '14,000+ network dentists across Brazil. Sign up by card today, start tomorrow.',
      eyebrow: 'ZERO WAITING PERIOD ON CREDIT CARD',
      headline: 'A chance to keep your oral health on track',
      heroSub: 'Pay by card — start using your plan tomorrow',
      heroImage: IMG('care'),
      intro:
        'You took the first step to care for your smile with Amil Dental. Finish your sign-up online now with zero waiting period on your credit card.',
      bulletsTitle: 'Selected plan: ${PET_ULTIMO_CARRINHO.NOME_PRODUTO}',
      bullets: ['14,000+ network dentists across Brazil', 'Check-ups, cleanings, X-rays, root canal and 24h emergency', 'No co-pay on covered procedures'],
      highlightType: 'promo',
      highlightLabel: 'Zero waiting period on credit card',
      highlightValue: 'Sign up by card and your plan is active in 24h.',
      highlightNote: 'CARENCIAZERO',
      ctaText: 'Resume my proposal',
      ctaLink: 'RESUME_PROPOSAL',
      cta2Text: 'See dentist network in the app',
      cta2Link: 'NETWORK_APP',
      statsBand: true,
      secondaryText: 'Card payment activates your plan in 24 hours.',
    }),
  },
  {
    id: 'AM-EM-PREVENT',
    name: 'Preventive cleaning – no co-pay',
    channel: 'Email',
    topic: 'recall',
    source: 'Concept 03 · AMIL_SAUDE_BUCAL_PREVENTIVA_CHECKUP',
    bestFor: 'Members with no visit in 6+ months',
    openLift: 0.12,
    clickLift: 0.16,
    convLift: 0.05,
    email: base({
      subject: '${CONTACTS_LIST.FIRST_NAME}, book your preventive cleaning at no cost',
      preheader: 'Your smile deserves care — cleaning is covered with no co-pay.',
      eyebrow: 'PREVENTION, NO CO-PAY',
      headline: 'Oral health on track: prevention with no co-pay',
      heroSub: 'Cleaning and check-up included in your plan',
      heroImage: IMG('checkup'),
      intro: 'Regular cleanings prevent bigger problems. Book yours today with one of our network dentists — at no extra cost.',
      bulletsTitle: 'Included at no cost',
      bullets: ['Professional cleaning (prophylaxis)', 'Full check-up', 'Fluoride application'],
      ctaText: 'Find network dentists in the app',
      ctaLink: 'FIND_DENTIST_APP',
      appBanner: true,
      theme: 'cyan',
    }),
  },
  {
    id: 'AM-EM-PME-UP',
    name: 'Business upgrade – Aesthetic Line',
    channel: 'Email',
    topic: 'pme',
    source: 'Concept 05 · AMIL_PME_UPGRADE_LINHA_ESTETICA',
    bestFor: 'Business clients, upsell',
    openLift: 0.09,
    clickLift: 0.16,
    convLift: 0.12,
    email: base({
      subject: 'Business benefit: extend your plan to whitening and dentures',
      preheader: 'The most wanted dental treatments for your team.',
      eyebrow: 'AMIL DENTAL FOR BUSINESS',
      headline: 'Upgrade your company’s dental benefit',
      heroSub: 'Whitening · Dentures · Braces for your team',
      heroImage: IMG('smile'),
      intro: 'Give your employees the aesthetic treatments they want most. Simulate the Aesthetic Line upgrade for ${COMPANY_NAME} with no commitment.',
      bulletsTitle: 'Aesthetic Line for your team',
      bullets: ['Teeth whitening', 'Dentures', 'Orthodontics'],
      highlightType: 'price',
      highlightLabel: 'Upgrade from',
      highlightValue: 'R$ 9.90',
      highlightNote: 'extra per member / month',
      ctaText: 'Simulate business upgrade',
      ctaLink: 'SIMULATE_PME_UPGRADE',
      cta2Text: 'Talk to a broker',
      cta2Link: 'BROKER_CONTACT',
      statsBand: true,
      secondaryText: 'or talk to your broker ${CORRETOR}',
      theme: 'navy',
    }),
  },
  {
    id: 'AM-EM-KIDS',
    name: 'Amil Dental Kids',
    channel: 'Email',
    topic: 'kids',
    source: 'Concept 06 · AMIL_DENTAL_KIDS_PREVENCAO',
    bestFor: 'Families with children',
    openLift: 0.1,
    clickLift: 0.14,
    convLift: 0.06,
    email: base({
      subject: 'Amil Dental Kids: specialist care for your child’s smile',
      preheader: 'Pediatric dentists near you, already covered.',
      eyebrow: 'AMIL DENTAL KIDS',
      headline: 'Your child’s smile deserves specialist care',
      heroSub: 'Pediatric dentists near you',
      heroImage: IMG('family'),
      intro: 'Healthy habits start early. Our pediatric dentists make every visit easy and fun for your child.',
      bulletsTitle: 'For your child',
      bullets: ['Pediatric dentists', 'Fluoride and sealants', 'Easy, friendly first visit'],
      ctaText: 'Find a pediatric dentist',
      ctaLink: 'KIDS_NETWORK',
      appBanner: true,
      theme: 'cyan',
    }),
  },
];

/* ------------------------------------------------------------------ */
/* SMS templates (keep ≤ 160 GSM characters)                          */
/* ------------------------------------------------------------------ */

const sms = (
  id: string,
  name: string,
  topic: CampaignTopic,
  bestFor: string,
  text: string,
  lifts: [number, number, number]
): AmilTemplate => ({
  id,
  name,
  channel: 'SMS',
  topic,
  bestFor,
  openLift: lifts[0],
  clickLift: lifts[1],
  convLift: lifts[2],
  sms: { text },
});

const SMS: AmilTemplate[] = [
  sms('AM-SMS-BOL3', 'Boleto due in 3 days', 'billing', '3 days before due date',
    'Amil Dental: ${CONTACTS_LIST.FIRST_NAME}, your boleto is due ${PET_BOLETO.DATA_VENCIMENTO}. Pay here: ${clickthrough(\'BOLETO_SMS\')} Reply STOP to opt out', [0, 0.12, 0.16]),
  sms('AM-SMS-PIX', 'Boleto due today – PIX', 'billing', 'Due date, no payment yet',
    'Amil Dental: your boleto is due TODAY. Pay with PIX in seconds: ${clickthrough(\'PIX_SMS\')} Already paid? Ignore this. Reply STOP to opt out', [0, 0.16, 0.22]),
  sms('AM-SMS-CART', 'Abandoned cart', 'cart', '2h after cart left',
    'Amil Dental: ${CONTACTS_LIST.FIRST_NAME}, your ${PET_ULTIMO_CARRINHO.NOME_PRODUTO} plan is saved. Finish here: ${clickthrough(\'CART_SMS\')} Reply STOP to opt out', [0, 0.18, 0.14]),
  sms('AM-SMS-RECALL', '6-month check-up', 'recall', 'No visit in 180 days',
    'Amil Dental: it has been 6 months since your last check-up. Book it at no extra cost: ${clickthrough(\'NETWORK_SMS\')} Reply STOP to opt out', [0, 0.1, 0.04]),
  sms('AM-SMS-WELCOME', 'Welcome', 'welcome', 'Day 0 after purchase',
    'Amil Dental: welcome, ${CONTACTS_LIST.FIRST_NAME}! Your digital member card is ready in the app: ${clickthrough(\'APP_SMS\')}', [0, 0.14, 0.02]),
  sms('AM-SMS-PAGO', 'Payment confirmed', 'paid', 'Right after payment',
    'Amil Dental: payment confirmed! Your plan is active. Member card: ${clickthrough(\'CARD_SMS\')}', [0, 0.08, 0]),
  sms('AM-SMS-PROMO', '24h coverage promo', 'promo', 'Promo window',
    'Amil Dental: use your plan in 24h + 20% OFF annual plans. Ends on the 31st: ${clickthrough(\'PROMO_SMS\')} Reply STOP to opt out', [0, 0.12, 0.1]),
  sms('AM-SMS-WINBACK', 'Comeback offer', 'winback', 'Lapsed members',
    'Amil Dental: we miss you! 15% OFF your first 3 months back: ${clickthrough(\'WINBACK_SMS\')} Reply STOP to opt out', [0, 0.1, 0.08]),
  sms('AM-SMS-NPS', 'Quick survey', 'nps', '30 days after visit',
    'Amil Dental: from 0 to 10, how likely are you to recommend us? Reply with a number. Thank you!', [0, 0.2, 0]),
  sms('AM-SMS-OPTIN', 'Confirm mobile number', 'prefs', 'Unverified numbers',
    'Amil Dental: please confirm this is your mobile to get boleto reminders. Reply YES. Reply STOP to opt out', [0, 0.15, 0]),
  sms('AM-SMS-PME', 'Business – broker contact', 'pme', 'PME proposals',
    'Amil Dental Business: the ${COMPANY_NAME} proposal is saved. Your broker ${CORRETOR} can help: ${clickthrough(\'PME_SMS\')}', [0, 0.1, 0.1]),
  { ...sms('AM-SMS-INVOICE', 'Digital invoice + PIX', 'billing', 'Invoice issued',
    'Amil Dental: your digital invoice is ready. Pay in seconds with PIX copy & paste: ${clickthrough(\'INVOICE_PIX\')} Reply STOP to opt out', [0, 0.18, 0.22]), source: 'Concept 04 · AMIL_SMS_LEMB_FATURA_PIX' },
  { ...sms('AM-SMS-ZERO', 'Zero waiting period approved', 'cart', 'Cart left, high intent',
    'Amil Dental: ${CONTACTS_LIST.FIRST_NAME}, zero waiting period approved for you! Activate your plan with PIX: ${clickthrough(\'ZERO_SMS\')} Reply STOP to opt out', [0, 0.2, 0.18]), source: 'Concept 07 · AMIL_SMS_ALERTA_CARENCIA_ZERO' },
];

/* ------------------------------------------------------------------ */
/* WebPush templates                                                  */
/* ------------------------------------------------------------------ */

const push = (
  id: string,
  name: string,
  topic: CampaignTopic,
  bestFor: string,
  p: PushContent,
  lifts: [number, number, number]
): AmilTemplate => ({
  id,
  name,
  channel: 'WebPush',
  topic,
  bestFor,
  openLift: lifts[0],
  clickLift: lifts[1],
  convLift: lifts[2],
  push: p,
});

const PUSH: AmilTemplate[] = [
  push('AM-WP-CART', 'Cart saved', 'cart', '30 min after cart left',
    { title: 'Your plan is saved 🦷', body: '${PET_ULTIMO_CARRINHO.NOME_PRODUTO} – finish in 2 minutes.', link: 'CART_PUSH', button1: 'Finish now', button2: 'Talk to a broker', imageUrl: IMG('care') }, [0, 0.22, 0.16]),
  push('AM-WP-PRICE', 'Price per member', 'promo', 'Viewed a plan page',
    { title: 'Dental plans from R$ 16.83', body: 'Per member / month. Nationwide coverage and 24h emergency care.', link: 'PLANS_PUSH', button1: 'See plans', button2: '', imageUrl: IMG('family') }, [0, 0.18, 0.1]),
  push('AM-WP-BOLETO', 'Boleto due tomorrow', 'billing', '1 day before due date',
    { title: 'Your boleto is due tomorrow', body: 'Pay with PIX and keep your plan active.', link: 'BOLETO_PUSH', button1: 'Pay with PIX', button2: 'View boleto', imageUrl: IMG('payment') }, [0, 0.15, 0.18]),
  push('AM-WP-RECALL', 'Check-up reminder', 'recall', 'No visit in 180 days',
    { title: 'Time for your check-up', body: 'It’s been 6 months. Find a dentist near you.', link: 'NETWORK_PUSH', button1: 'Find a dentist', button2: '', imageUrl: IMG('checkup') }, [0, 0.12, 0.04]),
  push('AM-WP-PROMO', '20% off annual plan', 'promo', 'Promo window',
    { title: '20% OFF annual plans', body: 'And use your plan in 24h. Offer ends this month.', link: 'PROMO_PUSH', button1: 'Get the offer', button2: '', imageUrl: IMG('smile') }, [0, 0.16, 0.12]),
  push('AM-WP-APP', 'Get the app', 'welcome', 'New members',
    { title: 'Your member card on your phone', body: 'Download the Amil Dental app and have everything at hand.', link: 'APP_PUSH', button1: 'Get the app', button2: '', imageUrl: '' }, [0, 0.14, 0.02]),
  push('AM-WP-ESTETICA', 'Aesthetic line', 'upsell', 'Active members',
    { title: 'Whitening in your plan ✨', body: 'Discover the Amil Dental Aesthetic Line.', link: 'AESTHETIC_PUSH', button1: 'Learn more', button2: '', imageUrl: IMG('smile') }, [0, 0.14, 0.1]),
  push('AM-WP-WINBACK', 'Comeback offer', 'winback', 'Lapsed visitors',
    { title: 'Smile with us again', body: '15% OFF your first 3 months back.', link: 'WINBACK_PUSH', button1: 'Come back', button2: '', imageUrl: IMG('smile') }, [0, 0.12, 0.08]),
  push('AM-WP-INDIQUE', 'Refer a friend', 'referral', 'Happy members',
    { title: 'Refer a friend, get 1 month free', body: 'Share your link with friends and family.', link: 'REFER_PUSH', button1: 'Get my link', button2: '', imageUrl: IMG('family') }, [0, 0.1, 0.05]),
  { ...push('AM-WP-CART15', 'Proposal reserved – 15 min', 'cart', '15 min after cart left',
    { title: '🦷 Amil Dental: your proposal is reserved!', body: 'Your oral health is one click away. Finish on the website.', link: 'CART15_PUSH', button1: 'Finish sign-up', button2: '', imageUrl: IMG('care') }, [0, 0.26, 0.18]), source: 'Concept 02 · CAMP_WEBPUSH_CARRINHO_IMEDIATO' },
  { ...push('AM-WP-KIDS', 'Amil Dental Kids', 'kids', 'Families with children',
    { title: 'Amil Dental Kids', body: 'Specialist protection for your child’s smile.', link: 'KIDS_PUSH', button1: 'See pediatric network', button2: '', imageUrl: IMG('family') }, [0, 0.14, 0.05]), source: 'Concept 06 · AMIL_DENTAL_KIDS_PREVENCAO' },
  { ...push('AM-WP-FLASH', '48h whitening flash', 'upsell', 'Active members, 48h window',
    { title: '✨ Whitening: special offer for 48h', body: 'A whiter smile with the Amil Aesthetic Line.', link: 'FLASH_PUSH', button1: 'Simulate now', button2: '', imageUrl: IMG('smile') }, [0, 0.2, 0.12]), source: 'Concept 08 · CAMP_WEBPUSH_FLASH_ESTETICA' },
];

export const AMIL_TEMPLATES: AmilTemplate[] = [...EMAIL, ...SMS, ...PUSH];

export const templatesForChannel = (ch: TemplateChannel) => AMIL_TEMPLATES.filter((t) => t.channel === ch);

/** Templates for a channel, best topic match first. */
export function rankTemplates(ch: TemplateChannel, topic: CampaignTopic): AmilTemplate[] {
  const list = templatesForChannel(ch);
  return [...list.filter((t) => t.topic === topic), ...list.filter((t) => t.topic !== topic)];
}

export const getTemplate = (id: string) => AMIL_TEMPLATES.find((t) => t.id === id);

/** Where a template came from, for badges. */
export const sourceLabel = (t: AmilTemplate) =>
  !t.source ? '' : /\.html?$/i.test(t.source) ? 'From Responsys' : 'From your concepts';

/* ------------------------------------------------------------------ */
/* Personalisation tokens & sample profiles (for preview only)        */
/* ------------------------------------------------------------------ */

export const RPL_TOKENS: { label: string; token: string }[] = [
  { label: 'First name', token: '${CONTACTS_LIST.FIRST_NAME}' },
  { label: 'Cart product', token: '${PET_ULTIMO_CARRINHO.NOME_PRODUTO}' },
  { label: 'Members', token: '${PET_ULTIMO_CARRINHO.BENEFICIARIOS}' },
  { label: 'Plan benefit 1', token: '${CARRINHO_VANTAGENS.VANTAGEM_1}' },
  { label: 'Price', token: '${PRODUCT_DETAIL.CARD_0}' },
  { label: 'Due date', token: '${PET_BOLETO.DATA_VENCIMENTO}' },
  { label: 'Request no.', token: '${PET_BOLETO.NUM_SOLICITACAO}' },
  { label: 'Company', token: '${COMPANY_NAME}' },
  { label: 'Broker', token: '${CORRETOR}' },
];

export interface SampleProfile {
  id: string;
  label: string;
  offer: string; // segment's recommended offer (from campaignConcepts.ts customer profiles)
  promo: string; // promo code
  data: Record<string, string>;
}

const COMMON = {
  'CARRINHO_VANTAGENS.VANTAGEM_1': 'Nationwide | 2 to 99 members',
  'CARRINHO_VANTAGENS.VANTAGEM_2': 'Orthodontic records',
  'CARRINHO_VANTAGENS.VANTAGEM_3': 'Standard teeth whitening',
  'CARRINHO_VANTAGENS.VANTAGEM_4': 'Root canal treatment',
  'PRODUCT_DETAIL.CARD_0': '40.90',
  'PET_BOLETO.DATA_VENCIMENTO': '09/06',
  'PET_BOLETO.NUM_SOLICITACAO': '94866950',
  'PET_BOLETO.LINHA_DIGITAVEL': '00190.50095 40144.816069 06809.350314 3 37370000000100',
  CORRETOR: 'Carlos Souza',
  'CONTACTS_LIST.EMAIL_ADDRESS_': 'member@example.com',
};

export const SAMPLE_PROFILES: SampleProfile[] = [
  {
    id: 'sp-pf',
    label: 'São Paulo · individual (Dental 205)',
    offer: 'Sign up online with zero waiting period by card',
    promo: 'CARENCIAZERO',
    data: { ...COMMON, 'CONTACTS_LIST.FIRST_NAME': 'Jessica', 'PET_ULTIMO_CARRINHO.NOME_PRODUTO': 'Dental 205 National', 'PET_ULTIMO_CARRINHO.BENEFICIARIOS': '2', 'PRODUCT_DETAIL.CARD_0': '49.90', COMPANY_NAME: '' },
  },
  {
    id: 'rj-kids',
    label: 'Rio de Janeiro · Kids K25/K26',
    offer: 'Prevention with no co-pay and pediatric dentists',
    promo: 'KIDS24H',
    data: { ...COMMON, 'CONTACTS_LIST.FIRST_NAME': 'Rafael', 'PET_ULTIMO_CARRINHO.NOME_PRODUTO': 'Amil Dental Kids K25', 'PET_ULTIMO_CARRINHO.BENEFICIARIOS': '3', 'PRODUCT_DETAIL.CARD_0': '54.00', 'CARRINHO_VANTAGENS.VANTAGEM_1': 'Pediatric dentists', 'CARRINHO_VANTAGENS.VANTAGEM_2': 'Fluoride and sealants', COMPANY_NAME: '' },
  },
  {
    id: 'pme-campinas',
    label: 'Campinas · business, 18 members',
    offer: 'Aesthetic Line upgrade with special business pricing',
    promo: 'PMEESTETICA',
    data: { ...COMMON, 'CONTACTS_LIST.FIRST_NAME': 'Mariana', 'PET_ULTIMO_CARRINHO.NOME_PRODUTO': 'Dental E30 Business', 'PET_ULTIMO_CARRINHO.BENEFICIARIOS': '18', COMPANY_NAME: 'Campinas Tech Ltd', 'PRODUCT_DETAIL.CARD_0': '39.90' },
  },
  {
    id: 'cwb-estetica',
    label: 'Curitiba · Aesthetic Line VIP',
    offer: 'Teeth whitening with no extra co-pay',
    promo: 'CLAREAMENTO',
    data: { ...COMMON, 'CONTACTS_LIST.FIRST_NAME': 'Carla', 'PET_ULTIMO_CARRINHO.NOME_PRODUTO': 'Aesthetic Line D205', 'PET_ULTIMO_CARRINHO.BENEFICIARIOS': '1', 'PRODUCT_DETAIL.CARD_0': '115.00', COMPANY_NAME: '' },
  },
  {
    id: 'bh-recall',
    label: 'Belo Horizonte · no visit in 210 days',
    offer: 'Cleaning and check-up 100% covered',
    promo: 'CHECKUP100',
    data: { ...COMMON, 'CONTACTS_LIST.FIRST_NAME': 'Bruno', 'PET_ULTIMO_CARRINHO.NOME_PRODUTO': 'Dental 205', 'PET_ULTIMO_CARRINHO.BENEFICIARIOS': '1', 'PRODUCT_DETAIL.CARD_0': '49.90', COMPANY_NAME: '' },
  },
  {
    id: 'empty',
    label: 'No name on file (fallback test)',
    offer: 'Dental plans with nationwide coverage',
    promo: 'AMILDENTAL',
    data: { ...COMMON, 'CONTACTS_LIST.FIRST_NAME': '', 'PET_ULTIMO_CARRINHO.NOME_PRODUTO': 'Dental 205', 'PET_ULTIMO_CARRINHO.BENEFICIARIOS': '1', 'CARRINHO_VANTAGENS.VANTAGEM_4': '', COMPANY_NAME: '' },
  },
];
