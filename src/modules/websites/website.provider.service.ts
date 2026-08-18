import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { getPlatformOAuthCredential, markPlatformConnectionError } from '../onboarding/onboarding.repo.js';
import type { WebsiteProvider } from './website.types.js';

type ProviderResponse = { status: number; data: any };

async function providerRequest(provider: WebsiteProvider, url: string, token: string, init: RequestInit = {}): Promise<ProviderResponse> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new AppError(502, response.status === 401 || response.status === 403 ? 'WEBSITE_PROVIDER_WRITE_SCOPE_MISSING' : 'WEBSITE_PROVIDER_REQUEST_FAILED', `The ${provider} provider rejected the website request`, { providerHttpStatus: response.status, providerCode: data?.code, providerMessage: data?.message });
  return { status: response.status, data };
}

async function tokenFor(workspaceId: string, provider: 'wordpress' | 'webflow') {
  const credential = await getPlatformOAuthCredential(workspaceId, provider);
  if (!credential) throw new AppError(409, 'WEBSITE_PROVIDER_NOT_CONNECTED', `The ${provider} provider is not connected`);
  try { return decryptSecret(credential.encryptedAccessToken); } catch { throw new AppError(500, 'WEBSITE_PROVIDER_TOKEN_INVALID', `The ${provider} provider token could not be decrypted`); }
}

export async function wordpressSites(workspaceId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  return (await providerRequest('wordpress', 'https://public-api.wordpress.com/rest/v1.1/me/sites/', token)).data;
}
export async function createWordpressPage(workspaceId: string, siteId: string, page: { title: string; content: string; status?: 'draft' | 'publish' }) {
  const token = await tokenFor(workspaceId, 'wordpress');
  return (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/pages/new/`, token, { method: 'POST', body: JSON.stringify({ title: page.title, content: page.content, status: page.status ?? 'draft' }) })).data;
}
export async function publishWordpressPage(workspaceId: string, siteId: string, pageId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  return (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}/`, token, { method: 'POST', body: JSON.stringify({ status: 'publish' }) })).data;
}
export async function webflowSites(workspaceId: string) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', 'https://api.webflow.com/v2/sites', token)).data;
}
export async function webflowCollections(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/sites/${encodeURIComponent(siteId)}/collections`, token)).data;
}
export async function createWebflowItem(workspaceId: string, collectionId: string, fieldData: Record<string, unknown>, isDraft = true) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/collections/${encodeURIComponent(collectionId)}/items`, token, { method: 'POST', body: JSON.stringify({ isDraft, fieldData }) })).data;
}
export async function publishWebflowSite(workspaceId: string, siteId: string, customDomains: string[] = []) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/sites/${encodeURIComponent(siteId)}/publish`, token, { method: 'POST', body: JSON.stringify({ publishToWebflowSubdomain: true, customDomains }) })).data;
}

export async function withProviderConnectionError<T>(workspaceId: string, provider: 'wordpress' | 'webflow', action: () => Promise<T>) {
  try { return await action(); } catch (error) {
    if (error instanceof AppError) await markPlatformConnectionError(workspaceId, provider, error.message).catch(() => undefined);
    throw error;
  }
}
