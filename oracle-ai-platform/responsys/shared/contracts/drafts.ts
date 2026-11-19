/**
 * Draft content contract (channel-specific) and local validation.
 *
 * Validation here is the LOCAL tier only (schema, tokens, links, lengths, encoding). It is never
 * presented as Responsys validation; provider compilation and proof delivery are separate tiers.
 */
import { z } from 'zod';

const text = (max: number) => z.string().max(max);

export const EmailContentSchema = z
  .object({
    subject: text(300),
    preheader: text(300),
    eyebrow: text(200),
    headline: text(300),
    heroSub: text(400),
    heroImage: text(2000),
    trustBar: z.boolean(),
    greeting: z.boolean(),
    intro: text(5000),
    bulletsTitle: text(300),
    bullets: z.array(text(400)).max(12),
    highlightType: z.enum(['none', 'price', 'boleto', 'discount', 'nps', 'steps', 'promo', 'offer']),
    highlightLabel: text(200),
    highlightValue: text(1200),
    highlightNote: text(400),
    ctaText: text(120),
    ctaLink: text(120),
    cta2Text: text(120),
    cta2Link: text(120),
    secondaryText: text(1000),
    appBanner: z.boolean(),
    statsBand: z.boolean(),
    legal: text(4000),
    theme: z.enum(['purple', 'cyan', 'navy']),
  })
  .strict();

export const PushContentSchema = z
  .object({ title: text(200), body: text(500), link: text(120), button1: text(60), button2: text(60), imageUrl: text(2000) })
  .strict();

export const DraftContentSchema = z
  .object({
    email: EmailContentSchema,
    sms: z.object({ text: text(2000) }).strict(),
    push: PushContentSchema,
    customEmailCode: z.string().max(200_000).nullable().default(null),
    preferencesLink: z.boolean().default(false),
    templateIds: z.object({ email: text(80), sms: text(80), push: text(80) }).partial().default({}),
    contentPack: z.string().max(40).default('starter'),
  })
  .strict();
export type DraftContent = z.infer<typeof DraftContentSchema>;

export interface ValidationMessage {
  channel: 'email' | 'sms' | 'push' | 'general';
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface LocalValidation {
  tier: 'local';
  label: 'Local checks only — not validated by Responsys';
  passed: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  sms: { characters: number; segments: number; encoding: 'GSM-7' | 'UCS-2' };
}

const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'.split('')
);
const GSM7_EXT = new Set('^{}\\[~]|€'.split(''));

/** SMS length by actual encoding: GSM-7 (extension chars count twice) or UCS-2 code units. */
export function smsSegments(s: string) {
  let gsm = true;
  let septets = 0;
  for (const ch of s) {
    if (GSM7.has(ch)) septets += 1;
    else if (GSM7_EXT.has(ch)) septets += 2;
    else gsm = false;
  }
  if (gsm) return { characters: septets, segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153), encoding: 'GSM-7' as const };
  const units = s.length; // UTF-16 code units (emoji count as two)
  return { characters: units, segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67), encoding: 'UCS-2' as const };
}

const TOKEN_RE = /\$\{([^}]{1,200})\}/g;
const CLICK_RE = /clickthrough\(\s*'([^']*)'/g;
const URL_RE = /\b(?:https?|javascript|data):[^\s"'<>)]+/gi;

export function validateDraft(content: DraftContent, opts: { knownTokens: string[]; allowedLinkDomains: string[] }): LocalValidation {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const known = new Set(opts.knownTokens.map((t) => t.replace(/^\$\{|\}$/g, '').split('!')[0]!.trim()));
  const scan = (channel: ValidationMessage['channel'], field: string, value: string) => {
    for (const m of value.matchAll(TOKEN_RE)) {
      const name = m[1]!.split('!')[0]!.trim();
      if (name.startsWith('clickthrough(') || name.startsWith('form(')) continue;
      if (!known.has(name) && !/^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)?$/.test(name)) {
        errors.push({ channel, field, severity: 'error', message: `"\${${name}}" is not a valid personalization token` });
      } else if (!known.has(name)) {
        warnings.push({ channel, field, severity: 'warning', message: `"\${${name}}" is not in the account's known fields; confirm it exists in your profile list or PET` });
      }
    }
    for (const m of value.matchAll(CLICK_RE)) {
      if (!/^[A-Z0-9_]{1,60}$/.test(m[1]!)) errors.push({ channel, field, severity: 'error', message: `Link-table name "${m[1]}" must use A–Z, 0–9 and _` });
    }
    for (const m of value.matchAll(URL_RE)) {
      const url = m[0]!;
      if (!/^https:/i.test(url)) {
        (url.toLowerCase().startsWith('http:') ? warnings : errors).push({ channel, field, severity: url.toLowerCase().startsWith('http:') ? 'warning' : 'error', message: `Unsafe or insecure link: ${url.slice(0, 80)}` });
        continue;
      }
      if (opts.allowedLinkDomains.length) {
        try {
          const host = new URL(url).hostname.toLowerCase();
          if (!opts.allowedLinkDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
            warnings.push({ channel, field, severity: 'warning', message: `${host} is not in the account's allowed link domains` });
          }
        } catch {
          errors.push({ channel, field, severity: 'error', message: `Invalid URL: ${url.slice(0, 80)}` });
        }
      }
    }
  };
  const e = content.email;
  for (const [k, v] of Object.entries(e)) if (typeof v === 'string') scan('email', k, v);
  e.bullets.forEach((b, i) => scan('email', `bullets.${i}`, b));
  if (content.customEmailCode) {
    scan('email', 'customEmailCode', content.customEmailCode);
    if (/<script\b|\son\w+\s*=|javascript:/i.test(content.customEmailCode)) errors.push({ channel: 'email', field: 'customEmailCode', severity: 'error', message: 'Scripts and inline event handlers are not allowed in email HTML' });
  }
  if (!e.subject.trim()) errors.push({ channel: 'email', field: 'subject', severity: 'error', message: 'Subject line is required' });
  if (e.subject.length > 90) warnings.push({ channel: 'email', field: 'subject', severity: 'warning', message: `Subject is ${e.subject.length} characters; many inboxes truncate long subjects` });
  if (!e.ctaText.trim()) warnings.push({ channel: 'email', field: 'ctaText', severity: 'warning', message: 'No button text' });
  if (e.ctaText.trim() && !/^[A-Z0-9_]{1,60}$/.test(e.ctaLink)) errors.push({ channel: 'email', field: 'ctaLink', severity: 'error', message: 'Button link must be a link-table name (A–Z, 0–9, _)' });
  if (e.heroImage && !/^https:\/\//.test(e.heroImage)) {
    (e.heroImage.startsWith('data:') ? warnings : errors).push({
      channel: 'email',
      field: 'heroImage',
      severity: e.heroImage.startsWith('data:') ? 'warning' : 'error',
      message: e.heroImage.startsWith('data:') ? 'Banner is an uploaded preview image; host it in the Responsys Content Library before launch' : 'Banner image must be an https URL',
    });
  }

  scan('sms', 'text', content.sms.text);
  const sms = smsSegments(content.sms.text.replace(/\$\{[^}]+\}/g, 'XXXXXXXXXX'));
  if (sms.segments > 1) warnings.push({ channel: 'sms', field: 'text', severity: 'warning', message: `About ${sms.segments} SMS segments (${sms.encoding}) after personalization; check your provider's limits` });
  if (content.sms.text && !/stop|sair|opt.?out|unsubscribe/i.test(content.sms.text)) {
    warnings.push({ channel: 'sms', field: 'text', severity: 'warning', message: 'No opt-out wording found; confirm your account and country rules' });
  }

  const p = content.push;
  for (const [k, v] of Object.entries(p)) scan('push', k, v);
  if (p.title.length > 50) warnings.push({ channel: 'push', field: 'title', severity: 'warning', message: `Title is ${p.title.length} characters; long titles are truncated on many devices` });
  if (p.body.length > 120) warnings.push({ channel: 'push', field: 'body', severity: 'warning', message: `Message is ${p.body.length} characters; long text is truncated on many devices` });
  if (p.link && !/^[A-Z0-9_]{1,60}$/.test(p.link)) errors.push({ channel: 'push', field: 'link', severity: 'error', message: 'Push link must be a link-table name (A–Z, 0–9, _)' });

  return { tier: 'local', label: 'Local checks only — not validated by Responsys', passed: errors.length === 0, errors, warnings, sms };
}
