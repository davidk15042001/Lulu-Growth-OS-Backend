import crypto from 'node:crypto';
import { deleteObject, putObject, workspaceLogoKey } from '../../storage/s3.service.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import { conflictError, notFoundError } from '../../utils/app-error.js';
import * as repo from './workspace.repo.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceProfileUpdateInput } from './workspace.validator.js';

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

export async function getWorkspaceProfile(workspaceId: string, userId: string) {
  const profile = await repo.findWorkspaceProfileForAdmin(workspaceId, userId);
  if (!profile) throw notFoundError('Workspace profile not found');
  return profile;
}

export async function updateWorkspaceProfile(
  workspaceId: string,
  userId: string,
  input: WorkspaceProfileUpdateInput,
) {
  const profile = await repo.updateWorkspaceProfile(workspaceId, userId, input);
  if (!profile) throw notFoundError('Workspace profile not found');
  return profile;
}

const logoMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const logoExtensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export async function uploadWorkspaceLogo(
  workspaceId: string,
  userId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
) {
  if (!file.buffer?.byteLength) throw new AppError(422, 'WORKSPACE_LOGO_EMPTY', 'A logo file is required');
  const mimeType = file.mimetype.toLowerCase();
  if (!logoMimeTypes.has(mimeType)) throw new AppError(415, 'WORKSPACE_LOGO_TYPE_UNSUPPORTED', 'Use a PNG, JPEG or WebP image for the company logo');
  if (file.buffer.byteLength > 5 * 1024 * 1024) throw new AppError(413, 'WORKSPACE_LOGO_TOO_LARGE', 'The company logo must be 5 MB or smaller');
  const previous = await repo.findWorkspaceLogo(workspaceId);
  const storageReference = workspaceLogoKey(workspaceId, crypto.randomUUID(), logoExtensions[mimeType]!);
  await putObject({ key: storageReference, content: file.buffer, mimeType, fileName: file.originalname.slice(0, 200) || `company-logo.${logoExtensions[mimeType]}` });
  try {
    const updated = await repo.updateWorkspaceLogo(workspaceId, userId, { storageReference, mimeType, fileName: file.originalname.slice(0, 200) || `company-logo.${logoExtensions[mimeType]}` });
    if (!updated) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
    if (previous?.storageReference && previous.storageReference !== storageReference) {
      await deleteObject(previous.storageReference).catch((error: unknown) => logger.warn({ error, workspaceId }, 'Previous workspace logo could not be deleted'));
    }
    return { logoUrl: repo.workspaceLogoUrl(workspaceId), logoMimeType: mimeType, logoFileName: updated.fileName };
  } catch (error) {
    await deleteObject(storageReference).catch((cleanupError: unknown) => logger.warn({ error: cleanupError, workspaceId }, 'Failed to clean up uncommitted workspace logo'));
    throw error;
  }
}

export async function deleteWorkspaceLogo(workspaceId: string, userId: string) {
  const previous = await repo.clearWorkspaceLogo(workspaceId, userId);
  if (!previous) throw notFoundError('Workspace logo not found');
  if (previous.storageReference) await deleteObject(previous.storageReference).catch((error: unknown) => logger.warn({ error, workspaceId }, 'Workspace logo could not be deleted from storage'));
  return { logoUrl: null };
}

export function getWorkspaceLogo(workspaceId: string) {
  return repo.findWorkspaceLogo(workspaceId);
}
