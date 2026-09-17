import { query } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import * as recordRepo from '../records/record.repo.js';
import * as providerRepo from './provider.repo.js';
import { assertWorkspaceProviderLaunchReady } from './provider.service.js';

export type CrmCompanySyncProvider = 'salesforce' | 'hubspot' | 'pipedrive';

type CompanyFields = {
  name: string;
  websiteUrl: string | null;
  email: string | null;
  phone: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  description: string | null;
};

type ProviderRequest = {
  provider: CrmCompanySyncProvider;
  method: 'POST' | 'PATCH' | 'PUT';
  url: string;
  body: Record<string, unknown>;
  externalObjectType: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, maxLength = 2_000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function firstText(source: Record<string, unknown>, keys: string[], maxLength = 2_000) {
  for (const key of keys) {
    const value = text(source[key], maxLength);
    if (value) return value;
  }
  return null;
}

/** Maps the canonical Lulu company record to provider-neutral business data. */
export function canonicalCompanyFields(record: Pick<recordRepo.WorkspaceRecord, 'name' | 'description' | 'data'>): CompanyFields {
  const data = objectValue(record.data);
  return {
    name: text(record.name, 255) || 'Unnamed company',
    websiteUrl: firstText(data, ['websiteUrl', 'website_url', 'website', 'url'], 2_000),
    email: firstText(data, ['email', 'emailAddress', 'email_address'], 320),
    phone: firstText(data, ['phone', 'phoneNumber', 'phone_number'], 120),
    industry: firstText(data, ['industry', 'sector', 'businessType'], 160),
    country: firstText(data, ['country', 'countryCode'], 120),
    city: firstText(data, ['city', 'locality'], 160),
    address: firstText(data, ['address', 'businessAddress', 'street'], 500),
    description: firstText(data, ['description', 'summary', 'notes'], 2_000) ?? (text(record.description, 2_000) || null),
  };
}

function salesforceBody(fields: CompanyFields) {
  return compactObject({
    Name: fields.name,
    Website: fields.websiteUrl,
    Phone: fields.phone,
    Industry: fields.industry,
    BillingCity: fields.city,
    BillingCountry: fields.country,
    BillingStreet: fields.address,
    Description: fields.description,
  });
}

function hubspotBody(fields: CompanyFields) {
  return {
    properties: compactObject({
      name: fields.name,
      domain: fields.websiteUrl ? normalizeDomain(fields.websiteUrl) : null,
      phone: fields.phone,
      industry: fields.industry,
      city: fields.city,
      country: fields.country,
      address: fields.address,
      description: fields.description,
    }),
  };
}

function pipedriveBody(fields: CompanyFields) {
  return compactObject({
    name: fields.name,
    website: fields.websiteUrl,
    phone: fields.phone,
    email: fields.email,
    industry: fields.industry,
    address: fields.address,
    address_locality: fields.city,
    address_country: fields.country,
    notes: fields.description,
  });
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

function normalizeDomain(value: string) {
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    return url.hostname;
  } catch {
    return value.replace(/^https?:\/\//i, '').split('/')[0] ?? value;
  }
}

function apiOrigin(provider: CrmCompanySyncProvider, settings: Record<string, unknown>) {
  if (provider === 'salesforce') {
    const instanceUrl = text(settings.instanceUrl, 500).replace(/\/$/, '');
    if (!/^https:\/\/(?:[a-z0-9-]+\.)+salesforce\.com$/i.test(instanceUrl)) {
      throw new AppError(409, 'CRM_CONFIGURATION_MISSING', 'Salesforce requires a valid HTTPS instance URL before company sync can run.');
    }
    return instanceUrl;
  }
  if (provider === 'pipedrive') {
    const apiDomain = text(settings.apiDomain, 500).replace(/\/$/, '');
    if (!/^https:\/\/(?:[a-z0-9-]+\.)?pipedrive\.com$/i.test(apiDomain)) {
      throw new AppError(409, 'CRM_CONFIGURATION_MISSING', 'Pipedrive requires a valid HTTPS API domain before company sync can run.');
    }
    return apiDomain;
  }
  return 'https://api.hubapi.com';
}

export function buildCompanyProviderRequest(input: {
  provider: CrmCompanySyncProvider;
  settings: Record<string, unknown>;
  fields: CompanyFields;
  externalObjectId?: string | null;
}): ProviderRequest {
  const origin = apiOrigin(input.provider, input.settings);
  if (input.provider === 'salesforce') {
    const path = `/services/data/v61.0/sobjects/Account${input.externalObjectId ? `/${encodeURIComponent(input.externalObjectId)}` : ''}`;
    return { provider: input.provider, method: input.externalObjectId ? 'PATCH' : 'POST', url: `${origin}${path}`, body: salesforceBody(input.fields), externalObjectType: 'Account' };
  }
  if (input.provider === 'pipedrive') {
    const path = `/api/v1/organizations${input.externalObjectId ? `/${encodeURIComponent(input.externalObjectId)}` : ''}`;
    return { provider: input.provider, method: input.externalObjectId ? 'PUT' : 'POST', url: `${origin}${path}`, body: pipedriveBody(input.fields), externalObjectType: 'organization' };
  }
  const path = `/crm/v3/objects/companies${input.externalObjectId ? `/${encodeURIComponent(input.externalObjectId)}` : ''}`;
  return { provider: input.provider, method: input.externalObjectId ? 'PATCH' : 'POST', url: `${origin}${path}`, body: hubspotBody(input.fields), externalObjectType: 'company' };
}

function extractExternalObjectId(provider: CrmCompanySyncProvider, body: Record<string, unknown>) {
  if (provider === 'pipedrive') return text(objectValue(body.data).id ?? body.id, 200);
  return text(body.id, 200);
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/(authorization|token|secret|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]').slice(0, 500);
}

async function accessToken(workspaceId: string, provider: CrmCompanySyncProvider) {
  const credential = await onboardingRepo.getPlatformOAuthCredential(workspaceId, provider);
  if (!credential) throw new AppError(409, 'CRM_CONNECTION_REQUIRED', `Connect ${provider} before synchronizing company records.`);
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
  if (expiresAt !== null && expiresAt <= Date.now() + 300_000) {
    return refreshStoredOAuthCredential({
      workspaceId,
      provider,
      encryptedRefreshToken: credential.encryptedRefreshToken,
    });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

async function settingsFor(workspaceId: string, provider: CrmCompanySyncProvider) {
  const { rows } = await query<{ settings: unknown }>(`SELECT settings FROM workspace_platforms WHERE workspace_id=$1 AND integration_key=$2 AND deleted_at IS NULL LIMIT 1`, [workspaceId, provider]);
  return objectValue(rows[0]?.settings);
}

async function providerAccount(workspaceId: string, connectionId: string, externalAccountId: string | null) {
  const { rows } = await query<{ id: string; externalAccountId: string }>(
    `SELECT a.id, a.external_account_id AS "externalAccountId"
       FROM provider_accounts a
       JOIN provider_connections c ON c.id=a.provider_connection_id
      WHERE a.provider_connection_id=$1
        AND (c.workspace_id=$2 OR EXISTS (
          SELECT 1 FROM provider_connection_workspace_access access
           WHERE access.provider_connection_id=c.id AND access.workspace_id=$2 AND access.access_status='ACTIVE'
        ))
      ORDER BY CASE WHEN a.external_account_id=$3 THEN 0 ELSE 1 END, a.created_at
      LIMIT 1`,
    [connectionId, workspaceId, externalAccountId],
  );
  return rows[0] ?? null;
}

async function existingMapping(workspaceId: string, providerAccountId: string, companyId: string) {
  const { rows } = await query<{ externalObjectId: string; externalObjectType: string }>(
    `SELECT external_object_id AS "externalObjectId", external_object_type AS "externalObjectType"
       FROM provider_object_mappings
      WHERE workspace_id=$1 AND provider_account_id=$2 AND lulu_object_type='crm_companies' AND lulu_object_id=$3
      LIMIT 1`,
    [workspaceId, providerAccountId, companyId],
  );
  return rows[0] ?? null;
}

async function providerRequest(token: string, request: ProviderRequest) {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError(502, 'CRM_NETWORK_ERROR', 'The CRM provider did not return a definitive response.', { cause: errorMessage(error) });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new AppError(response.status === 401 || response.status === 403 ? 401 : 502, response.status === 401 || response.status === 403 ? 'CRM_REAUTH_REQUIRED' : 'CRM_WRITE_FAILED', 'The CRM provider rejected the company update.', { providerHttpStatus: response.status });
  return body;
}

/** Synchronizes one canonical Lulu company to a verified CRM provider. */
export async function syncCrmCompany(input: {
  workspaceId: string;
  companyId: string;
  provider: CrmCompanySyncProvider;
  providerConnectionId?: string | null;
}) {
  const company = await recordRepo.findRecord(input.workspaceId, 'crm_companies', input.companyId);
  if (!company) throw new AppError(404, 'CRM_COMPANY_NOT_FOUND', 'The canonical Lulu company could not be found.');

  const ready = await assertWorkspaceProviderLaunchReady(input.workspaceId, input.provider, 'CRM company synchronization requires a verified provider connection.');
  if (ready.providerKey !== input.provider) throw new AppError(409, 'CRM_PROVIDER_MISMATCH', 'The verified CRM connection does not match the requested provider.');
  if (input.providerConnectionId && ready.connectionId !== input.providerConnectionId) throw new AppError(409, 'CRM_PROVIDER_NOT_READY', 'The requested CRM connection is not the verified launch-ready connection.');

  const connection = await providerRepo.getProviderConnectionInternal(ready.connectionId);
  if (!connection) throw new AppError(409, 'CRM_CONNECTION_REQUIRED', 'The CRM provider connection is no longer available.');
  const account = await providerAccount(input.workspaceId, ready.connectionId, connection.externalAccountId == null ? null : String(connection.externalAccountId));
  if (!account) throw new AppError(409, 'CRM_PROVIDER_ACCOUNT_REQUIRED', 'Run the CRM provider discovery sync before writing company records.');
  const mapping = await existingMapping(input.workspaceId, account.id, input.companyId);
  const fields = canonicalCompanyFields(company);
  const request = buildCompanyProviderRequest({ provider: input.provider, settings: await settingsFor(input.workspaceId, input.provider), fields, externalObjectId: mapping?.externalObjectId ?? null });
  const operationKey = `crm-company-sync:${input.companyId}:${input.provider}:${company.version}`;
  const claim = await providerRepo.claimProviderOperation({ workspaceId: input.workspaceId, providerConnectionId: ready.connectionId, operationKey, operationType: 'crm.company.sync' });
  if (!claim.created && claim.operation.status === 'SUCCEEDED') return { status: 'reused' as const, provider: input.provider, companyId: input.companyId, externalObjectId: claim.operation.resultReference };

  try {
    const token = await accessToken(input.workspaceId, input.provider);
    const body = await providerRequest(token, request);
    const externalObjectId = mapping?.externalObjectId ?? extractExternalObjectId(input.provider, body);
    if (!externalObjectId) throw new AppError(502, 'CRM_WRITE_RESPONSE_INVALID', 'The CRM provider did not return an external company identifier.');
    const storedMapping = await providerRepo.upsertObjectMapping({
      workspaceId: input.workspaceId,
      providerConnectionId: ready.connectionId,
      providerAccountId: account.id,
      luluObjectType: 'crm_companies',
      luluObjectId: input.companyId,
      externalObjectType: request.externalObjectType,
      externalObjectId,
      sourceOfTruth: 'LULU_TO_PROVIDER',
      syncStatus: 'SUCCESS',
      metadata: { provider: input.provider, operationKey },
    });
    await providerRepo.completeProviderOperation({ workspaceId: input.workspaceId, providerConnectionId: ready.connectionId, operationKey, status: 'SUCCEEDED', resultReference: externalObjectId });
    return { status: mapping ? 'updated' as const : 'created' as const, provider: input.provider, companyId: input.companyId, externalObjectId, mappingId: storedMapping ? String(storedMapping.id) : null };
  } catch (error) {
    await providerRepo.completeProviderOperation({ workspaceId: input.workspaceId, providerConnectionId: ready.connectionId, operationKey, status: 'FAILED', lastError: errorMessage(error) }).catch(() => undefined);
    throw error;
  }
}
