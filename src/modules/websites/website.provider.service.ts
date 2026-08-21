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
  return (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/new/`, token, { method: 'POST', body: JSON.stringify({ type: 'page', title: page.title, content: page.content, status: page.status ?? 'draft' }) })).data;
}
export async function publishWordpressPage(workspaceId: string, siteId: string, pageId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  return (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/${encodeURIComponent(pageId)}/`, token, { method: 'POST', body: JSON.stringify({ status: 'publish' }) })).data;
}
export async function webflowSites(workspaceId: string) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', 'https://api.webflow.com/v2/sites', token)).data;
}

export async function firstWordpressSite(workspaceId: string) {
  const data = await wordpressSites(workspaceId);
  const sites = Array.isArray(data) ? data : Array.isArray(data?.sites) ? data.sites : [];
  const site = sites[0] as Record<string, unknown> | undefined;
  if (!site) throw new AppError(409, 'WEBSITE_PROVIDER_NO_SITE_AVAILABLE', 'No WordPress site is available in the connected account');
  return { id: String(site.ID ?? site.id ?? ''), name: String(site.name ?? site.URL ?? 'WordPress site'), url: site.URL ? String(site.URL) : undefined };
}

export async function firstWebflowSiteWithCollection(workspaceId: string) {
  const data = await webflowSites(workspaceId);
  const sites = Array.isArray(data) ? data : Array.isArray(data?.sites) ? data.sites : [];
  const site = sites[0] as Record<string, unknown> | undefined;
  if (!site) throw new AppError(409, 'WEBSITE_PROVIDER_NO_SITE_AVAILABLE', 'No Webflow site is available in the connected account');
  const siteId = String(site.id ?? site._id ?? '');
  const collectionsData = await webflowCollections(workspaceId, siteId);
  const collections = Array.isArray(collectionsData) ? collectionsData : Array.isArray(collectionsData?.collections) ? collectionsData.collections : [];
  const collection = collections[0] as Record<string, unknown> | undefined;
  if (!collection) throw new AppError(409, 'WEBSITE_PROVIDER_COLLECTION_REQUIRED', 'The connected Webflow site has no CMS collection available for generated pages');
  return { id: siteId, name: String(site.displayName ?? site.name ?? 'Webflow site'), url: site.previewUrl ? String(site.previewUrl) : undefined, collectionId: String(collection.id ?? collection._id ?? '') };
}
export async function webflowCollections(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/sites/${encodeURIComponent(siteId)}/collections`, token)).data;
}
export async function createWebflowItem(workspaceId: string, collectionId: string, fieldData: Record<string, unknown>, isDraft = true) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/collections/${encodeURIComponent(collectionId)}/items/bulk`, token, { method: 'POST', body: JSON.stringify({ isDraft, fieldData }) })).data;
}
export async function webflowCustomDomains(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/sites/${encodeURIComponent(siteId)}/custom_domains`, token)).data;
}
export async function publishWebflowSite(workspaceId: string, siteId: string, customDomainIds: string[] = []) {
  const token = await tokenFor(workspaceId, 'webflow');
  return (await providerRequest('webflow', `https://api.webflow.com/v2/sites/${encodeURIComponent(siteId)}/publish`, token, { method: 'POST', body: JSON.stringify({ publishToWebflowSubdomain: customDomainIds.length === 0, ...(customDomainIds.length ? { customDomains: customDomainIds } : {}) }) })).data;
}

export async function withProviderConnectionError<T>(workspaceId: string, provider: 'wordpress' | 'webflow', action: () => Promise<T>) {
  try { return await action(); } catch (error) {
    if (error instanceof AppError) await markPlatformConnectionError(workspaceId, provider, error.message).catch(() => undefined);
    throw error;
  }
}
