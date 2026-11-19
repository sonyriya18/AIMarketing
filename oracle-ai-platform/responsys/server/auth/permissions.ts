/**
 * Authorization matrix (blueprint 16.2). Enforced server-side on every route; the UI only
 * mirrors it. External side effects (`action.execute`) always require an explicit grant.
 */
export const ROLES = ['viewer', 'analyst', 'marketer', 'approver', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'report.view',
  'data.import',
  'scenario.create',
  'draft.edit',
  'approval.decide',
  'action.execute',
  'ai.use',
  'workspace.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const BY_ROLE: Record<Role, Permission[]> = {
  viewer: ['report.view'],
  analyst: ['report.view', 'data.import', 'scenario.create', 'ai.use'],
  marketer: ['report.view', 'scenario.create', 'draft.edit', 'ai.use'],
  approver: ['report.view', 'approval.decide'],
  owner: ['report.view', 'data.import', 'scenario.create', 'draft.edit', 'approval.decide', 'ai.use', 'workspace.manage'],
};

/** Permissions a role may receive through an explicit grant. */
export const GRANTABLE: Record<Role, Permission[]> = {
  viewer: [],
  analyst: ['draft.edit'],
  marketer: ['data.import', 'action.execute'],
  approver: ['scenario.create', 'draft.edit', 'action.execute'],
  owner: ['action.execute'],
};

export function permissionsFor(role: Role, grants: readonly string[] = []): Set<Permission> {
  const out = new Set<Permission>(BY_ROLE[role]);
  for (const g of grants) {
    if ((GRANTABLE[role] as string[]).includes(g)) out.add(g as Permission);
  }
  return out;
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
