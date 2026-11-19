/**
 * Registry of durable job handlers. Both the standalone worker and the optional in-process
 * worker (development) use the same handlers.
 */
import type { ObjectStorage } from '../integrations/storage/storage';
import type { JobHandler } from './queue';
import { importCommitHandler } from '../modules/imports/service';

export interface HandlerDeps {
  storage: ObjectStorage;
  extra?: Record<string, JobHandler>;
}

export function buildHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  return {
    'import.commit': importCommitHandler(deps.storage),
    ...(deps.extra ?? {}),
  };
}
