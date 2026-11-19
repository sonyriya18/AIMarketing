/**
 * New campaign: the campaign drafts workspace (list, versions, approvals) and the builder,
 * opened from the AI Simulator. Drafts are saved only after the server confirms; nothing is sent.
 */
import React from 'react';
import { Rocket, X } from 'lucide-react';
import type { Account, Session } from '../lib/types';
import type { BuilderInput } from './CampaignBuilder';
import { DraftsPanel } from '../features/drafts/DraftsPage';

export const NewCampaignModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  account: Account;
  session: Session;
  perms: Set<string>;
  initial: Omit<BuilderInput, 'account'> | null;
}> = ({ isOpen, onClose, account, session, perms, initial }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" role="dialog" aria-modal="true" aria-label="Campaign drafts">
      <div className="w-full max-w-6xl rounded-2xl bg-[#F4F5F7] shadow-2xl my-6">
        <div className="flex items-center justify-between rounded-t-2xl bg-[#2d241d] text-white px-5 py-3">
          <div className="flex items-center gap-2">
            <Rocket className="w-4 h-4 text-[#f0a08f]" />
            <h2 className="text-sm font-bold">Create &amp; manage campaigns</h2>
            <span className="text-[10px] text-[#d9c6b4]">Drafts only — sending needs approval and verified Responsys access</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/15" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5">
          <DraftsPanel account={account} perms={perms} session={session} initialBuilder={initial} />
        </div>
      </div>
    </div>
  );
};
