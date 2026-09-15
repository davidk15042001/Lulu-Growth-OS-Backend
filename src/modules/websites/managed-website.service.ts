import { AppError } from '../../utils/app-error.js';
import * as repo from './website.repo.js';
import { appendGenerationActivity } from './website.activity.js';

function managedWebsiteSettings(site: { id: string; name: string; settings: Record<string, unknown> }, plan: Record<string, unknown>) {
  const previous = site.settings.managedWebsite && typeof site.settings.managedWebsite === 'object'
    ? site.settings.managedWebsite as Record<string, unknown>
    : {};
  const currentSlug = typeof previous.publicSlug === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(previous.publicSlug)
    ? previous.publicSlug
    : `site-${site.id.slice(0, 8)}`;
  return {
    ...previous,
    publicSlug: currentSlug,
    templateKey: typeof plan.templateKey === 'string' ? plan.templateKey : String(previous.templateKey ?? 'lulu-standard-v1'),
    plan,
    publishedAt: new Date().toISOString(),
    previewUrl: `/api/v1/public/storefront/${encodeURIComponent(currentSlug)}`,
    deployment: 'lulu-managed',
  };
}

/**
 * Publish a generated plan into Lulu's own managed website projection.
 *
 * The plan remains the canonical build artifact for now; an edge/static
 * deployment worker can later copy the same immutable artifact to R2 without
 * changing the website generation or commerce contracts.
 */
export async function publishManagedWebsiteJob(workspaceId: string, siteId: string, jobId: string) {
  const site = await repo.getSite(workspaceId, siteId);
  const job = await repo.getJob(siteId, jobId);
  if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found');
  if (!job) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found');
  const plan = job.plan && typeof job.plan === 'object' ? job.plan as Record<string, unknown> : {};
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  if (!pages.length) throw new AppError(502, 'WEBSITE_PLAN_EMPTY', 'The generated website plan contains no pages');

  const settings = managedWebsiteSettings(site, plan);
  await repo.updateSiteSettings(workspaceId, siteId, { managedWebsite: settings });
  const current = await repo.getJob(siteId, jobId);
  const preview = {
    ...appendGenerationActivity(current?.preview ?? job.preview, { id: 'managed-site-published', code: 'managed_site_published', tone: 'success', params: { pages: pages.length } }),
    provider: 'managed',
    deployment: 'lulu-managed',
    publicSlug: settings.publicSlug,
    previewUrl: settings.previewUrl,
    progress: { phase: 'published', percent: 100, completedPages: pages.length, totalPages: pages.length, currentPageTitle: null },
  };
  const published = await repo.updateJob(siteId, jobId, {
    status: 'published',
    preview,
    providerResult: {
      provider: 'managed',
      deployment: 'lulu-managed',
      publicSlug: settings.publicSlug,
      previewUrl: settings.previewUrl,
      templateKey: settings.templateKey,
      pages: pages.map((page: any) => ({ title: page?.title ?? null, slug: page?.slug ?? null })),
    },
  });
  if (!published) throw new AppError(409, 'WEBSITE_GENERATION_CANCELLED', 'The website generation was cancelled before publication completed');
  await repo.updateSiteStatus(workspaceId, siteId, 'published');
  return published;
}
