/**
 * Live updates: authenticated Server-Sent Events with replay, falling back to polling the same
 * durable events. Queries are invalidated only after the server has committed a revision.
 * Connection state here is the browser↔API link only — not integration health or data freshness.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from './api';
import { invalidateAccountData, qk } from './queries';

export type LinkState = 'connecting' | 'live' | 'polling' | 'offline';

interface LiveEvent {
  id: string;
  type: string;
  accountId: string | null;
  resourceId: string | null;
  revision: string | null;
  payload: Record<string, unknown>;
}

export function useLiveEvents(accountId: string | null, transport: 'sse' | 'poll' = 'sse', onEvent?: (e: LiveEvent) => void): LinkState {
  const qc = useQueryClient();
  const [state, setState] = useState<LinkState>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!accountId) return;
    let closed = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cursor: string | null = null;
    let failures = 0;

    const apply = (e: LiveEvent) => {
      cursor = e.id;
      handler.current?.(e);
      if (e.type === 'dataset.activated' || (e.type === 'import.progress' && e.payload?.status === 'completed') || (e.type === 'sync.status' && e.payload?.state === 'completed')) {
        invalidateAccountData(qc, accountId);
      } else if (e.type === 'import.progress') {
        void qc.invalidateQueries({ queryKey: qk.imports(accountId) });
      } else if (e.type === 'connection.health' || e.type === 'sync.status') {
        void qc.invalidateQueries({ queryKey: qk.connections(accountId) });
        void qc.invalidateQueries({ queryKey: qk.connect(accountId) });
      } else if (e.type === 'draft.updated' || e.type === 'approval.updated' || e.type === 'operation.updated') {
        void qc.invalidateQueries({ queryKey: qk.drafts(accountId) });
        void qc.invalidateQueries({ queryKey: qk.approvals(accountId) });
        if (e.resourceId) void qc.invalidateQueries({ queryKey: ['draft'] });
      }
    };

    const poll = async () => {
      if (closed) return;
      if (document.visibilityState === 'hidden') {
        pollTimer = setTimeout(poll, 15_000);
        return;
      }
      try {
        const out = await apiGet<{ events: LiveEvent[]; cursor: string }>(`/events?accountId=${accountId}${cursor ? `&after=${cursor}` : ''}`);
        out.events.forEach(apply);
        cursor = out.cursor;
        failures = 0;
        setState('polling');
      } catch {
        failures++;
        setState('offline');
      }
      const base = transport === 'poll' ? 5000 : 3000;
      pollTimer = setTimeout(poll, Math.min(30_000, base * 2 ** Math.min(failures, 4)));
    };

    const connect = () => {
      if (closed) return;
      if (transport === 'poll' || typeof EventSource === 'undefined') return void poll();
      es = new EventSource(`/api/v1/events/stream?accountId=${accountId}${cursor ? `&after=${cursor}` : ''}`, { withCredentials: true });
      es.onopen = () => {
        failures = 0;
        setState('live');
      };
      const types = ['import.progress', 'dataset.activated', 'report.ready', 'sync.status', 'connection.health', 'draft.updated', 'approval.updated', 'operation.updated'];
      for (const t of types) es.addEventListener(t, (m) => apply(JSON.parse((m as MessageEvent).data)));
      es.addEventListener('session.ended', () => {
        es?.close();
        void qc.invalidateQueries({ queryKey: qk.session });
      });
      es.onerror = () => {
        failures++;
        if (failures >= 3) {
          es?.close();
          es = null;
          void poll();
        } else setState('connecting');
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [accountId, transport, qc]);

  return state;
}
