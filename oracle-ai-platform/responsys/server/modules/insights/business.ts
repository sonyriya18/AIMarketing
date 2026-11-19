import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { websiteOffers } from './business-offers';
import type { WebsiteOffer } from '../../../shared/business/offers';

export interface BusinessContext {
  status: 'ready' | 'unavailable' | 'not_configured';
  website: string | null;
  checkedAt: string;
  sources: { url: string; text: string }[];
  message: string;
  offers?: WebsiteOffer[];
}

export function websiteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(url.hostname) || !url.hostname.includes('.')) throw new Error('Use a public HTTPS business website without credentials or a custom port.');
  url.hash = '';
  return url;
}

// Resolve once and pin the connection to a public IPv4 address, including on redirects.
export function publicAddress(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

function sameOfficialOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.port === b.port && a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
}

async function readPage(url: URL, signal: AbortSignal, redirects = 0, json = false): Promise<{ url: string; html: string }> {
  websiteUrl(url.href);
  signal.throwIfAborted();
  const addresses = await Promise.race([
    lookup(url.hostname, { family: 4, all: true }),
    new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Website lookup timed out.')), { once: true })),
  ]);
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address))) throw new Error('Website must resolve to public addresses.');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal, family: 4, headers: { 'User-Agent': 'CampaignIntelligence/1.0 (business website research)', Accept: json ? 'application/json' : 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      lookup: (_host, _options, callback) => callback(null, addresses[0]!.address, 4),
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (redirects >= 3 || !sameOfficialOrigin(next, url)) return reject(new Error('Website redirects outside the configured origin. Use its final official URL.'));
        readPage(next, signal, redirects + 1, json).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200 || !res.headers['content-type']?.includes(json ? 'application/json' : 'text/html')) {
        res.resume();
        reject(new Error(`Website returned HTTP ${res.statusCode ?? 'unknown'} or an unsupported content type.`));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 750_000) { req.destroy(new Error('Website page exceeds the reading limit.')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ url: url.href, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function pageText(html: string): string {
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 6500);
}

/** Oracle Commerce storefronts publish their visible page content separately from the HTML shell. */
export function commercePageHtml(raw: string): string {
  const page = JSON.parse(raw);
  const parts: string[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 12 || !value || typeof value !== 'object') return;
    const widget = value as { instanceName?: string; typeId?: string };
    if (/notification|broker|header|footer|script|countdown|aviso/i.test(`${widget.instanceName ?? ''} ${widget.typeId ?? ''}`)) return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^(title|description|templateSrc|html|content|heading|text)$/i.test(key)) parts.push(item);
      else if (typeof item === 'object') visit(item, depth + 1);
    }
  };
  visit({ title: page.title, description: page.description });
  visit(page.regions);
  return parts.join('\n');
}

const cache = new Map<string, { until: number; value: Promise<BusinessContext> }>();

export function researchWebsite(website: string | undefined): Promise<BusinessContext> {
  const key = website || '';
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (cache.size >= 50) cache.delete(cache.keys().next().value!);
  const value = readWebsite(website);
  const entry = { until: Date.now() + 15 * 60_000, value };
  cache.set(key, entry);
  void value.then((v) => { if (v.status === 'unavailable') entry.until = Date.now() + 60_000; });
  return value;
}

async function readWebsite(website: string | undefined): Promise<BusinessContext> {
  const checkedAt = new Date().toISOString();
  const base = { website: website || null, checkedAt, sources: [] };
  if (!website) return { ...base, status: 'not_configured', message: 'Add the official website to tailor recommendations to this business.' };
  try {
    let url = websiteUrl(website);
    const signal = AbortSignal.timeout(20_000);
    let home = await readPage(url, signal);
    url = new URL(home.url);
    const sources: BusinessContext['sources'] = [];
    const offers = websiteOffers(home.html, home.url, home.url, checkedAt);
    if (/id=["']oracle-cc["']/i.test(home.html)) {
      const contentUrl = new URL(`/ccstore/v1/pages/${url.pathname === '/' ? 'home' : encodeURIComponent(url.pathname.slice(1))}`, url);
      try {
        const content = await readPage(contentUrl, signal, 0, true);
        offers.push(...websiteOffers(content.html, content.url, home.url, checkedAt, true));
        home = { url: home.url, html: commercePageHtml(content.html) };
        const text = pageText(home.html);
        if (text.length >= 120) sources.push({ url: content.url, text });
      } catch { /* Keep readable HTML, if any; never invent content for a JavaScript shell. */ }
    }
    const links = [...home.html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].flatMap((m) => {
      try {
        const link = new URL(m[1]!, url);
        return link.origin === url.origin && /about|sobre|planos|plans|products|produtos|servicos|services|empresa|oferta|promo|desconto|beneficio|offer|discount/i.test(link.pathname) && !/\.(pdf|jpg|png|zip)$/i.test(link.pathname) ? [link.href] : [];
      } catch { return []; }
    });
    const extra = await Promise.allSettled([...new Set(links)].filter((x) => x !== url.href).slice(0, 2).map((x) => readPage(new URL(x), signal)));
    for (const result of extra) if (result.status === 'fulfilled') offers.push(...websiteOffers(result.value.html, result.value.url, result.value.url, checkedAt));
    sources.push(...[...(sources.length ? [] : [home]), ...extra.flatMap((x) => x.status === 'fulfilled' ? [x.value] : [])].map((p) => ({ url: p.url, text: pageText(p.html) })).filter((p) => p.text.length >= 120));
    if (!sources.length) throw new Error('No readable business content.');
    return { ...base, status: 'ready', sources, offers: [...new Map(offers.map((offer) => [offer.id, offer])).values()].slice(0, 8), message: 'Official website content retrieved. Recommendations combine this context with report evidence; proposed actions need validation.' };
  } catch {
    return { ...base, status: 'unavailable', message: 'The official website could not be read. Recommendations use report data only. Check the URL or try again later.' };
  }
}
