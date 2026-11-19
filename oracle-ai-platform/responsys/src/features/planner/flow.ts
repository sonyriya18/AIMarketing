/** Proposed program blueprint types (a local plan, never a deployed Responsys program). */
import type { JourneyCondition, JourneyPlan } from '../../../shared/scenario/journeys';
export type FlowNodeType = 'entry' | 'filter' | 'email' | 'sms' | 'push' | 'wait' | 'decision' | 'exit';
export interface FlowNode {
  id: string;
  type: FlowNodeType;
  title: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'neutral';
  conditionGroup?: 'entry' | 'filters' | 'exclusions';
  campaignId?: string;
  criteria?: JourneyCondition[];
  branches?: { yes: FlowNode[]; no: FlowNode[] };
}
export interface ProgramFlow {
  main: FlowNode[];
  decision: FlowNode;
  yes: FlowNode[];
  no: FlowNode[];
  summary?: string;
}

export interface FlowPlan {
  audienceName: string;
  suppressionRule: string;
  first: 'email' | 'sms' | 'push';
  waitDays: number;
  decisionMetric: 'opened' | 'clicked' | 'converted';
  followUp: 'email' | 'sms' | 'push' | 'none';
  firstName?: string;
  followUpName?: string;
  firstCampaignId?: string;
  followUpCampaignId?: string;
}

const LABEL = { email: 'Email', sms: 'SMS', push: 'Push' } as const;

export function buildFlow(p: FlowPlan): ProgramFlow {
  const main: FlowNode[] = [
    { id: 'entry', type: 'entry', title: p.audienceName || 'Audience', sub: 'Proposed entry', conditionGroup: 'entry' },
    { id: 'filter', type: 'filter', title: p.suppressionRule || 'Filter conditions', sub: 'Filter conditions', conditionGroup: 'filters' },
    { id: 'first', type: p.first, title: p.firstName || `${LABEL[p.first]} message`, sub: 'Initial campaign', campaignId: p.firstCampaignId },
    { id: 'wait', type: 'wait', title: `Wait ${p.waitDays} day${p.waitDays === 1 ? '' : 's'}` },
  ];
  const decision: FlowNode = { id: 'decision', type: 'decision', title: `${p.decisionMetric[0]!.toUpperCase()}${p.decisionMetric.slice(1)}?` };
  const yes: FlowNode[] = [{ id: 'exit-yes', type: 'exit', title: 'Goal reached', tone: 'good' }];
  const no: FlowNode[] =
    p.followUp === 'none'
      ? [{ id: 'exit-no', type: 'exit', title: 'No response', tone: 'neutral' }]
      : [
          { id: 'follow', type: p.followUp, title: p.followUpName || `${LABEL[p.followUp]} follow-up`, sub: 'Follow-up campaign', campaignId: p.followUpCampaignId },
          { id: 'exit-no', type: 'exit', title: 'End', tone: 'neutral' },
        ];
  return { main, decision, yes, no };
}

/** Different objectives use different routing; these are proposed programs, not inferred recipient behavior. */
export function buildStrategyFlow(journey: JourneyPlan, strategyName: string): ProgramFlow {
  const dental = journey.business === 'dental';
  const entry: FlowNode = { id: 'entry', type: 'entry', title: `${strategyName} audience`, sub: 'Proposed entry', conditionGroup: 'entry' };
  const filter = (id = 'filter', title = 'Email opt-in I · deliverable D'): FlowNode => ({ id, type: 'filter', title, sub: 'Email eligibility', conditionGroup: 'filters', criteria: journey.filters });
  const first: FlowNode = { id: 'first', type: 'email', title: journey.campaigns[0].name, sub: 'Initial campaign', campaignId: journey.campaigns[0].id };
  const second = (sub: string): FlowNode => ({ id: 'follow', type: 'email', title: journey.campaigns[1].name, sub, campaignId: journey.campaigns[1].id });
  const wait = (id: string, days: number): FlowNode => ({ id, type: 'wait', title: `Wait ${days} day${days === 1 ? '' : 's'}`, sub: 'Proposed interval' });
  const exit = (id: string, title: string, tone: FlowNode['tone'] = 'neutral'): FlowNode => ({ id, type: 'exit', title, tone });
  const custom = (field: string, condition: string, purpose: string): JourneyCondition => ({ field, condition, purpose, source: 'custom' });
  const activity = (condition: string): JourneyCondition[] => [{ field: 'Initial email · Click activity', condition, purpose: 'Configure tracking for this campaign in the program.', source: 'activity' }];
  const completed = [custom(dental ? 'PET_DENTAL_PROFILE.ENROLLMENT_STATUS' : 'PET_CUSTOMER.JOURNEY_GOAL_COMPLETED', dental ? "= 'COMPLETED'" : "= 'Y'", 'Proposed completion signal; map and validate it before using this decision.')];
  const exclusion: FlowNode = { id: 'exclusion-filter', type: 'filter', title: 'Remove suppressed or goal-complete contacts', sub: 'Exclusion filter', conditionGroup: 'exclusions', criteria: journey.exclusions.filter((row) => row.field.includes('SUPPRESS_FLAG') || row.field === journey.exclusions.at(-1)?.field) };
  const decision = (id: string, title: string, criteria: JourneyCondition[], branches?: FlowNode['branches']): FlowNode => ({ id, type: 'decision', title, criteria, ...(branches ? { branches } : {}) });
  switch (journey.strategyKey) {
    case 'engagement': return {
      main: [entry, filter(), first, wait('wait', journey.waitDays)],
      decision: decision('decision', 'Clicked the discovery email?', activity('Has clicked the initial email')),
      yes: [exit('exit-yes', 'Interest recorded', 'good')],
      no: [second('Alternative information for non-clickers'), exit('exit-no', 'End discovery test')],
      summary: 'Discovery test: send an alternative information email only to non-clickers; engaged contacts exit.',
    };
    case 'revenue': return {
      main: [entry, filter(), exclusion, first, wait('wait', journey.waitDays)],
      decision: decision('decision', dental ? 'Enrollment completed?' : 'Goal completed?', completed),
      yes: [exit('exit-yes', 'Goal recorded', 'good')],
      no: [filter('follow-filter', 'Recheck email eligibility'), second('Help prospects who have not converted'), wait('completion-wait', 2), decision('completion-check', 'Completed after the guide?', completed, { yes: [exit('exit-after-guide', 'Goal recorded after guide', 'good')], no: [exit('exit-no', 'End acquisition journey')] })],
      summary: 'Acquisition: remove goal-complete contacts, recheck eligibility before the guide, then check completion again.',
    };
    case 'welcome': return {
      main: [entry, filter(), first, wait('wait', journey.waitDays), second('Scheduled onboarding step'), wait('onboarding-wait', 5)],
      decision: decision('decision', 'Getting-started guide clicked?', [{ field: 'Getting-started email · Click activity', condition: 'Has clicked the second onboarding email', purpose: 'Configure tracking for the getting-started email.', source: 'activity' }]),
      yes: [exit('exit-yes', 'Guide engagement recorded', 'good')], no: [exit('exit-no', 'Review onboarding support needs')],
      summary: 'Onboarding series: welcome first, then a scheduled getting-started guide. Evaluate engagement after the sequence.',
    };
    case 'retention': return {
      main: [entry, filter()],
      decision: decision('decision', 'Member support requested?', [custom(dental ? 'PET_DENTAL_SUPPORT.SUPPORT_REQUESTED' : 'PET_CUSTOMER.SUPPORT_REQUESTED', "= 'Y'", 'Proposed support-request signal; unknown status must be held for review.')]),
      yes: [first, wait('wait', journey.waitDays), second('Scheduled support and preferences guide'), exit('exit-yes', 'Support sequence complete', 'good')],
      no: [exit('exit-no', 'No support outreach · review unknowns')],
      summary: 'Member support: check for a verified support request before any email. Only that branch receives the support sequence.',
    };
    case 'hygiene': return {
      main: [entry],
      decision: decision('decision', 'Email eligible to contact?', journey.filters),
      yes: [first, wait('wait', journey.waitDays), decision('preference-check', 'Preferences confirmed?', [custom('PET_MARKETING_CONTROL.PREFERENCE_CONFIRMED', "= 'Y'", 'Map a verified preference-update signal; do not assume a click is a preference update.')], { yes: [filter('filter', 'Recheck consent before preferences guide'), second('Guide for confirmed contacts only'), exit('exit-yes', 'Preference guidance complete', 'good')], no: [exit('exit-inactive', 'Pause unresponsive contacts')] })],
      no: [exit('exit-no', 'Hold ineligible or unknown status', 'bad')],
      summary: 'Contact quality: gate on consent and deliverability first. Send the second email only after a verified preference update; otherwise pause.',
    };
    case 'reengage': return {
      main: [entry, filter(), exclusion, first, wait('wait', journey.waitDays)],
      decision: decision('decision', 'Renewed click activity?', activity('Has clicked the re-engagement email')),
      yes: [second('Next-step guide for interested contacts'), exit('exit-yes', 'Renewed interest recorded', 'good')],
      no: [exit('exit-no', 'Pause inactive outreach')],
      summary: 'Re-engagement: interested contacts receive a next-step guide. Non-responders exit instead of receiving another reminder.',
    };
    case 'cart': return {
      main: [entry, filter(), wait('wait', 1)],
      decision: decision('decision', 'Enrollment still incomplete?', [custom(dental ? 'PET_DENTAL_LEAD.ENROLLMENT_STATUS' : 'PET_CUSTOMER.CHECKOUT_STATUS', "IN ('STARTED', 'INCOMPLETE')", 'Require a known incomplete status from mapped event data; hold unknown status.')]),
      yes: [first, wait('reminder-wait', journey.waitDays), exclusion, second('Final completion-help email'), exit('exit-yes', 'End completion-help sequence')],
      no: [exit('exit-no', 'No reminder · complete or review status', 'good')],
      summary: 'Completion help: allow time to finish before sending anything. Only verified incomplete enrollments enter the reminder sequence.',
    };
    case 'winback': return {
      main: [entry, filter(), exclusion],
      decision: decision('decision', 'Eligible to return?', [custom(dental ? 'PET_DENTAL_PROFILE.RETURN_ELIGIBLE' : 'PET_CUSTOMER.RETURN_ELIGIBLE', "= 'Y'", 'Proposed eligibility signal; map it and hold unverified contacts.')]),
      yes: [first, wait('wait', journey.waitDays), decision('return-check', 'Returned or enrolled again?', completed, { yes: [exit('exit-returned', 'Return recorded', 'good')], no: [filter('return-filter', 'Recheck eligibility before final guide'), second('Final guide for eligible former customers'), exit('exit-yes', 'End return journey')] })],
      no: [exit('exit-no', 'Hold contacts not verified as eligible', 'bad')],
      summary: 'Returning customers: verify return eligibility before outreach, then stop the sequence as soon as a return is recorded.',
    };
  }
}
