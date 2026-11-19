import React, { useState } from 'react';
import amilLogo from '../assets/amil-dental.png';
import { businessWebsite, configuredBusiness } from '../../shared/business/accounts';
import type { Account } from '../lib/types';

export function AccountLogo({ account, onClick }: { account: Account; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  const known = configuredBusiness(account.name);
  const website = businessWebsite(account);
  const src = known?.key === 'amil_dental' ? amilLogo : website ? new URL('/favicon.ico', website).href : null;
  return <button type="button" onClick={onClick} disabled={!onClick} aria-label={onClick ? `Change account (${account.name})` : account.name} title={onClick ? `${account.name} · Change account` : account.name} className="shrink-0 flex items-center justify-center overflow-hidden rounded-lg bg-white px-2.5 py-1 min-w-20 h-10 border border-white/20 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" data-testid="account-brand" data-account-id={account.id}>
    {src && !failed ? <img src={src} alt={`${account.name} logo`} onError={() => setFailed(true)} referrerPolicy="no-referrer" className={known?.key === 'amil_dental' ? 'h-8 w-20 scale-[1.6] object-contain' : 'h-7 w-7 object-contain'} /> : <span className="max-w-36 truncate text-xs font-bold text-gray-800">{account.name}</span>}
    {known?.key !== 'amil_dental' && src && !failed && <span className="ml-2 hidden xl:block max-w-36 truncate text-xs font-semibold text-gray-800">{account.name}</span>}
  </button>;
}
