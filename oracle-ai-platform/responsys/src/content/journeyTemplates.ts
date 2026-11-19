import { STRATEGY_KEYS, type StrategyKey } from '../../shared/scenario/strategies';
import { journeyFor } from '../../shared/scenario/journeys';
import { AMIL_IMAGES, type AmilTemplate, type CampaignTopic, type EmailContent } from '../data/amilTemplates';
import { usableWebsiteOffer, type WebsiteOffer } from '../../shared/business/offers';

/** Add an explicitly selected website offer without replacing onboarding or response-gated guidance. */
export function withWebsiteOffer(template: AmilTemplate, offer: WebsiteOffer | undefined, strategy: StrategyKey): AmilTemplate {
  if (!template.email || !offer || !usableWebsiteOffer(offer, strategy)) return template;
  return { ...template, source: `Published website offer: ${offer.sourceUrl}`, email: { ...template.email,
    highlightType: 'offer', highlightLabel: offer.title, highlightValue: offer.text,
    highlightNote: 'See the official offer for eligibility and full terms.',
    secondaryText: '',
    ctaText: 'View offer and eligibility', ctaLink: 'WEBSITE_OFFER',
    cta2Text: template.email.ctaText, cta2Link: template.email.ctaLink,
    legal: `${template.email.legal} Published offer: ${offer.text} Source: ${offer.landingUrl}. Retrieved ${offer.checkedAt.slice(0, 10)}. Eligibility, availability and full terms must be checked on the official website before launch.`,
  } };
}

const TOPICS: Record<StrategyKey, CampaignTopic> = { engagement: 'promo', revenue: 'promo', welcome: 'welcome', retention: 'prefs', hygiene: 'prefs', reengage: 'winback', cart: 'cart', winback: 'winback' };
const DENTAL_COPY: Record<StrategyKey, [string, string]> = {
  engagement: ['Looking for dentist-network information? Explore the official Amil Dental resources and review the dental-plan information that is relevant to you.', 'Still looking for a dentist? Use the official dentist-network information to explore your next step with Amil Dental.'],
  revenue: ['Explore Amil Dental plan information and review the options that are relevant to you before choosing your next step.', 'Take another look at the official plan information. Use the checklist below to organize your questions before continuing.'],
  welcome: ['Welcome to Amil Dental. Start with the official information about using your plan and finding the right support.', 'Here is a getting-started checklist for your Amil Dental plan. Read the official guidance and find the support information you need.'],
  retention: ['Keep useful Amil Dental plan information close at hand. Explore the official member guidance and support resources.', 'Here are useful plan-support resources and a reminder that you can choose the communications you receive from Amil Dental.'],
  hygiene: ['Choose the Amil Dental communications that are useful to you. Review your email preferences using the link below.', 'You can manage your Amil Dental communication choices whenever your needs change. Here is a guide to reviewing your preferences.'],
  reengage: ['If dental-plan information is still relevant to you, take a fresh look at the official Amil Dental information.', 'Thank you for your interest in Amil Dental information. Here is a next-step guide to exploring the official plan information and choosing your communication preferences.'],
  cart: ['If you started an Amil Dental enrollment and would like to continue, review the official information before taking your next step.', 'Need help with your next enrollment step? Review the official Amil Dental information and available support resources.'],
  winback: ['If you are considering dental-plan options again, explore the current information on the official Amil Dental website.', 'Take your time reviewing the official Amil Dental plan information and choose the next step that is relevant to you.'],
};

/** Campaign-scoped drafts: distinct initial/follow-up copy, with no borrowed prices or benefit claims. */
export function journeyEmailTemplates(business: 'dental' | 'general'): AmilTemplate[] {
  return STRATEGY_KEYS.flatMap((key) => {
    const journey = journeyFor(key, business);
    return journey.campaigns.flatMap((campaign) => ['story', 'guide'].map((layout): AmilTemplate => {
      const follow = campaign.role === 'follow_up';
      const guide = layout === 'guide';
      const dental = business === 'dental';
      const email: EmailContent = {
        subject: `${guide ? 'Your guide: ' : ''}${campaign.subject}`,
        preheader: dental ? DENTAL_COPY[key][follow ? 1 : 0] : campaign.purpose,
        eyebrow: dental ? 'AMIL DENTAL' : 'YOUR NEXT STEP', headline: campaign.name,
        heroSub: dental ? (follow ? 'Helpful information for your next step.' : 'Explore the official Amil Dental information.') : campaign.purpose,
        heroImage: dental && !guide ? (key === 'welcome' || key === 'retention' ? AMIL_IMAGES.smile.url : AMIL_IMAGES.care.url) : '',
        trustBar: false, greeting: true,
        intro: dental ? DENTAL_COPY[key][follow ? 1 : 0] : follow ? 'Here is a helpful guide to the information we shared. Explore the official information at your own pace.' : 'Explore the information that is relevant to you and choose your next step using our official website.',
        bulletsTitle: guide ? 'A simple guide' : '',
        bullets: guide ? dental
          ? key === 'hygiene' || key === 'retention' ? ['Review the communications you want to receive', 'Choose useful information and support resources', 'Update your communication preferences']
            : key === 'welcome' ? ['Read the official getting-started information', 'Explore the guidance for using your plan', 'Find the official support resources']
              : ['Explore the official dental-plan information', 'Review the information relevant to your needs', 'Use the official website for your next step']
          : ['Review the official information', 'Choose the option that is relevant to you', 'Use the official website for your next step'] : [],
        highlightType: 'none', highlightLabel: '', highlightValue: '', highlightNote: '',
        ctaText: campaign.cta, ctaLink: campaign.link,
        cta2Text: '', cta2Link: '', secondaryText: '', appBanner: false, statsBand: false,
        legal: dental ? 'You are receiving Amil Dental communications according to your communication preferences. You can update your preferences or unsubscribe at any time.' : 'You are receiving this message according to your communication preferences. You can update your preferences or unsubscribe at any time.',
        theme: dental ? (guide ? 'cyan' : 'purple') : 'navy',
      };
      return {
        id: `JB-${business.toUpperCase()}-${key.toUpperCase()}-${campaign.role.toUpperCase()}-${layout.toUpperCase()}`,
        name: `${campaign.name} · ${guide ? 'Practical guide' : 'Brand story'}`,
        channel: 'Email', topic: TOPICS[key], journeyCampaignId: campaign.id,
        source: dental ? 'Amil Dental business draft · customer-inspired layout; review official links and current copy' : 'Account-branded journey draft',
        bestFor: `${follow ? 'Follow-up email' : 'Initial email'} · ${guide ? 'Checklist and next steps' : 'One clear call to action'}`,
        openLift: 0, clickLift: 0, convLift: 0, email,
      };
    }));
  });
}
