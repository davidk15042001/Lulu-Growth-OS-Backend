import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { getPlatformOAuthCredential, markPlatformConnectionError } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import type { WebsiteProvider } from './website.types.js';

type ProviderResponse = { status: number; data: any };

async function providerRequest(provider: WebsiteProvider, url: string, token: string, init: RequestInit = {}): Promise<ProviderResponse> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(45_000) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /timed?\s*out/i.test(error.message));
      if (timedOut && attempt < 2) continue;
      throw new AppError(504, timedOut ? 'WEBSITE_PROVIDER_TIMEOUT' : 'WEBSITE_PROVIDER_NETWORK_ERROR', timedOut ? `The ${provider} provider request timed out` : `The ${provider} provider could not be reached`, { provider });
    }
    const text = await response.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
    const providerMessage = String(data?.message ?? data?.error ?? data?.raw ?? '');
    const rateLimited = response.status === 429 || /too many attempts|rate.?limit|rate limit/i.test(providerMessage);

    if (response.ok) return { status: response.status, data };
    if (rateLimited && attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15000) : 2000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (rateLimited) {
      throw new AppError(429, 'WEBSITE_PROVIDER_RATE_LIMITED', `The ${provider} provider is temporarily rate limiting website requests`, {
        providerHttpStatus: response.status,
        providerCode: data?.code,
        providerMessage,
        retryAfterSeconds: response.headers.get('retry-after'),
      });
    }
    throw new AppError(502, response.status === 401 || response.status === 403 ? 'WEBSITE_PROVIDER_WRITE_SCOPE_MISSING' : 'WEBSITE_PROVIDER_REQUEST_FAILED', `The ${provider} provider rejected the website request`, { providerHttpStatus: response.status, providerCode: data?.code, providerMessage });
  }
  throw new AppError(429, 'WEBSITE_PROVIDER_RATE_LIMITED', `The ${provider} provider is temporarily rate limiting website requests`);
}

async function tokenFor(workspaceId: string, provider: 'wordpress' | 'webflow') {
  const credential = await getPlatformOAuthCredential(workspaceId, provider);
  if (!credential) throw new AppError(409, 'WEBSITE_PROVIDER_NOT_CONNECTED', `The ${provider} provider is not connected`);
  const expiresAt = credential.tokenExpiresAt ? new Date(credential.tokenExpiresAt).getTime() : null;
  const refreshWindowMs = 60_000;
  if (expiresAt && Number.isFinite(expiresAt) && expiresAt <= Date.now() + refreshWindowMs) {
    try {
      return await refreshStoredOAuthCredential({
        workspaceId,
        provider,
        encryptedRefreshToken: credential.encryptedRefreshToken,
      });
    } catch (error) {
      await markPlatformConnectionError(workspaceId, provider, error instanceof Error ? error.message : 'Provider connection expired').catch(() => undefined);
      throw new AppError(401, 'WEBSITE_PROVIDER_REAUTH_REQUIRED', `The ${provider} provider connection expired. Please reconnect it.`, { provider });
    }
  }
  try { return decryptSecret(credential.encryptedAccessToken); } catch { throw new AppError(500, 'WEBSITE_PROVIDER_TOKEN_INVALID', `The ${provider} provider token could not be decrypted`); }
}

export async function wordpressSites(workspaceId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  return (await providerRequest('wordpress', 'https://public-api.wordpress.com/rest/v1.1/me/sites/', token)).data;
}
export async function wordpressSiteDetails(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const fields = 'ID,URL,name,plan,capabilities,user_can_manage,jetpack,is_wpcom_atomic,is_fse_active,is_fse_eligible,is_core_site_editor_enabled,options';
  const options = 'theme_slug,stylesheet,template,show_on_front,page_on_front';
  return (await providerRequest(
    'wordpress',
    `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/?fields=${encodeURIComponent(fields)}&options=${encodeURIComponent(options)}`,
    token,
    { signal: AbortSignal.timeout(12_000) },
  )).data;
}
export async function wordpressPages(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const data = (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/?type=page&number=100&status=any`, token)).data;
  return Array.isArray(data) ? data : Array.isArray(data?.posts) ? data.posts : [];
}

export async function wordpressPosts(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const data = (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/?number=100&status=any`, token)).data;
  return Array.isArray(data) ? data : Array.isArray(data?.posts) ? data.posts : [];
}

export async function wordpressMedia(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const data = (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/media/?number=100`, token)).data;
  return Array.isArray(data) ? data : Array.isArray(data?.media) ? data.media : [];
}

export async function createWordpressPage(workspaceId: string, siteId: string, page: { title: string; slug?: string; content: string; seoTitle?: string; seoDescription?: string; menuOrder?: number; status?: 'draft' | 'publish' }) {
  const token = await tokenFor(workspaceId, 'wordpress');
  return (await providerRequest('wordpress', `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/new/`, token, { method: 'POST', body: JSON.stringify({ type: 'page', title: page.title, ...(page.slug ? { slug: page.slug } : {}), content: page.content, ...(page.seoDescription ? { excerpt: page.seoDescription } : {}), ...(typeof page.menuOrder === 'number' ? { menu_order: page.menuOrder } : {}), status: page.status ?? 'draft' }) })).data;
}

export async function updateWordpressPage(workspaceId: string, siteId: string, pageId: string, page: { title: string; slug?: string; content: string; seoDescription?: string; menuOrder?: number; status?: 'draft' | 'publish' }) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const endpoint = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/${encodeURIComponent(pageId)}/`;
  return (await providerRequest('wordpress', endpoint, token, { method: 'POST', body: JSON.stringify({ title: page.title, ...(page.slug ? { slug: page.slug } : {}), content: page.content, ...(page.seoDescription ? { excerpt: page.seoDescription } : {}), ...(typeof page.menuOrder === 'number' ? { menu_order: page.menuOrder } : {}), ...(page.status ? { status: page.status } : {}) }) })).data;
}
export async function publishWordpressPage(workspaceId: string, siteId: string, pageId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const endpoint = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/${encodeURIComponent(pageId)}/`;
  await providerRequest('wordpress', endpoint, token, { method: 'POST', body: JSON.stringify({ status: 'publish' }) });
  const verification = (await providerRequest('wordpress', endpoint, token)).data;
  const status = String(verification?.status ?? '').toLowerCase();
  const publicUrl = verification?.URL ?? verification?.url ?? verification?.link ?? null;
  if (status !== 'publish' || !publicUrl) {
    throw new AppError(502, 'WORDPRESS_PUBLISH_VERIFICATION_FAILED', 'WordPress did not verify the page as publicly published', {
      provider: 'wordpress',
      pageId,
      verifiedStatus: verification?.status,
      providerResult: verification,
    });
  }
  return verification;
}

export async function setWordpressPageStatus(workspaceId: string, siteId: string, pageId: string, status: 'draft' | 'publish' | 'private') {
  const token = await tokenFor(workspaceId, 'wordpress');
  const endpoint = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/posts/${encodeURIComponent(pageId)}/`;
  await providerRequest('wordpress', endpoint, token, { method: 'POST', body: JSON.stringify({ status }) });
  const verification = (await providerRequest('wordpress', endpoint, token)).data;
  if (String(verification?.status ?? '').toLowerCase() !== status) {
    throw new AppError(502, 'WORDPRESS_PAGE_STATUS_VERIFICATION_FAILED', `WordPress did not confirm page ${pageId} as ${status}`, {
      provider: 'wordpress',
      pageId,
      expectedStatus: status,
      verifiedStatus: verification?.status,
    });
  }
  return verification;
}

export async function updateWordpressSiteIdentity(workspaceId: string, siteId: string, identity: { title: string; description: string }) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const endpoints = [
    {
      url: `https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(siteId)}/settings`,
      payload: { title: identity.title, description: identity.description },
      read: (data: any) => ({ title: data?.title, description: data?.description }),
    },
    {
      url: `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/settings/`,
      payload: { blogname: identity.title, blogdescription: identity.description },
      read: (data: any) => {
        const settings = data?.settings && typeof data.settings === 'object' ? data.settings : data;
        return {
          title: settings?.blogname?.value ?? settings?.blogname,
          description: settings?.blogdescription?.value ?? settings?.blogdescription,
        };
      },
    },
  ];
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      await providerRequest('wordpress', endpoint.url, token, { method: 'POST', body: JSON.stringify(endpoint.payload) });
      const verified = (await providerRequest('wordpress', endpoint.url, token)).data;
      const actual = endpoint.read(verified);
      if (String(actual.title ?? '').trim() === identity.title.trim()) return { ...actual, endpoint: endpoint.url };
      errors.push(`${endpoint.url}: site title was not confirmed`);
    } catch (error) {
      errors.push(`${endpoint.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new AppError(502, 'WORDPRESS_SITE_IDENTITY_CONFIGURATION_FAILED', 'WordPress did not confirm the generated company name and site description', {
    provider: 'wordpress',
    attempts: errors,
  });
}

export async function wordpressTemplateParts(workspaceId: string, siteId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const endpoint = `https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(siteId)}/template-parts?context=edit&per_page=100`;
  const data = (await providerRequest('wordpress', endpoint, token)).data;
  return Array.isArray(data) ? data : Array.isArray(data?.template_parts) ? data.template_parts : [];
}

export async function updateWordpressTemplatePart(workspaceId: string, siteId: string, partId: string, content: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const endpoint = `https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(siteId)}/template-parts/${encodeURIComponent(partId)}`;
  await providerRequest('wordpress', endpoint, token, { method: 'POST', body: JSON.stringify({ content, status: 'publish' }) });
  const verification = (await providerRequest('wordpress', `${endpoint}?context=edit`, token)).data;
  const verifiedContent = verification?.content?.raw ?? verification?.content?.rendered ?? verification?.content ?? '';
  if (!String(verifiedContent).includes('data-lulu-global=')) {
    throw new AppError(502, 'WORDPRESS_TEMPLATE_PART_VERIFICATION_FAILED', `WordPress did not confirm template part ${partId}`, {
      provider: 'wordpress',
      partId,
    });
  }
  return verification;
}

export async function updateWordpressFrontPage(workspaceId: string, siteId: string, pageId: string) {
  const token = await tokenFor(workspaceId, 'wordpress');
  const expectedPageId = Number(pageId);
  const endpoints = [
    `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}/settings/`,
    `https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(siteId)}/settings`,
  ];
  let verified: any = null;
  let actualMode = '';
  let actualPageId = 0;
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      await providerRequest('wordpress', endpoint, token, {
        method: 'POST',
        body: JSON.stringify({ show_on_front: 'page', page_on_front: expectedPageId }),
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
        verified = (await providerRequest('wordpress', endpoint, token)).data;
        const settings = verified?.settings && typeof verified.settings === 'object' ? verified.settings : verified;
        const modeValue = settings?.show_on_front?.value ?? settings?.show_on_front;
        const pageValue = settings?.page_on_front?.value ?? settings?.page_on_front;
        actualMode = String(modeValue ?? '').trim().toLowerCase();
        actualPageId = Number(pageValue ?? 0);
        if (actualMode === 'page' && actualPageId === expectedPageId) return verified;
      }
      errors.push(`${endpoint}: settings were not confirmed`);
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new AppError(502, 'WORDPRESS_HOMEPAGE_CONFIGURATION_FAILED', `WordPress did not confirm the generated page as the homepage (expected page ${expectedPageId}, received mode ${actualMode || 'unknown'} and page ${actualPageId || 'unknown'})`, { provider: 'wordpress', expectedPageId, actualMode, actualPageId, attempts: errors, providerResult: verified });
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
