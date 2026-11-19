/**
 * The AI Simulator's strategy options. The AI may pick one of these keys for a report period; the
 * simulator's own cards (icons, program plans) use the same keys.
 */
export const STRATEGY_OPTIONS = [
  { key: 'engagement', name: 'Engagement Boost', goal: 'Lift opens and clicks' },
  { key: 'cart', name: 'Cart Recovery', goal: 'Recover people who clicked or carted but did not buy' },
  { key: 'retention', name: 'Retention & Loyalty', goal: 'Reduce unsubscribes and complaints; keep customers longer' },
  { key: 'hygiene', name: 'List Hygiene', goal: 'Reduce bounces and protect delivery' },
  { key: 'reengage', name: 'Re-engagement', goal: 'Wake up contacts who stopped opening' },
  { key: 'revenue', name: 'Revenue Growth', goal: 'Raise revenue per delivered message' },
  { key: 'welcome', name: 'Welcome & Onboarding', goal: 'Convert new sign-ups' },
  { key: 'winback', name: 'Win-back', goal: 'Bring back lapsed buyers' },
] as const;

export type StrategyKey = (typeof STRATEGY_OPTIONS)[number]['key'];
export const STRATEGY_KEYS = STRATEGY_OPTIONS.map((s) => s.key) as StrategyKey[];
