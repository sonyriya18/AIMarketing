import type { UseQueryResult } from '@tanstack/react-query';
import type { Selection } from '../app/selection';
import type { Account, Dataset, OverviewResult, Session } from '../lib/types';

export interface PageProps {
  session: Session;
  account: Account;
  dataset: Dataset | null;
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  overview: UseQueryResult<OverviewResult>;
  perms: Set<string>;
}
