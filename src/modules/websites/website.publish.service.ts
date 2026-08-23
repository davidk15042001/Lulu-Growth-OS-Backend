import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import * as repo from './website.repo.js';
import { createWordpressPage, createWebflowItem, publishWebflowSite, publishWordpressPage, updateWordpressFrontPage, updateWordpressPage, wordpressPages, wordpressSiteDetails, webflowCustomDomains, withProviderConnectionError } from './website.provider.service.js';
import { appendGenerationActivity, type WebsiteGenerationActivity } from './website.activity.js';
import type { WebsiteGenerationTargetMode } from './website.types.js';

const WORDPRESS_THEME = { key: 'lulu-base', name: 'Lulu Base', version: '2.0.0', downloadPath: '/downloads/lulu-base.zip' } as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function wordpressAdminUrl(siteUrl: string | null | undefined, path: string) {
  if (!siteUrl) return null;
  try {
    const url = new URL(siteUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.pathname = path.startsWith('/') ? path : `/${path}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function wordpressActiveTheme(details: unknown) {
  const value = objectValue(details);
  const options = objectValue(value.options);
  const theme = objectValue(value.theme);
  const candidates = [options.theme_slug, options.stylesheet, options.template, value.theme_slug, value.stylesheet, value.template, typeof value.theme === 'string' ? value.theme : null, theme.slug, theme.stylesheet, theme.template];
  return candidates.filter((candidate) => typeof candidate === 'string' || typeof candidate === 'number').map((candidate) => String(candidate).trim().toLowerCase()).find(Boolean) ?? null;
}

export function wordpressOption(details: unknown, key: string) {
  const value = objectValue(details);
  const options = objectValue(value.options);
  const raw = options[key] ?? value[key];
  return objectValue(raw).value ?? raw ?? null;
}

export function wordpressHomepageWarning(error: unknown) {
  const errorCode = error instanceof AppError ? error.code : 'WORDPRESS_HOMEPAGE_CONFIGURATION_FAILED';
  const providerDetails = error instanceof AppError ? objectValue(error.details) : {};
  const providerMessage = String(providerDetails.providerMessage ?? '').trim();
  const technicalMessage = error instanceof Error ? error.message : String(error);
  return {
    errorCode,
    technicalMessage,
    message: providerMessage
      ? `All generated pages were published, but WordPress did not apply the generated Home page automatically (${providerMessage}). Select Home under WordPress Reading settings.`
      : 'All generated pages were published, but WordPress did not confirm the generated Home page as the static homepage. Select Home under WordPress Reading settings.',
  };
}

export function completedWordpressPages(job: unknown) {
  const value = objectValue(job);
  if (value.status !== 'failed') return null;
  const plan = objectValue(value.plan);
  const result = objectValue(value.providerResult);
  const plannedPages = Array.isArray(plan.pages) ? plan.pages.map(objectValue) : [];
  const publishedPages = Array.isArray(result.pages) ? result.pages.map(objectValue) : [];
  if (!plannedPages.length || publishedPages.length < plannedPages.length) return null;
  const confirmedPages = publishedPages.filter((page) => {
    const id = String(page.id ?? '').trim();
    const url = String(page.url ?? '').trim();
    return Boolean(id && /^https?:\/\//i.test(url));
  });
  if (confirmedPages.length < plannedPages.length) return null;
  const allPlannedPagesConfirmed = plannedPages.every((page, index) => {
    const slug = String(page.slug ?? '').trim().toLowerCase();
    const title = String(page.title ?? '').trim().toLowerCase();
    return confirmedPages.some((publishedPage, publishedIndex) => {
      const publishedSlug = String(publishedPage.slug ?? '').trim().toLowerCase();
      const publishedTitle = String(publishedPage.title ?? '').trim().toLowerCase();
      return (slug && slug === publishedSlug) || (title && title === publishedTitle) || (!slug && !title && index === publishedIndex);
    });
  });
  return allPlannedPagesConfirmed ? confirmedPages.slice(0, plannedPages.length) : null;
}

export async function verifyWordpressSetup(workspaceId: string, siteId: string) {
  const site = await repo.getSite(workspaceId, siteId);
  if (!site || site.provider !== 'wordpress' || !site.externalSiteId) {
    throw new AppError(404, 'WORDPRESS_SITE_NOT_FOUND', 'The connected WordPress site was not found');
  }
  const details = await wordpressSiteDetails(workspaceId, site.externalSiteId);
  const storedSetup = objectValue(site.settings.wordpressSetup);
  const storedHomepage = objectValue(storedSetup.homepage);
  const storedTheme = objectValue(storedSetup.theme);
  const expectedHomepageId = Number(storedHomepage.pageId ?? 0);
  const actualMode = String(wordpressOption(details, 'show_on_front') ?? '').trim().toLowerCase();
  const actualHomepageId = Number(wordpressOption(details, 'page_on_front') ?? 0);
  const homepageConfigured = expectedHomepageId > 0 && actualMode === 'page' && actualHomepageId === expectedHomepageId;
  const activeTheme = wordpressActiveTheme(details);
  const themeActive = Boolean(activeTheme && (activeTheme === WORDPRESS_THEME.key || activeTheme.endsWith(`/${WORDPRESS_THEME.key}`)));
  const adminBaseUrl = site.externalSiteUrl ?? String(storedHomepage.pageUrl ?? '');
  const homepage = {
    ...storedHomepage,
    status: homepageConfigured ? 'confirmed' : 'action_required',
    actualMode: actualMode || null,
    actualPageId: actualHomepageId || null,
    adminUrl: wordpressAdminUrl(adminBaseUrl, '/wp-admin/options-reading.php'),
    checkedAt: new Date().toISOString(),
  };
  const theme = {
    ...WORDPRESS_THEME,
    ...storedTheme,
    status: themeActive ? 'active' : 'action_required',
    activeTheme,
    adminUrl: wordpressAdminUrl(adminBaseUrl, '/wp-admin/theme-install.php'),
    reason: themeActive ? null : 'custom_theme_installation_requires_wordpress_dashboard',
    checkedAt: new Date().toISOString(),
  };
  const setup = { homepage, theme };
  await repo.updateSiteSettings(workspaceId, siteId, { wordpressSetup: { ...setup, updatedAt: new Date().toISOString() } });
  const latestJob = await repo.findLatestJob(siteId);
  const completedPages = completedWordpressPages(latestJob);
  let reconciledJob = latestJob;
  if (latestJob && completedPages) {
    const progress = { phase: 'published', percent: 100, completedPages: completedPages.length, totalPages: completedPages.length, currentPageTitle: null };
    const preview = {
      ...appendGenerationActivity(latestJob.preview, { id: 'published-job-reconciled', code: 'published_job_reconciled', tone: 'warning', params: { pages: completedPages.length } }),
      provider: 'wordpress',
      publishedPages: completedPages,
      progress,
    };
    reconciledJob = await repo.updateJob(siteId, latestJob.id, {
      status: 'published',
      preview,
      providerResult: {
        ...latestJob.providerResult,
        partial: false,
        pages: completedPages,
        homepageConfigured,
        homepageSetup: homepage,
        themeSetup: theme,
        reconciledAt: new Date().toISOString(),
      },
      errorCode: null,
      errorMessage: null,
    });
    await repo.updateSiteStatus(workspaceId, siteId, 'published');
    logger.warn({ jobId: latestJob.id, siteId, pages: completedPages.length }, 'Recovered a failed WordPress job whose complete page set was already published');
  }
  const updatedSite = await repo.getSite(workspaceId, siteId);
  return { site: updatedSite ?? site, setup, job: reconciledJob };
}

export function findReusableWordpressPage(existingPages: any[], page: Record<string, unknown>, targetMode: WebsiteGenerationTargetMode) {
  if (targetMode === 'new') return undefined;
  const desiredSlug = String(page.slug ?? '').trim().toLowerCase();
  const desiredTitle = String(page.title ?? '').trim().toLowerCase();
  return existingPages.find((candidate: any) => {
    const candidateSlug = String(candidate.slug ?? '').trim().toLowerCase();
    const candidateTitle = String(candidate.title ?? '').trim().toLowerCase();
    return (desiredSlug && candidateSlug === desiredSlug) || candidateTitle === desiredTitle;
  });
}

async function assertPublishingNotCancelled(siteId: string, jobId: string) {
  const current = await repo.getJob(siteId, jobId);
  if (current?.status === 'cancelled') {
    throw new AppError(409, 'WEBSITE_GENERATION_CANCELLED', 'Website generation was cancelled by the user');
  }
  return current;
}

export async function publishWebsiteJob(workspaceId: string, siteId: string, jobId: string) {
  const site = await repo.getSite(workspaceId, siteId);
  const job = await repo.getJob(siteId, jobId);
  if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found');
  if (!job) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found');
  if (job.status !== 'preview' && job.status !== 'generated') throw new AppError(409, 'WEBSITE_PUBLISH_STATE_INVALID', 'Only a generated preview can be published');
  const plan = job.plan as any;
  const targetMode = job.preview?.targetMode === 'new' ? 'new' : 'existing';
  const publishingJob = await repo.updateJob(siteId, jobId, { status: 'publishing', preview: appendGenerationActivity(job.preview, { id: 'publishing-started', code: 'publishing_started', tone: 'info', params: { provider: site.provider } }) });
  if (!publishingJob) await assertPublishingNotCancelled(siteId, jobId);
  try {
    if (site.provider === 'managed') throw new AppError(503, 'WEBSITE_MANAGED_HOSTING_NOT_CONFIGURED', 'Managed website hosting is not configured yet');
    if (site.provider === 'wordpress') {
      const externalSiteId = site.externalSiteId;
      if (!externalSiteId) throw new AppError(409, 'WEBSITE_PROVIDER_SITE_ID_MISSING', 'The connected WordPress site ID is missing');
      const plannedPages = Array.isArray(plan?.pages) ? plan.pages : [];
      if (!plannedPages.length) throw new AppError(502, 'WEBSITE_PLAN_EMPTY', 'The generated website plan contains no pages');
      const updatePublishingProgress = async (phase: string, completedPages: number, currentPageTitle: string | null, percent: number, activity?: Omit<WebsiteGenerationActivity, 'createdAt'>) => {
        const current = await assertPublishingNotCancelled(siteId, jobId);
        const preview = {
          ...(current?.preview ?? job.preview),
          provider: 'wordpress',
          automatic: job.autoPublish,
          progress: { phase, percent, completedPages, totalPages: plannedPages.length, currentPageTitle },
        };
        const updated = await repo.updateJob(siteId, jobId, {
          status: 'publishing',
          preview: activity ? appendGenerationActivity(preview, activity) : preview,
        });
        if (!updated) await assertPublishingNotCancelled(siteId, jobId);
      };
      const storedPages = Array.isArray((job.providerResult as { pages?: unknown[] }).pages)
        ? (job.providerResult as { pages: any[] }).pages.filter((page) => page && typeof page === 'object' && page.id && page.url)
        : [];
      const createdPages: any[] = [...storedPages];
      const recordPublishedPage = async (entry: Record<string, unknown>, completedPages: number, currentPageTitle: string | null) => {
        const existingIndex = createdPages.findIndex((page) => String(page.slug ?? '') === String(entry.slug ?? '') || String(page.id ?? '') === String(entry.id ?? ''));
        if (existingIndex >= 0) createdPages[existingIndex] = entry;
        else createdPages.push(entry);
        const current = await repo.getJob(siteId, jobId);
        if (!current) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found');
        const percent = Math.round(55 + (completedPages / plannedPages.length) * 40);
        await repo.updateJob(siteId, jobId, {
          preview: {
            ...appendGenerationActivity(current.preview, { id: `page-published:${String(entry.slug ?? entry.id ?? completedPages)}`, code: 'page_published', tone: 'success', params: { page: String(entry.title ?? entry.slug ?? '') } }),
            provider: 'wordpress',
            automatic: job.autoPublish,
            publishedPages: createdPages,
            progress: { phase: current.status === 'cancelled' ? 'cancelled' : 'publishing_pages', percent, completedPages, totalPages: plannedPages.length, currentPageTitle },
          },
          providerResult: {
            ...current.providerResult,
            provider: 'wordpress',
            targetMode,
            templateKey: plan?.templateKey ?? null,
            partial: completedPages < plannedPages.length,
            pages: createdPages,
          },
        });
        const latest = await repo.getJob(siteId, jobId);
        if (current.status === 'cancelled' || latest?.status === 'cancelled') {
          await repo.cancelJob(siteId, jobId);
          throw new AppError(409, 'WEBSITE_GENERATION_CANCELLED', 'Website generation was cancelled by the user');
        }
      };
      const existingPages = await withProviderConnectionError(workspaceId, 'wordpress', () => wordpressPages(workspaceId, externalSiteId));
      for (const [pageIndex, page] of plannedPages.entries()) {
        const desiredSlug = String(page.slug ?? '').trim().toLowerCase();
        const alreadyPublished = createdPages.find((candidate) => String(candidate.slug ?? '').trim().toLowerCase() === desiredSlug && candidate.url);
        if (alreadyPublished) {
          await updatePublishingProgress('publishing_pages', pageIndex + 1, plannedPages[pageIndex + 1]?.title ? String(plannedPages[pageIndex + 1].title) : null, Math.round(55 + ((pageIndex + 1) / plannedPages.length) * 40), { id: `page-confirmed:${desiredSlug}`, code: 'page_already_published', tone: 'success', params: { page: String(page.title ?? '') } });
          continue;
        }
        await updatePublishingProgress('publishing_pages', pageIndex, String(page.title ?? ''), Math.round(55 + (pageIndex / plannedPages.length) * 40), { id: `page-publishing:${desiredSlug || pageIndex}`, code: 'page_publishing', tone: 'info', params: { page: String(page.title ?? '') } });
        const existing = findReusableWordpressPage(existingPages, page, targetMode);
        let published: any = existing;
        let pageId = existing?.ID ?? existing?.id;
        const existingStatus = String(existing?.status ?? '').toLowerCase();
        if (!pageId) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const draft = await withProviderConnectionError(workspaceId, 'wordpress', () => createWordpressPage(workspaceId, externalSiteId, { title: page.title, ...(desiredSlug ? { slug: desiredSlug } : {}), content: page.content, seoTitle: page.seoTitle, seoDescription: page.seoDescription, menuOrder: pageIndex + 1, status: 'draft' }));
          pageId = draft.ID ?? draft.id;
          if (!pageId) throw new AppError(502, 'WORDPRESS_CREATE_UNCONFIRMED', 'WordPress did not return an ID for the created page', { provider: 'wordpress', providerResult: draft });
          published = draft;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 750));
          published = await withProviderConnectionError(workspaceId, 'wordpress', () => updateWordpressPage(workspaceId, externalSiteId, String(pageId), { title: page.title, ...(desiredSlug ? { slug: desiredSlug } : {}), content: page.content, seoDescription: page.seoDescription, menuOrder: pageIndex + 1, status: 'draft' }));
        }
        const existingUrl = existing?.URL ?? existing?.url ?? existing?.link ?? null;
        if (existingStatus !== 'publish' || !existingUrl || Boolean(existing)) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          published = await withProviderConnectionError(workspaceId, 'wordpress', () => publishWordpressPage(workspaceId, externalSiteId, String(pageId)));
        }
        const publishedUrl = published?.URL ?? published?.url ?? published?.link ?? null;
        const publishedContent = String(published?.content ?? '');
        if (/hello world|example\.com|123 example street|hi@example\.com/i.test(publishedContent)) {
          throw new AppError(502, 'WORDPRESS_PLACEHOLDER_CONTENT_DETECTED', 'WordPress still contains placeholder content; the generated customer content was not confirmed', { provider: 'wordpress', pageId, providerResult: published });
        }
        if (!publishedUrl) throw new AppError(502, 'WORDPRESS_PUBLISH_UNCONFIRMED', 'WordPress did not confirm a published URL for the page', { provider: 'wordpress', providerResult: published });
        await recordPublishedPage({ id: pageId, url: String(publishedUrl), title: String(page.title ?? ''), slug: desiredSlug, status: 'published', reused: Boolean(existing), publishedAt: new Date().toISOString() }, pageIndex + 1, plannedPages[pageIndex + 1]?.title ? String(plannedPages[pageIndex + 1].title) : null);
      }
      if (createdPages.length !== plannedPages.length) throw new AppError(502, 'WORDPRESS_PUBLISH_INCOMPLETE', 'WordPress did not confirm all generated pages', { provider: 'wordpress', providerResult: { pages: createdPages } });
      const homepageId = String(createdPages[0]?.id ?? '');
      if (!homepageId) throw new AppError(502, 'WORDPRESS_HOMEPAGE_UNCONFIRMED', 'WordPress did not confirm the generated homepage', { provider: 'wordpress', providerResult: { pages: createdPages } });
      let homepageConfigured = false;
      let homepageWarning: string | undefined;
      let homepageErrorCode: string | undefined;
      try {
        await updatePublishingProgress('configuring_homepage', plannedPages.length, null, 97, { id: 'homepage-configuring', code: 'homepage_configuring', tone: 'info', params: {} });
        await withProviderConnectionError(workspaceId, 'wordpress', () => updateWordpressFrontPage(workspaceId, externalSiteId, homepageId));
        homepageConfigured = true;
      } catch (homepageError) {
        if (homepageError instanceof AppError && homepageError.code === 'WEBSITE_GENERATION_CANCELLED') throw homepageError;
        const warning = wordpressHomepageWarning(homepageError);
        homepageWarning = warning.message;
        homepageErrorCode = warning.errorCode;
        logger.warn({ jobId, siteId, externalSiteId, homepageId, errorCode: warning.errorCode, error: warning.technicalMessage }, 'WordPress pages published; homepage requires manual confirmation');
      }
      let activeTheme: string | null = null;
      try {
        const details = await wordpressSiteDetails(workspaceId, externalSiteId);
        activeTheme = wordpressActiveTheme(details);
      } catch (themeInspectionError) {
        logger.warn({ jobId, siteId, externalSiteId, error: themeInspectionError instanceof Error ? themeInspectionError.message : String(themeInspectionError) }, 'WordPress active theme could not be inspected');
      }
      const themeActive = Boolean(activeTheme && (activeTheme === WORDPRESS_THEME.key || activeTheme.endsWith(`/${WORDPRESS_THEME.key}`)));
      const homepageUrl = String(createdPages[0]?.url ?? site.externalSiteUrl ?? '');
      const adminBaseUrl = site.externalSiteUrl ?? homepageUrl;
      const homepageSetup = {
        status: homepageConfigured ? 'confirmed' : 'action_required',
        pageId: homepageId,
        pageUrl: homepageUrl || null,
        adminUrl: wordpressAdminUrl(adminBaseUrl, '/wp-admin/options-reading.php'),
        ...(homepageWarning ? { warning: homepageWarning, errorCode: homepageErrorCode } : {}),
      };
      const themeSetup = {
        ...WORDPRESS_THEME,
        status: themeActive ? 'active' : 'action_required',
        activeTheme,
        adminUrl: wordpressAdminUrl(adminBaseUrl, '/wp-admin/theme-install.php'),
        reason: themeActive ? null : 'custom_theme_installation_requires_wordpress_dashboard',
      };
      const setupWarning = homepageWarning ?? (!themeActive ? 'Install and activate the Lulu Base theme in WordPress to apply the complete generated design.' : undefined);
      const beforePublished = await repo.getJob(siteId, jobId);
      let finalPreview = beforePublished?.preview ?? job.preview;
      if (homepageWarning) {
        finalPreview = appendGenerationActivity(finalPreview, { id: 'homepage-action-required', code: 'homepage_action_required', tone: 'warning', params: { page: String(createdPages[0]?.title ?? 'Home') } });
      }
      if (!themeActive) {
        finalPreview = appendGenerationActivity(finalPreview, { id: 'theme-action-required', code: 'theme_action_required', tone: 'warning', params: { theme: WORDPRESS_THEME.name } });
      }
      await repo.updateSiteSettings(workspaceId, siteId, { wordpressSetup: { homepage: homepageSetup, theme: themeSetup, updatedAt: new Date().toISOString() } }).catch((settingsError) => {
        logger.warn({ jobId, siteId, error: settingsError instanceof Error ? settingsError.message : String(settingsError) }, 'Published WordPress setup metadata could not be persisted');
      });
      const publishedJob = await repo.updateJob(siteId, jobId, {
        status: 'published',
        preview: {
          ...appendGenerationActivity(finalPreview, { id: 'website-published', code: setupWarning ? 'website_published_setup_required' : 'website_published', tone: setupWarning ? 'warning' : 'success', params: {} }),
          provider: 'wordpress',
          automatic: job.autoPublish,
          publishedPages: createdPages,
          progress: { phase: 'published', percent: 100, completedPages: plannedPages.length, totalPages: plannedPages.length, currentPageTitle: null },
        },
        providerResult: { provider: 'wordpress', targetMode, templateKey: plan?.templateKey ?? null, partial: false, pages: createdPages, homepageId, homepageConfigured, homepageSetup, themeSetup, ...(homepageWarning ? { homepageWarning } : {}) },
      });
      if (!publishedJob) await assertPublishingNotCancelled(siteId, jobId);
      await repo.updateSiteStatus(workspaceId, siteId, 'published');
      return publishedJob;
    }
    const collectionId = typeof site.settings.collectionId === 'string' ? site.settings.collectionId : '';
    if (!collectionId || !site.externalSiteId) throw new AppError(409, 'WEBSITE_PROVIDER_CONFIGURATION_MISSING', 'Webflow site ID and CMS collection ID are required for publishing');
    const items: any[] = [];
    for (const page of plan.pages ?? []) {
      await assertPublishingNotCancelled(siteId, jobId);
      await repo.appendJobActivity(siteId, jobId, { id: `page-publishing:${String(page.slug ?? items.length)}`, code: 'page_publishing', tone: 'info', params: { page: String(page.title ?? '') } });
      const item = await withProviderConnectionError(workspaceId, 'webflow', () => createWebflowItem(workspaceId, collectionId, { name: page.title, slug: page.slug, content: page.content, seoTitle: page.seoTitle, seoDescription: page.seoDescription }, false));
      items.push({ id: item.id ?? item._id, slug: page.slug });
      await repo.appendJobActivity(siteId, jobId, { id: `page-published:${String(page.slug ?? items.length)}`, code: 'page_published', tone: 'success', params: { page: String(page.title ?? '') } });
    }
    const providerDomains = await withProviderConnectionError(workspaceId, 'webflow', () => webflowCustomDomains(workspaceId, site.externalSiteId!));
    const providerDomainItems = Array.isArray(providerDomains?.customDomains) ? providerDomains.customDomains : Array.isArray(providerDomains) ? providerDomains : [];
    const verifiedHostnames = new Set(site.domains.filter((domain) => domain.status === 'verified').map((domain) => domain.hostname.toLowerCase()));
    const customDomainIds = providerDomainItems.filter((domain: any) => verifiedHostnames.has(String(domain.url ?? domain.hostname ?? '').toLowerCase())).map((domain: any) => String(domain.id));
    await assertPublishingNotCancelled(siteId, jobId);
    const published = await withProviderConnectionError(workspaceId, 'webflow', () => publishWebflowSite(workspaceId, site.externalSiteId!, customDomainIds));
    const beforePublished = await repo.getJob(siteId, jobId);
    const publishedJob = await repo.updateJob(siteId, jobId, { status: 'published', preview: appendGenerationActivity(beforePublished?.preview ?? job.preview, { id: 'website-published', code: 'website_published', tone: 'success', params: {} }), providerResult: { provider: 'webflow', targetMode, items, published } });
    await repo.updateSiteStatus(workspaceId, siteId, 'published');
    return publishedJob;
  } catch (error) {
    if (error instanceof AppError && error.code === 'WEBSITE_GENERATION_CANCELLED') throw error;
    const failedJob = await repo.getJob(siteId, jobId).catch(() => null);
    const message = error instanceof Error ? error.message : 'Website publishing failed';
    await repo.updateJob(siteId, jobId, { status: 'failed', errorCode: error instanceof AppError ? error.code : 'WEBSITE_PUBLISH_FAILED', errorMessage: message, ...(failedJob ? { preview: appendGenerationActivity(failedJob.preview, { id: `publishing-failed:${failedJob.attemptCount}`, code: 'publishing_failed', tone: 'error', params: { message } }) } : {}) });
    throw error;
  }
}
