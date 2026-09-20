import crypto from 'node:crypto';
import { deleteObject, putObject, workspaceLogoKey } from '../../storage/s3.service.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import { conflictError, notFoundError } from '../../utils/app-error.js';
import * as repo from './workspace.repo.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceProfileUpdateInput } from './workspace.validator.js';

const countries = [
  'China', 'Germany', 'United States', 'United Kingdom', 'France', 'Netherlands',
  'Austria', 'Switzerland', 'Singapore', 'Hong Kong', 'Other',
] as const;

const legalFormsByCountry: Record<string, readonly string[]> = {
  China: ['Limited liability company', 'Joint stock company', 'Partnership', 'Sole proprietorship', 'Foreign-invested enterprise', 'Other'],
  Germany: ['GmbH', 'UG', 'AG', 'e.K.', 'GbR', 'OHG', 'KG', 'Other'],
  'United States': ['LLC', 'Corporation', 'S Corporation', 'Partnership', 'Sole proprietorship', 'Nonprofit', 'Other'],
  'United Kingdom': ['Limited company', 'PLC', 'LLP', 'Partnership', 'Sole trader', 'Other'],
  France: ['SARL', 'SAS', 'SA', 'EURL', 'Entreprise individuelle', 'Other'],
  Netherlands: ['BV', 'NV', 'VOF', 'Eenmanszaak', 'Stichting', 'Other'],
  Austria: ['GmbH', 'AG', 'OG', 'KG', 'Einzelunternehmen', 'Other'],
  Switzerland: ['GmbH', 'AG', 'Kollektivgesellschaft', 'Einzelunternehmen', 'Other'],
  Singapore: ['Private limited company', 'Public company', 'LLP', 'Sole proprietorship', 'Other'],
  'Hong Kong': ['Private company limited by shares', 'Public company', 'Partnership', 'Sole proprietorship', 'Other'],
  Other: ['Limited company', 'Corporation', 'Partnership', 'Sole proprietorship', 'Nonprofit', 'Other'],
};

function normalizedCountry(value: string | null | undefined) {
  const text = value?.trim();
  return countries.find((country) => country.toLowerCase() === text?.toLowerCase()) ?? null;
}

function validateWorkspaceProfileInput(input: WorkspaceProfileUpdateInput) {
  const fieldErrors: Record<string, string> = {};
  const country = normalizedCountry(input.countryRegion ?? undefined);
  if (input.countryRegion !== undefined && input.countryRegion !== null && !country) {
    fieldErrors.countryRegion = 'Select a supported country or region.';
  }
  const legalForms = legalFormsByCountry[country ?? 'Other'] ?? legalFormsByCountry.Other!;
  if (input.legalForm !== undefined && input.legalForm !== null && !legalForms.some((item) => item.toLowerCase() === input.legalForm!.toLowerCase())) {
    fieldErrors.legalForm = 'Select a legal form supported for the selected country.';
  }
  if (input.taxId !== undefined && input.taxId !== null && country) {
    const tax = input.taxId.trim();
    const valid = country === 'United States' ? /^\d{2}-?\d{7}$/.test(tax)
      : country === 'Germany' ? /^(?:DE)?\d{9,13}$/.test(tax)
      : country === 'China' ? /^[0-9A-Z]{15,20}$/.test(tax)
      : country === 'United Kingdom' ? /^[0-9A-Z]{8,12}$/.test(tax)
      : tax.length >= 4 && tax.length <= 40;
    if (!valid) fieldErrors.taxId = 'Enter a tax ID that matches the selected country.';
  }
  if (input.bankAccountNumber !== undefined && input.bankAccountNumber !== null && country) {
    const account = input.bankAccountNumber.replace(/\s+/g, '');
    const valid = country === 'Germany' ? /^DE\d{20}$/i.test(account) || /^\d{6,18}$/.test(account)
      : country === 'United States' ? /^\d{4,17}$/.test(account)
      : country === 'China' ? /^\d{8,30}$/.test(account)
      : /^[A-Z0-9-]{4,34}$/i.test(account);
    if (!valid) fieldErrors.bankAccountNumber = 'Enter a valid bank account number for the selected country.';
  }
  if (input.bankCode !== undefined && input.bankCode !== null && country) {
    const code = input.bankCode.replace(/\s+/g, '');
    const valid = country === 'United States' ? /^\d{9}$/.test(code)
      : country === 'Germany' ? /^\d{8}$/.test(code) || /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(code)
      : country === 'China' ? /^\d{12}$/.test(code) || /^[A-Z]{4}CN[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(code)
      : /^[A-Z0-9]{4,12}$/i.test(code);
    if (!valid) fieldErrors.bankCode = 'Enter a valid bank code for the selected country.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError(422, 'WORKSPACE_PROFILE_INVALID', 'Please correct the highlighted profile fields.', { fields: fieldErrors });
  }
}

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
  validateWorkspaceProfileInput(input);
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
    return { logoUrl: repo.workspaceLogoUrl(workspaceId, updated.updatedAt ?? new Date().toISOString()), logoMimeType: mimeType, logoFileName: updated.fileName };
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
