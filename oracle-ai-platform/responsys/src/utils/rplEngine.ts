/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * RPL engine
 *  - buildEmailRpl : EmailContent → Responsys-ready HTML with RPL
 *  - renderRpl     : preview renderer for the RPL subset we generate
 *                    (<#assign>, <#if>/<#else>, ${VAR}, ${VAR!"x"},
 *                    ${clickthrough('LINK')}). Preview only — Responsys
 *                    is the real renderer.
 *  - smsStats / removeAccents / buildPushJson
 */

import { EmailContent } from '../data/amilTemplates';
import { neutralBrand, type BrandKit } from '../content/brand';

const DEFAULT_BRAND = neutralBrand('Your brand');

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const TOKEN_RE = /(\$\{[^}]+\})/g;
const tokenName = (tok: string) => tok.replace(/^\$\{/, '').replace(/\}$/, '').replace(/!.*$/, '').trim();

/* ------------------------------------------------------------------ */
/* Preview renderer                                                   */
/* ------------------------------------------------------------------ */

export interface RenderOptions {
  linkMode?: 'href' | 'short';
  shortLinkDomain?: string;
  escape?: boolean;
}

function makeLookup(data: Record<string, string>) {
  return (raw: string): string | undefined => {
    const name = raw.trim();
    if (name in data) return data[name];
    const last = name.split('.').pop() || name;
    if (last in data) return data[last];
    const k = Object.keys(data).find((x) => x.endsWith(`.${last}`));
    return k ? data[k] : undefined;
  };
}

const shortHash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 5);
};

export function renderRpl(src: string, data: Record<string, string>, opts: RenderOptions = {}): string {
  const { linkMode = 'href', escape = true } = opts;
  const vars: Record<string, string> = { ...data };
  let s = src.replace(/<#--[\s\S]*?-->/g, '');
  s = s.replace(/<#assign\s+([\w.]+)\s*=\s*"([^"]*)"\s*\/?>/g, (_m, k, v) => {
    vars[k] = v;
    return '';
  });
  const lookup = makeLookup(vars);

  const evalCond = (c: string): boolean => {
    const cond = c.trim();
    let m = cond.match(/^([\w.]+)\?has_content$/);
    if (m) return !!lookup(m[1]);
    m = cond.match(/^([\w.]+)\s*==\s*"([^"]*)"$/);
    if (m) return (lookup(m[1]) || '') === m[2];
    m = cond.match(/^([\w.]+)\s*!=\s*"([^"]*)"$/);
    if (m) return (lookup(m[1]) || '') !== m[2];
    return !!lookup(cond);
  };

  // Resolve innermost <#if> blocks first (supports nesting)
  const IF_RE = /<#if\s+([^>]+)>((?:(?!<#if)[\s\S])*?)<\/#if>/;
  let guard = 0;
  while (IF_RE.test(s) && guard++ < 500) {
    s = s.replace(IF_RE, (_m, cond: string, body: string) => {
      const [yes, no = ''] = body.split(/<#else>/);
      return evalCond(cond) ? yes : no;
    });
  }

  s = s.replace(/\$\{\s*clickthrough\(\s*['"]([^'"]+)['"][^)]*\)\s*\}/g, (_m, name: string) =>
    linkMode === 'short' ? `${opts.shortLinkDomain ?? DEFAULT_BRAND.shortLinkDomain}/${shortHash(name)}` : `#${name}`
  );

  s = s.replace(/\$\{\s*([\w.]+)\s*(?:!\s*"([^"]*)")?\s*!?\s*\}/g, (_m, name: string, def?: string) => {
    const v = lookup(name);
    if (v === undefined) return def !== undefined ? def : `[${name}]`;
    if (v === '' && def !== undefined) return def;
    return escape ? escapeHtml(v) : v;
  });
  return s;
}

/* ------------------------------------------------------------------ */
/* Email builder                                                      */
/* ------------------------------------------------------------------ */

export const THEMES = {
  purple: { primary: '#461bff', accent: '#00adff', name: 'Violet' },
  cyan: { primary: '#0088cc', accent: '#461bff', name: 'Cyan' },
  navy: { primary: '#1e1b4b', accent: '#00adff', name: 'Business navy' },
};

export interface BuildOptions {
  mode: 'rpl' | 'edit';
  data?: Record<string, string>; // sample data (edit mode)
  preferencesLink?: boolean;
  comment?: string; // header comment (conditions summary)
  brand?: BrandKit;
}

export function buildEmailRpl(c: EmailContent, o: BuildOptions): string {
  const t = THEMES[c.theme] || THEMES.purple;
  const brand = o.brand ?? DEFAULT_BRAND;
  const edit = o.mode === 'edit';
  const lookup = makeLookup(o.data || {});

  /** Text field → RPL (tokens kept) or editable HTML (tokens as chips). */
  const f = (text: string, field?: string, tag = 'span', style = '') => {
    const parts = text.split(TOKEN_RE).map((p) => {
      if (!p) return '';
      if (/^\$\{/.test(p)) {
        if (!edit) return p;
        const name = tokenName(p);
        const v = lookup(name);
        const shown = v === undefined ? `[${name}]` : v || `(${name.split('.').pop()?.toLowerCase()})`;
        return `<span class="rpl-tok" contenteditable="false" data-token="TOKEN:${escapeHtml(name)}">${escapeHtml(shown)}</span>`;
      }
      return escapeHtml(p);
    });
    const attrs = edit && field ? ` data-edit="${field}"` : '';
    // Line breaks typed in a field (or written by the AI) are kept as <br>.
    return `<${tag}${attrs}${style ? ` style="${style}"` : ''}>${parts.join('').replace(/\r?\n/g, '<br>')}</${tag}>`;
  };

  const isPureToken = (s: string) => /^\s*\$\{[^}]+\}\s*$/.test(s);

  const bullets = c.bullets
    .filter((b) => b.trim())
    .map((b, i) => {
      const row = `<tr><td width="28" valign="top" style="padding:6px 0"><span style="display:inline-block;width:20px;height:20px;line-height:20px;border-radius:10px;background:${t.accent};color:#fff;font-size:12px;text-align:center;font-family:Arial,sans-serif">&#10003;</span></td><td style="padding:6px 0;font-size:15px;line-height:22px;color:#444">${f(b, `bullets.${i}`)}</td></tr>`;
      return isPureToken(b) && !edit ? `<#if ${tokenName(b)}?has_content>${row}</#if>` : row;
    })
    .join('\n');

  let highlight = '';
  const ht = c.highlightType;
  if (ht === 'offer') {
    highlight = `<table role="presentation" data-website-offer="true" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:#eefaff;border:2px solid ${t.accent};border-radius:12px"><tr><td style="padding:20px">
      ${f(c.highlightLabel, 'highlightLabel', 'h2', `margin:0 0 10px;font-family:Arial,sans-serif;font-size:24px;line-height:30px;color:${t.primary}`)}
      ${f(c.highlightValue, 'highlightValue', 'p', 'margin:0 0 10px;font-size:17px;line-height:26px;color:#243551')}
      ${f(c.highlightNote, 'highlightNote', 'p', 'margin:0;font-size:12px;line-height:18px;color:#5f6570')}
    </td></tr></table>`;
  } else if (ht === 'price') {
    highlight = `<table role="presentation" width="100%" style="margin:20px 0;background:#f4f6ff;border-radius:10px"><tr><td align="center" style="padding:18px">
      ${f(c.highlightLabel, 'highlightLabel', 'div', 'font-size:13px;color:#706f6f')}
      ${f(c.highlightValue, 'highlightValue', 'div', `font-size:34px;font-weight:bold;color:${t.primary};font-family:Arial,sans-serif;line-height:42px`)}
      ${f(c.highlightNote, 'highlightNote', 'div', 'font-size:13px;color:#706f6f')}
    </td></tr></table>`;
  } else if (ht === 'discount') {
    highlight = `<table role="presentation" width="100%" style="margin:20px 0"><tr><td align="center" style="padding:16px;border:2px dashed ${t.accent};border-radius:10px">
      ${f(c.highlightLabel, 'highlightLabel', 'div', 'font-size:13px;color:#706f6f;text-transform:uppercase;letter-spacing:1px')}
      ${f(c.highlightValue, 'highlightValue', 'div', `font-size:40px;font-weight:bold;color:${t.accent};font-family:Arial,sans-serif;line-height:48px`)}
      ${f(c.highlightNote, 'highlightNote', 'div', 'font-size:13px;color:#706f6f')}
    </td></tr></table>`;
  } else if (ht === 'boleto') {
    highlight = `<table role="presentation" width="100%" style="margin:20px 0"><tr><td style="padding:0">
      ${f(c.highlightLabel, 'highlightLabel', 'div', 'font-size:13px;color:#706f6f;margin-bottom:6px')}
      ${f(c.highlightValue, 'highlightValue', 'div', 'font-family:Courier New,monospace;font-size:14px;color:#222;background:#f4f4f4;border:1px solid #d9d9d9;border-radius:6px;padding:12px;word-break:break-all;text-align:center')}
      ${f(c.highlightNote, 'highlightNote', 'div', 'font-size:12px;color:#706f6f;margin-top:6px')}
    </td></tr></table>`;
  } else if (ht === 'promo') {
    highlight = `<table role="presentation" width="100%" style="margin:20px 0"><tr><td style="padding:14px 18px;background:#fffbea;border:2px dashed #f2c94c;border-radius:10px">
      ${f(c.highlightLabel, 'highlightLabel', 'div', 'font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#8a5a00')}
      ${f(c.highlightValue, 'highlightValue', 'div', 'font-size:15px;font-weight:bold;color:#a15c00;margin:4px 0')}
      ${c.highlightNote.trim() ? `<div style="font-family:Courier New,monospace;font-size:12px;color:#5c4400">PROMO CODE: ${f(c.highlightNote, 'highlightNote', 'strong')}</div>` : ''}
    </td></tr></table>`;
  } else if (ht === 'nps') {
    const cells = Array.from({ length: 11 }, (_, n) =>
      `<td align="center" style="padding:2px"><a href="\${clickthrough('${c.ctaLink}')}" style="display:block;width:30px;height:30px;line-height:30px;border-radius:6px;background:${n <= 6 ? '#fde2e1' : n <= 8 ? '#fff1c2' : '#d7f5e3'};color:#333;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold">${n}</a></td>`
    ).join('');
    highlight = `<table role="presentation" width="100%" style="margin:20px 0"><tr><td align="center">
      ${f(c.highlightLabel, 'highlightLabel', 'div', 'font-size:15px;color:#333;font-weight:bold;margin-bottom:10px')}
      <table role="presentation" class="nps"><tr>${cells}</tr></table>
      ${f(c.highlightNote, 'highlightNote', 'div', 'font-size:12px;color:#706f6f;margin-top:8px')}
    </td></tr></table>`;
  } else if (ht === 'steps') {
    const steps = c.highlightValue
      .split('|')
      .map((s, i) => `<tr><td width="36" valign="top" style="padding:6px 0"><span style="display:inline-block;width:26px;height:26px;line-height:26px;border-radius:13px;background:${t.primary};color:#fff;font-size:13px;font-weight:bold;text-align:center;font-family:Arial,sans-serif">${i + 1}</span></td><td style="padding:8px 0;font-size:15px;color:#444">${f(s, `step.${i}`)}</td></tr>`)
      .join('');
    highlight = `<table role="presentation" width="100%" style="margin:20px 0;background:#f4f6ff;border-radius:10px"><tr><td style="padding:16px 18px">
      ${f(c.highlightLabel, 'highlightLabel', 'div', `font-size:14px;font-weight:bold;color:${t.primary};margin-bottom:6px`)}
      <table role="presentation" width="100%">${steps}</table>
    </td></tr></table>`;
  }

  const showSecondary = !!c.secondaryText.trim();

  const greeting = c.greeting
    ? `<p style="margin:0 0 12px;font-size:17px;color:#333;font-weight:bold"><#if CONTACTS_LIST.FIRST_NAME?has_content>Hi \${CONTACTS_LIST.FIRST_NAME},<#else>Hi there,</#if></p>`
    : '';

  const prefs = o.preferencesLink
    ? `<br>Prefer fewer emails? <a href="\${clickthrough('PREFERENCES')}" style="color:#706f6f">Update your preferences</a>.`
    : '';

  const editCss = edit
    ? `[data-edit]{transition:outline-color .15s}[data-edit][contenteditable=true]:hover{outline:2px dashed #00adff;outline-offset:3px;cursor:text}[data-edit][contenteditable=true]:focus{outline:2px solid #461bff;outline-offset:3px}.rpl-tok{background:#eef0ff;color:#461bff;border-radius:3px;padding:0 3px;font-weight:bold}`
    : '';

  const img = c.heroImage.trim();
  const heroBg = img
    ? `background-color:${t.primary};background-image:linear-gradient(90deg,${rgba(t.primary, 0.96)} 0%,${rgba(t.primary, 0.82)} 42%,${rgba(t.primary, 0.1)} 100%),url('${img}');background-size:cover;background-position:center right`
    : `background-color:${t.primary};background-image:linear-gradient(135deg,${t.primary},${t.accent})`;
  const hero = `<tr><td class="hero px"${img ? ` background="${escapeHtml(img)}"` : ''} bgcolor="${t.primary}" valign="middle" style="${heroBg};padding:46px 32px 50px">
 ${f(c.eyebrow, 'eyebrow', 'div', `font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;color:${img ? '#9fe3ff' : '#ffffff'};margin-bottom:10px`)}
 ${f(c.headline, 'headline', 'h1', 'margin:0;max-width:340px;font-family:Arial,sans-serif;font-size:30px;line-height:36px;color:#ffffff;font-weight:bold').replace('<h1', '<h1 class="h1"')}
 ${c.heroSub.trim() ? f(c.heroSub, 'heroSub', 'p', 'margin:12px 0 0;max-width:330px;font-size:14px;line-height:20px;color:#ffffff') : ''}
</td></tr>`;
  const trustItems = brand.trustItems;
  const trust = c.trustBar && trustItems.length
    ? `<tr><td style="background:#f4f6ff;padding:14px 12px"><table role="presentation" width="100%"><tr>${trustItems
        .map(
          ([ic, b, l]) =>
            `<td class="tb" align="center" width="33%" style="font-size:12px;color:#555;line-height:16px"><span style="display:inline-block;width:34px;height:34px;line-height:34px;border-radius:17px;background:#ffffff;font-size:17px;margin-bottom:4px">${ic}</span><br><strong style="color:${t.primary}">${b}</strong> ${l}</td>`
        )
        .join('')}</tr></table></td></tr>`
    : '';

  // Facts come from the selected brand kit; a kit without facts renders no band.
  const stats = brand.facts;
  const statsBand = c.statsBand && stats.length
    ? `<tr><td class="px" style="padding:22px 24px;background:${t.primary};background-image:linear-gradient(135deg,${t.primary},${t.accent})"><table role="presentation" width="100%"><tr>${stats
        .map(([n, l]) => `<td class="tb" align="center" width="33%" style="color:#ffffff;font-family:Arial,sans-serif"><div style="font-size:24px;font-weight:bold;line-height:28px">${n}</div><div style="font-size:12px;opacity:.85">${l}</div></td>`)
        .join('')}</tr></table></td></tr>`
    : '';
  const app = brand.appBanner;
  const appBanner = c.appBanner && app
    ? `<tr><td class="px" style="padding:8px 32px 24px"><table role="presentation" width="100%" style="background:#f4f6ff;border-radius:14px"><tr>
  <td class="stack" width="120" align="center" valign="middle" style="padding:18px 0 18px 18px"><div style="width:74px;height:120px;border-radius:14px;background:#1f1f2e;padding:5px;box-sizing:border-box"><div style="width:100%;height:100%;border-radius:10px;background:linear-gradient(160deg,${t.primary},${t.accent});color:#fff;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;text-align:center;padding-top:44px;box-sizing:border-box">${app.cardLabel}</div></div></td>
  <td class="stack" valign="middle" style="padding:18px;font-family:Arial,sans-serif">
   <div style="font-size:16px;font-weight:bold;color:${t.primary};margin-bottom:4px">${app.title}</div>
   <div style="font-size:13px;color:#555;line-height:19px;margin-bottom:10px">${app.subtitle}</div>
   <a href="\${clickthrough('APP_STORE')}" style="display:inline-block;background:#111;color:#fff;font-size:11px;font-weight:bold;text-decoration:none;padding:7px 12px;border-radius:8px;margin:0 6px 6px 0">&#63743; App Store</a><a href="\${clickthrough('GOOGLE_PLAY')}" style="display:inline-block;background:#111;color:#fff;font-size:11px;font-weight:bold;text-decoration:none;padding:7px 12px;border-radius:8px;margin:0 0 6px 0">&#9654; Google Play</a>
  </td></tr></table></td></tr>`
    : '';

  const comment = o.comment ? `<#-- ${o.comment.replace(/--/g, '–')} -->\n` : '';

  return `${comment}<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(c.subject.replace(TOKEN_RE, ''))}</title>
<style>
body{margin:0;padding:0;background:#e3e5ef;-webkit-text-size-adjust:100%}
a{color:${t.primary}}
@media only screen and (max-width:620px){
 .wrap{width:100%!important}
 .px{padding-left:20px!important;padding-right:20px!important}
 .h1{font-size:24px!important;line-height:30px!important;max-width:100%!important}
 .hero{padding:34px 20px 38px!important;background-position:72% center!important}
 .tb{font-size:11px!important}
 .stack{display:block!important;width:100%!important;box-sizing:border-box;text-align:center!important;padding:14px!important}
 .cta a{display:block!important}
 .nps td{padding:1px!important}
 .nps a{width:22px!important;height:26px!important;line-height:26px!important;font-size:11px!important}
}
${editCss}
</style>
</head>
<body style="margin:0;padding:0;background:#e3e5ef">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${f(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e3e5ef">
<tr><td align="center" style="padding:16px 8px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;font-family:Verdana,Arial,sans-serif;color:#555">
<tr><td align="center" style="padding:10px;font-size:11px;color:#878787;background:#f7f7fa">Can’t see this email? <a href="\${clickthrough('VIEW_ONLINE')}" style="color:#878787">View it in your browser</a>.</td></tr>
<tr><td class="px" style="padding:16px 32px">
 <table role="presentation" width="100%"><tr>
  <td style="font-family:Arial,sans-serif;font-size:28px;font-weight:bold;color:${t.primary};letter-spacing:-1px">${escapeHtml(brand.wordmark[0])}<span style="color:${t.accent};font-weight:normal">${escapeHtml(brand.wordmark[1])}</span></td>
  <td align="right" style="font-size:12px"><a href="\${clickthrough('MEMBER_AREA')}" style="color:${t.primary};text-decoration:none;font-weight:bold">${escapeHtml(brand.memberAreaLabel ?? '')}${brand.memberAreaLabel ? ' &rsaquo;' : ''}</a></td>
 </tr></table>
</td></tr>
${hero}
${trust}
<tr><td class="px" style="padding:28px 32px 8px">
 ${greeting}
 ${f(c.intro, 'intro', 'p', 'margin:0 0 16px;font-size:15px;line-height:24px;color:#555')}
 ${ht === 'offer' ? highlight : ''}
 ${c.bulletsTitle || bullets ? `${c.bulletsTitle ? f(c.bulletsTitle, 'bulletsTitle', 'p', `margin:12px 0 4px;font-size:15px;font-weight:bold;color:${t.primary}`) : ''}<table role="presentation" width="100%" style="background:#f8f9ff;border-radius:10px"><tr><td style="padding:6px 14px"><table role="presentation" width="100%">${bullets}</table></td></tr></table>` : ''}
 ${ht !== 'offer' ? highlight : ''}
 <table role="presentation" width="100%" class="cta" style="margin:20px 0 8px"><tr><td align="center">
  <a href="\${clickthrough('${c.ctaLink}')}" style="display:inline-block;background:${t.accent};color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;padding:15px 36px;border-radius:30px">${f(c.ctaText, 'ctaText')}</a>
 </td></tr>${
   c.cta2Text.trim()
     ? `<tr><td align="center" style="padding-top:10px"><a href="\${clickthrough('${c.cta2Link}')}" style="display:inline-block;background:#ffffff;color:${t.primary};border:2px solid ${t.primary};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 30px;border-radius:30px">${f(c.cta2Text, 'cta2Text')}</a></td></tr>`
     : ''
 }</table>
 ${showSecondary ? f(c.secondaryText, 'secondaryText', 'p', 'margin:6px 0 20px;font-size:13px;color:#706f6f;text-align:center') : ''}
</td></tr>
${statsBand}
${appBanner}
<tr><td class="px" style="padding:18px 32px;background:#f7f7fa;border-top:1px solid #ededed">
 <table role="presentation" align="center" style="margin:0 auto 10px"><tr>${[
   ['FACEBOOK', 'f'],
   ['INSTAGRAM', '&#9673;'],
   ['LINKEDIN', 'in'],
   ['YOUTUBE', '&#9654;'],
 ]
   .map(
     ([l, g]) =>
       `<td style="padding:0 4px"><a href="\${clickthrough('${l}')}" style="display:inline-block;width:30px;height:30px;line-height:30px;border-radius:15px;background:${t.primary};color:#ffffff;text-align:center;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold">${g}</a></td>`
   )
   .join('')}</tr></table>
 ${f(c.legal, 'legal', 'p', 'margin:0 0 10px;font-size:10px;line-height:15px;color:#878787')}
 <p style="margin:0;font-size:10px;line-height:15px;color:#878787">This email was sent to \${CONTACTS_LIST.EMAIL_ADDRESS_}. To stop receiving our emails, <a href="\${clickthrough('UNSUBSCRIBE')}" style="color:#878787">unsubscribe here</a>.${prefs}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Read text back from an edited preview element, restoring RPL tokens. */
export function readEditedText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-token]').forEach((tok) => {
    const name = (tok.getAttribute('data-token') || '').replace(/^TOKEN:/, '');
    tok.replaceWith(el.ownerDocument.createTextNode(`\${${name}}`));
  });
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(el.ownerDocument.createTextNode('\n')));
  return (clone.textContent || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, i, all) => line || (i > 0 && i < all.length - 1))
    .join('\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* SMS                                                                */
/* ------------------------------------------------------------------ */

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';

export function smsStats(text: string) {
  let gsm = true;
  let units = 0;
  const bad = new Set<string>();
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      bad.add(ch);
    }
  }
  const length = gsm ? units : [...text].length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);
  return { encoding: gsm ? 'GSM-7' : 'UCS-2 (Unicode)', length, segments, limit: segments <= 1 ? single : multi * segments, nonGsm: [...bad] };
}

export const removeAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7F€£¥]/g, '');

/* ------------------------------------------------------------------ */
/* WebPush                                                            */
/* ------------------------------------------------------------------ */

export function buildPushJson(p: { title: string; body: string; link: string; button1: string; button2: string; imageUrl: string }, campaign: string, iconUrl: string | null = null) {
  return JSON.stringify(
    {
      campaign,
      title: p.title,
      body: p.body,
      icon: iconUrl ?? undefined,
      image: p.imageUrl ? (p.imageUrl.startsWith('data:') ? '[uploaded image – host it in Content Library]' : p.imageUrl) : undefined,
      clickUrl: `\${clickthrough('${p.link}')}`,
      actions: [p.button1, p.button2].filter(Boolean).map((t, i) => ({ id: `btn${i + 1}`, title: t })),
      ttlSeconds: 86400,
    },
    null,
    2
  );
}
