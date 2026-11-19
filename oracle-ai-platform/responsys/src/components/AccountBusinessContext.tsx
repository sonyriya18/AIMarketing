import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Account } from '../lib/types';
import { apiSend } from '../lib/api';
import { Button, ErrorBox, TextInput } from './ui';
import { businessWebsite, defaultBusinessWebsite } from '../../shared/business/accounts';

export function AccountBusinessContext({ accounts, account, canManage, onSelect, onAdd, hideSelection = false }: {
  accounts: Account[]; account: Account; canManage: boolean; onSelect: (id: string) => void; onAdd: () => void;
  hideSelection?: boolean;
}) {
  const qc = useQueryClient();
  const [website, setWebsite] = useState(businessWebsite(account) || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const saved = await apiSend<Account>('PATCH', `/accounts/${account.id}`, { brand: { ...account.brand, officialWebsite: website.trim() } });
      qc.setQueryData<Account[]>(['accounts'], (items) => items?.map((item) => item.id === saved.id ? saved : item));
      await qc.invalidateQueries({ queryKey: ['summary'] });
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return <section className="rounded-2xl border border-[#e8dcc9] bg-white p-4 space-y-3" aria-label="Account and business context">
    {!hideSelection && <div className="flex flex-wrap items-end gap-3">
      <label className="flex-1 min-w-48 text-xs font-semibold text-gray-700">Account
        <select aria-label="Account" className="block w-full mt-1 rounded-lg border border-gray-300 bg-white p-2 text-sm" value={account.id} onChange={(e) => onSelect(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      {canManage && <Button onClick={onAdd}>Add account</Button>}
      <p className="flex-1 min-w-48 text-xs text-gray-500">Choose the business to assess. Recommendations use this account’s data and official website.</p>
    </div>}
    {!account.brand.officialWebsite && defaultBusinessWebsite(account.name) && <p className="text-xs text-indigo-800">Using the configured official website for {account.name}. Save it below or enter a different official website.</p>}
    {canManage ? <form onSubmit={save} className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-56"><TextInput type="url" label="Official business website" placeholder="https://www.amildental.com.br/" value={website} onChange={(e) => setWebsite(e.target.value)} hint="Reads the homepage and up to two business or product pages. Some websites may block access." /></div>
      <Button type="submit" busy={busy} disabled={website.trim() === (account.brand.officialWebsite || '')}>Save website</Button>
    </form> : <p className="text-xs text-gray-600">Official website: {businessWebsite(account) ? <a className="underline" href={businessWebsite(account)} target="_blank" rel="noreferrer">{businessWebsite(account)}</a> : 'Ask a workspace owner to add the official website.'}</p>}
    {error ? <ErrorBox error={error} /> : null}
  </section>;
}
