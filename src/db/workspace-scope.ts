/**
 * Repository contract for workspace-owned entities.
 *
 * New repositories should carry workspaceId through every read/write/delete
 * method. Loading by an unscoped UUID and checking ownership afterwards is not
 * an acceptable default for autonomous workflows.
 */
export type WorkspaceScopedRepository<T, CreateInput = unknown, UpdateInput = unknown> = {
  getById: (workspaceId: string, id: string) => Promise<T | undefined>;
  create: (workspaceId: string, input: CreateInput) => Promise<T>;
  update: (workspaceId: string, id: string, input: UpdateInput) => Promise<T | undefined>;
  delete: (workspaceId: string, id: string) => Promise<boolean>;
};

export function assertWorkspaceScope(workspaceId: string) {
  if (!/^[a-f\d-]{36}$/i.test(workspaceId)) throw new Error('A valid workspaceId is required for tenant-owned data');
  return workspaceId;
}
