import type { BusinessStrategy, Fact } from './summary';

/** Explicit, website-grounded playbooks remain available when the AI omits or rejects its strategy list. */
export function businessPlaybooks(facts: Fact[]): BusinessStrategy[] {
  const website = facts.filter((f) => f.section === 'business');
  // Detect the sector from retrieved content, not the account name or URL.
  const dental = website.find((f) => /\b(dental|dentist\w*|odontol[oó]g\w*|odontologia)\b/i.test(f.text.replace(/^Official website[^\n]*\n/, '').replace(/https?:\/\/\S+/g, '')));
  const report = facts.filter((f) => !['business', 'limits'].includes(f.section));
  if (!dental || !report.length) return [];
  const hasPlans = /\b(plan[os]*|enroll\w*|contrata\w*)\b/i.test(dental.text);
  const enrollment = /\bonline\b|enroll\w*|contrata\w*/i.test(dental.text);
  const evidence = (pattern: RegExp) => report.find((f) => ['attention', 'weaknesses'].includes(f.section) && pattern.test(f.text)) ?? report.find((f) => pattern.test(f.text)) ?? report[0]!;
  const make = (strategyKey: BusinessStrategy['strategyKey'], name: string, goal: string, actions: string[], pattern: RegExp): BusinessStrategy => {
    const fact = evidence(pattern);
    return { strategyKey, name, goal, actions, reason: `Proposed for the dental business described on the website. Report signal: ${fact.text.slice(0, 160)}`, factIds: [dental.id, fact.id], generator: 'rule_based' };
  };
  if (!hasPlans) return [
    make('engagement', 'Dental Care Discovery', 'Help opted-in contacts explore the dental services described on the website.', ['Test a dental-service information CTA against the current message.', 'Validate enquiry or appointment tracking before measuring downstream outcomes.'], /click|open/i),
    make('hygiene', 'Dental Contact Quality', 'Protect delivery of dental-service communications.', ['Review bounced and unsubscribed contacts before the next send.', 'Test clear dental-service sender identification with a consented audience.'], /bounce|deliver|unsubscribe/i),
  ];
  const plans = [
    make('engagement', 'Dental Plan Discovery', 'Help prospective members explore dental plans.', ['Test dental-plan information against the current campaign content.', 'Test one clear plan-discovery CTA and compare click rates.'], /click|open/i),
    make('revenue', enrollment ? 'Dental Plan Enrollment' : 'Dental Plan Enquiries', enrollment ? 'Guide opted-in prospects toward online dental-plan enrollment.' : 'Guide opted-in prospects toward dental-plan information.', ['Test a plan-comparison CTA against the current message.', 'Validate enquiry or enrollment tracking before measuring new plan sign-ups.'], /conversion|revenue|click/i),
    make('welcome', 'New Dental Member Welcome', 'Explain how to use a dental plan after enrollment.', ['Validate member status and consent before starting onboarding.', 'Test a welcome message linking to the official plan-use information.'], /open|click|deliver/i),
    make('retention', 'Dental Member Support', 'Test useful plan guidance with verified current members.', ['Validate member status before selecting the audience.', 'Test plan-access guidance and communication preferences with a control group.'], /unsubscribe|complaint|click/i),
    make('reengage', 'Dental Interest Re-engagement', 'Invite opted-in contacts to revisit dental-plan information.', ['Validate inactivity signals and consent before selecting contacts.', 'Test a dental-plan information reminder with a clear preference link.'], /open|click/i),
    make('hygiene', 'Dental Contact Quality', 'Protect delivery of dental-plan communications.', ['Review bounced and unsubscribed contacts before the next send.', 'Test clear dental-plan sender identification with a consented audience.'], /bounce|deliver|unsubscribe/i),
  ];
  const network = /dentist network|provider network|rede\s+(credenciada|de\s+dentistas)|encontre.{0,30}dentista/i.test(dental.text);
  if (network) plans[0] = make('engagement', 'Dentist Network Discovery', 'Help prospects explore the official dentist network and dental plans.', ['Test a find-a-dentist CTA against a plan-information CTA.', 'Compare click engagement before expanding the test.'], /click|open/i);
  return plans;
}
