/**
 * "Ask AI about this": any screen can open Ask AI with a question already sent, about the whole
 * dashboard or the selected campaign.
 */
import { createContext, useContext } from 'react';

export type AskAi = (question: string, scope?: 'account' | 'campaign') => void;
export const AskAiContext = createContext<AskAi | null>(null);
export const useAskAi = () => useContext(AskAiContext);

/**
 * The AI Simulator's current scenario, shared with Ask AI so it can discuss the plan on screen.
 * Every value is the user's assumption or an estimate from them, never a measured result.
 */
export interface SimulatorScenario {
  reportId: string;
  strategy: string;
  template: string | null;
  baseline: string;
  channel: string;
  currency: string;
  audience: number;
  audienceBasis: string;
  openMultiplier: number;
  clickMultiplier: number;
  averageOrderValue: number;
  rangePct: number;
  launchSchedule?: string;
  estimateBasis?: 'hour' | 'weekday' | 'baseline';
  expectedOpenRate?: number | null;
  expectedClickRate?: number | null;
  outcome: {
    delivered: number;
    conversions: number;
    conversionsLow: number;
    conversionsHigh: number;
    revenue: number;
    revenueLow: number;
    revenueHigh: number;
    baselineRevenue: number | null;
  } | null;
}
