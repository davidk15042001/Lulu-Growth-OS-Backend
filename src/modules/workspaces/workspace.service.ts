import crypto from 'node:crypto';
import { conflictError, notFoundError } from '../../utils/app-error.js';
import * as repo from './workspace.repo.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspace.validator.js';

function slugify(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export async function createWorkspace(userId: string, input: CreateWorkspaceInput) {
  const baseSlug = input.slug ?? (slugify(input.companyName) || 'workspace');
  const slug = input.slug ?? `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;

  try {
    return await repo.createWorkspace(userId, input, slug);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflictError('This workspace slug is already in use');
    }
    throw error;
  }
}

export function listWorkspaces(userId: string) {
  return repo.listWorkspacesForUser(userId);
}

export async function getWorkspace(workspaceId: string, userId: string) {
  const workspace = await repo.findWorkspaceForUser(workspaceId, userId);
  if (!workspace) throw notFoundError('Workspace not found');
  return workspace;
}

export async function updateWorkspace(
  workspaceId: string,
  userId: string,
  input: UpdateWorkspaceInput
) {
  try {
    const workspace = await repo.updateWorkspace(workspaceId, userId, input);
    if (!workspace) throw notFoundError('Workspace not found');
    return workspace;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflictError('This workspace slug is already in use');
    }
    throw error;
  }
}
