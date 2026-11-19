/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Preview building blocks shared by the What-If simulator and the
 * Campaign Builder.
 */

import React, { useRef } from 'react';
import type { AmilTemplate, PushContent } from '../data/amilTemplates';
import type { BrandKit } from '../content/brand';
import { buildEmailRpl, readEditedText, renderRpl } from '../utils/rplEngine';
import { Bell, Chrome, Signal, Wifi, BatteryFull } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Email iframe (optionally editable in place)                         */
/* ------------------------------------------------------------------ */

export const EmailFrame: React.FC<{
  html: string;
  width: number;
  height: number;
  editable?: boolean;
  onEdit?: (field: string, value: string) => void;
  title: string;
}> = ({ html, width, height, editable, onEdit, title }) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const scrollY = useRef(0);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  const handleLoad = () => {
    const doc = ref.current?.contentDocument;
    const win = ref.current?.contentWindow;
    if (!doc || !win) return;
    win.scrollTo(0, scrollY.current);
    win.addEventListener('scroll', () => (scrollY.current = win.scrollY));
    // Links never navigate inside the preview
    doc.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) e.preventDefault();
    });
    if (!editable) return;
    doc.querySelectorAll<HTMLElement>('[data-edit]').forEach((el) => {
      el.contentEditable = 'true';
      el.spellcheck = false;
      const before = readEditedText(el);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          el.blur();
        }
      });
      el.addEventListener('blur', () => {
        const after = readEditedText(el);
        if (after !== before) onEditRef.current?.(el.dataset.edit || '', after);
      });
    });
  };

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      onLoad={handleLoad}
      style={{ width, height, border: 0, background: '#e3e5ef', display: 'block' }}
      sandbox="allow-same-origin"
    />
  );
};

export const PhoneShell: React.FC<{ children: React.ReactNode; label?: string }> = ({ children, label }) => (
  <div className="flex flex-col items-center gap-1.5">
    <div className="rounded-[36px] bg-[#1c1c1e] p-2.5 shadow-xl">
      <div className="rounded-[28px] overflow-hidden bg-white w-[375px]">
        <div className="h-7 bg-white flex items-center justify-between px-5 text-[11px] font-semibold text-gray-800">
          <span>9:41</span>
          <span className="flex items-center gap-1">
            <Signal className="w-3 h-3" />
            <Wifi className="w-3 h-3" />
            <BatteryFull className="w-3.5 h-3.5" />
          </span>
        </div>
        {children}
      </div>
    </div>
    {label && <span className="text-[10px] text-[#8a7668]">{label}</span>}
  </div>
);

/* ------------------------------------------------------------------ */
/* SMS                                                                */
/* ------------------------------------------------------------------ */

export const SmsPhone: React.FC<{ text: string; sender?: string }> = ({ text, sender = 'BRAND' }) => (
  <PhoneShell label="Mobile">
    <div className="h-[600px] bg-[#f2f2f7] flex flex-col">
      <div className="bg-white/90 border-b border-gray-200 py-2 text-center">
        <div className="w-9 h-9 rounded-full bg-gray-300 mx-auto flex items-center justify-center text-white text-xs font-bold">{sender.slice(0, 1)}</div>
        <div className="text-[11px] font-semibold mt-0.5">{sender}</div>
      </div>
      <div className="flex-1 p-3 flex flex-col justify-end gap-1">
        <div className="text-center text-[10px] text-gray-500 mb-1">Text message · Today 10:00</div>
        <div className="self-start max-w-[80%] bg-[#e5e5ea] text-[14px] leading-snug text-black rounded-2xl rounded-bl-md px-3 py-2 whitespace-pre-wrap break-words">
          {text}
        </div>
      </div>
      <div className="h-11 bg-white border-t border-gray-200 mx-0 flex items-center px-3">
        <div className="flex-1 h-7 rounded-full border border-gray-300 text-[11px] text-gray-400 flex items-center px-3">Text message</div>
      </div>
    </div>
  </PhoneShell>
);

/** Image with a branded gradient behind it, so a slow/blocked image still looks right. */
export const ImageBox: React.FC<{ src: string; className?: string; alt?: string; label?: string }> = ({ src, className = '', alt = '', label = '' }) => (
  <div className={`relative overflow-hidden bg-gradient-to-r from-[#461bff] to-[#00adff] ${className}`}>
    <span className="absolute inset-0 flex items-center justify-center text-white/80 text-xs font-bold">{label}</span>
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="absolute inset-0 w-full h-full object-cover"
      onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/* WebPush                                                            */
/* ------------------------------------------------------------------ */

export const PushDesktop: React.FC<{ p: PushContent; title: string; body: string; brand: BrandKit }> = ({ p, title, body, brand }) => (
  <div className="flex flex-col items-center gap-1.5">
    <div className="w-[600px] max-w-full h-[340px] rounded-xl bg-gradient-to-br from-[#d7e3f4] to-[#b9c8e2] relative overflow-hidden border border-gray-300">
      <div className="h-8 bg-white/70 border-b border-white flex items-center gap-1.5 px-3">
        <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
        <span className="ml-3 text-[10px] text-gray-500 bg-white rounded px-2 py-0.5">{brand.domain}</span>
      </div>
      <div className="absolute right-3 bottom-3 w-[340px] rounded-lg bg-white shadow-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 pt-2 text-[10px] text-gray-500">
          <Chrome className="w-3 h-3" /> Google Chrome · {brand.domain}
        </div>
        {p.imageUrl && <ImageBox src={p.imageUrl} label={brand.name} className="mx-3 mt-2 h-28 rounded" />}
        <div className="flex gap-2.5 p-3">
          <div className="w-10 h-10 rounded-md bg-[#461bff] text-white text-[10px] font-bold flex items-center justify-center shrink-0 overflow-hidden">{brand.wordmark[0].slice(0, 5)}</div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-gray-900 leading-tight">{title}</div>
            <div className="text-[12px] text-gray-600 leading-snug mt-0.5">{body}</div>
          </div>
        </div>
        {(p.button1 || p.button2) && (
          <div className="flex border-t border-gray-200">
            {[p.button1, p.button2].filter(Boolean).map((b) => (
              <span key={b} className="flex-1 text-center text-[12px] py-1.5 text-[#1a56db] border-r last:border-r-0 border-gray-200">
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
    <span className="text-[10px] text-[#8a7668]">Desktop (Chrome on Windows)</span>
  </div>
);

export const PushMobile: React.FC<{ p: PushContent; title: string; body: string; brand: BrandKit }> = ({ p, title, body, brand }) => (
  <PhoneShell label="Mobile (Android)">
    <div className="h-[600px] bg-gradient-to-b from-[#2b3a67] to-[#0f172a] p-3">
      <div className="text-white/80 text-center text-3xl font-light mt-6">9:41</div>
      <div className="text-white/60 text-center text-[11px] mb-5">Tuesday, 13 October</div>
      <div className="rounded-2xl bg-white/95 overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 pt-2 text-[10px] text-gray-500">
          <Bell className="w-3 h-3" /> Chrome · {brand.domain} · now
        </div>
        <div className="flex gap-2.5 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-gray-900 leading-tight">{title}</div>
            <div className="text-[12px] text-gray-600 leading-snug mt-0.5">{body}</div>
          </div>
          <div className="w-10 h-10 rounded-md bg-[#461bff] text-white text-[10px] font-bold flex items-center justify-center shrink-0 overflow-hidden">{brand.wordmark[0].slice(0, 5)}</div>
        </div>
        {p.imageUrl && <ImageBox src={p.imageUrl} label={brand.name} className="mx-3 mb-2 h-32 rounded-lg" />}
        {(p.button1 || p.button2) && (
          <div className="flex gap-4 px-3 pb-2.5">
            {[p.button1, p.button2].filter(Boolean).map((b) => (
              <span key={b} className="text-[12px] font-semibold text-[#1a56db]">
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  </PhoneShell>
);

/* ------------------------------------------------------------------ */
/* Template thumbnail (simulator step 5)                              */
/* ------------------------------------------------------------------ */

export const TemplateThumb: React.FC<{ t: AmilTemplate; brand: BrandKit; sample: Record<string, string> }> = ({ t, brand, sample: SAMPLE }) => {
  if (t.channel === 'Email' && t.email) {
    const html = renderRpl(buildEmailRpl(t.email, { mode: 'rpl', brand }), SAMPLE);
    return (
      <div className="h-[150px] overflow-hidden rounded-md bg-[#e3e5ef] relative">
        <iframe
          title={`${t.name} thumbnail`}
          srcDoc={html}
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          sandbox=""
          style={{ width: 640, height: 640, border: 0, transform: 'scale(0.3)', transformOrigin: 'top left', pointerEvents: 'none' }}
        />
      </div>
    );
  }
  if (t.channel === 'SMS' && t.sms) {
    const text = renderRpl(t.sms.text, SAMPLE, { linkMode: 'short', escape: false, shortLinkDomain: brand.shortLinkDomain });
    return (
      <div className="h-[150px] rounded-md bg-[#f2f2f7] p-2 flex items-end">
        <div className="bg-[#e5e5ea] rounded-2xl rounded-bl-md px-2.5 py-1.5 text-[10px] leading-snug line-clamp-6">{text}</div>
      </div>
    );
  }
  if (t.push) {
    const title = renderRpl(t.push.title, SAMPLE, { escape: false });
    const body = renderRpl(t.push.body, SAMPLE, { escape: false });
    return (
      <div className="h-[150px] rounded-md bg-gradient-to-b from-[#2b3a67] to-[#0f172a] p-2 flex items-center">
        <div className="w-full rounded-lg bg-white p-2 flex flex-wrap gap-2">
          {t.push.imageUrl && <ImageBox src={t.push.imageUrl} label={brand.name} className="w-full h-14 rounded" />}
          <div className="w-7 h-7 rounded bg-[#461bff] text-white text-[7px] font-bold flex items-center justify-center shrink-0 overflow-hidden">{brand.wordmark[0].slice(0, 5)}</div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold leading-tight line-clamp-2">{title}</div>
            <div className="text-[9px] text-gray-600 leading-tight line-clamp-2">{body}</div>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

