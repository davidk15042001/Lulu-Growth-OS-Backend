import { AppError } from '../../utils/app-error.js';
import * as repo from './website.repo.js';
import { createWordpressPage, createWebflowItem, publishWebflowSite, publishWordpressPage, updateWordpressFrontPage, updateWordpressPage, wordpressPages, webflowCustomDomains, withProviderConnectionError } from './website.provider.service.js';
import { appendGenerationActivity, type WebsiteGenerationActivity } from './website.activity.js';

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
        const existing = existingPages.find((candidate: any) => {
          const candidateSlug = String(candidate.slug ?? '').trim().toLowerCase();
          const candidateTitle = String(candidate.title ?? '').trim().toLowerCase();
          return (desiredSlug && candidateSlug === desiredSlug) || candidateTitle === String(page.title ?? '').trim().toLowerCase();
        });
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
      try {
        await updatePublishingProgress('configuring_homepage', plannedPages.length, null, 97, { id: 'homepage-configuring', code: 'homepage_configuring', tone: 'info', params: {} });
        await withProviderConnectionError(workspaceId, 'wordpress', () => updateWordpressFrontPage(workspaceId, externalSiteId, homepageId));
        homepageConfigured = true;
      } catch (homepageError) {
        const details = homepageError instanceof AppError && homepageError.details && typeof homepageError.details === 'object'
          ? homepageError.details as Record<string, unknown>
          : undefined;
        const providerMessage = String(details?.providerMessage ?? '');
        const errorMessage = homepageError instanceof Error ? homepageError.message : String(homepageError);
        const settingsEndpointDisabled = /api calls? to this endpoint have been disabled/i.test(`${providerMessage} ${errorMessage}`);
        if (!settingsEndpointDisabled) throw homepageError;
        homepageWarning = 'WordPress published the generated pages, but its settings endpoint is disabled; set the generated homepage manually in WordPress Reading settings.';
      }
      const beforePublished = await repo.getJob(siteId, jobId);
      const publishedJob = await repo.updateJob(siteId, jobId, {
        status: 'published',
        preview: {
          ...appendGenerationActivity(beforePublished?.preview ?? job.preview, { id: 'website-published', code: homepageWarning ? 'website_published_with_warning' : 'website_published', tone: homepageWarning ? 'warning' : 'success', params: homepageWarning ? { warning: homepageWarning } : {} }),
          provider: 'wordpress',
          automatic: job.autoPublish,
          publishedPages: createdPages,
          progress: { phase: 'published', percent: 100, completedPages: plannedPages.length, totalPages: plannedPages.length, currentPageTitle: null },
        },
        providerResult: { provider: 'wordpress', templateKey: plan?.templateKey ?? null, partial: false, pages: createdPages, homepageId, homepageConfigured, ...(homepageWarning ? { homepageWarning } : {}) },
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
    const publishedJob = await repo.updateJob(siteId, jobId, { status: 'published', preview: appendGenerationActivity(beforePublished?.preview ?? job.preview, { id: 'website-published', code: 'website_published', tone: 'success', params: {} }), providerResult: { provider: 'webflow', items, published } });
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
