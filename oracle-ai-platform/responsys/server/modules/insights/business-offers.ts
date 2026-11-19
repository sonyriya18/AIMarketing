import { createHash } from 'node:crypto';
import type { WebsiteOffer } from '../../../shared/business/offers';

const clean = (value: string) => value.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const promotion = /\b(oferta|desconto|promoção|promocao|discount|offer|cashback|grátis|gratis|free)\b|condições exclusivas/i;

/** Copy published offer blocks verbatim. Never execute storefront configuration or infer missing terms. */
export function websiteOffers(raw: string, sourceUrl: string, landingUrl: string, checkedAt: string, commerce = false): WebsiteOffer[] {
  const found: WebsiteOffer[] = [];
  const add = (title: string, text: string, target = landingUrl, audienceContext = '') => {
    title = clean(title); text = clean(text);
    if (!promotion.test(`${title} ${text}`) || !title || title.length > 180 || text.length < 20 || text.length > 1200 || /\$\{|data-bind|<%|\{\{/.test(text)) return;
    let url: URL;
    try { url = new URL(target, landingUrl); if (url.origin !== new URL(landingUrl).origin || url.protocol !== 'https:') return; } catch { return; }
    const id = createHash('sha256').update(`${landingUrl}:${title}:${text}`).digest('hex').slice(0, 24);
    if (!found.some((item) => item.id === id)) found.push({ id, title, text, sourceUrl, landingUrl: url.href, checkedAt, audience: /quem é|por ser|somente.*(cliente|beneficiário)|existing members|members only/i.test(`${audienceContext} ${text}`) ? 'members' : 'unspecified' });
  };
  if (commerce) {
    // Oracle Commerce benefit cards are public, structured promotional copy. This is data parsing, not eval.
    const visit = (value: unknown, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12) return;
      if ((value as Record<string, unknown>).hidden === true || (value as Record<string, unknown>).isPreview === true) return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'benefitsCardsConfiguration' && typeof item === 'string' && item.length < 30_000) {
          try {
            const cards = JSON.parse(item.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, s: string) => JSON.stringify(s.replace(/\\'/g, "'"))));
            const widget = value as Record<string, unknown>;
            const destination = typeof widget.benefitsSectionCTALink === 'string' ? new URL(widget.benefitsSectionCTALink, landingUrl).href : landingUrl;
            const audienceContext = [widget.benefitsSectionTitle, widget.benefitsSectionTitleMobile].filter((v) => typeof v === 'string').join(' ');
            if (Array.isArray(cards)) for (const card of cards) if (typeof card['1'] === 'string' && typeof card['2'] === 'string') add(card['1'], card['2'], typeof card['3'] === 'string' && /^[\w-]+$/.test(card['3']) ? `${destination}#${card['3']}` : destination, audienceContext);
          } catch { /* Unreadable configurations contribute no offers. */ }
        } else if (typeof item === 'object') visit(item, depth + 1);
      }
    };
    try { visit(JSON.parse(raw)); } catch { /* No structured public offers. */ }
  } else {
    const html = raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[^]*?-->/g, '');
    for (const block of html.matchAll(/<(article|section)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const heading = block[2]!.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
      if (heading) add(heading, block[2]!);
    }
  }
  return found.slice(0, 8);
}
