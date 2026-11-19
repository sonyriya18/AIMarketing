import { z } from 'zod';

export const WebsiteOfferSchema = z.object({
  id: z.string().max(100), title: z.string().max(180), text: z.string().max(1200),
  sourceUrl: z.string().url().max(2000), landingUrl: z.string().url().max(2000),
  checkedAt: z.string().datetime(), audience: z.enum(['members', 'unspecified']),
}).strict();
export type WebsiteOffer = z.infer<typeof WebsiteOfferSchema>;

export function usableWebsiteOffer(offer: WebsiteOffer, strategy: string, now = Date.now()): boolean {
  const age = now - Date.parse(offer.checkedAt);
  return ['welcome', 'reengage'].includes(strategy) && age >= 0 && age < 24 * 60 * 60_000
    && !(strategy === 'reengage' && offer.audience === 'members');
}
