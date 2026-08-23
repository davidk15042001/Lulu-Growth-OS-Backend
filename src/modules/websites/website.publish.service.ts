import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import * as repo from './website.repo.js';
import { createWordpressPage, createWebflowItem, publishWebflowSite, publishWordpressPage, setWordpressPageStatus, updateWordpressFrontPage, updateWordpressPage, updateWordpressSiteIdentity, updateWordpressTemplatePart, wordpressPages, wordpressSiteDetails, wordpressTemplateParts, webflowCustomDomains, withProviderConnectionError } from './website.provider.service.js';
import { appendGenerationActivity, type WebsiteGenerationActivity } from './website.activity.js';
import type { WebsiteGenerationTargetMode } from './website.types.js';

const WORDPRESS_THEME_KEY = 'lulu-base';

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

function capabilityEnabled(capabilities: Record<string, unknown>, key: string) {
  const value = capabilities[key];
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function wordpressDeliveryCapabilities(details: unknown) {
  const value = objectValue(details);
  const capabilities = objectValue(value.capabilities);
  const plan = objectValue(value.plan);
  return {
    deliveryMode: 'gutenberg' as const,
    canEditContent: capabilityEnabled(capabilities, 'edit_posts'),
    canPublishContent: capabilityEnabled(capabilities, 'publish_posts'),
    canManageHomepage: capabilityEnabled(capabilities, 'manage_options') || capabilityEnabled(capabilities, 'edit_theme_options'),
    canInstallThemes: capabilityEnabled(capabilities, 'install_themes') || capabilityEnabled(capabilities, 'update_themes'),
    fullSiteEditing: value.is_fse_active === true || value.is_fse_eligible === true || value.is_core_site_editor_enabled === true,
    userCanManage: value.user_can_manage === true,
    isWordpressComAtomic: value.is_wpcom_atomic === true,
    planSlug: String(plan.product_slug ?? plan.slug ?? plan.product_name_short ?? '').trim() || null,
    checkedAt: new Date().toISOString(),
  };
}

export function wordpressGutenbergContent(page: unknown) {
  const value = objectValue(page);
  const generatedSections = Array.isArray(value.generatedSections)
    ? value.generatedSections.map(objectValue).map((section) => String(section.html ?? '').trim()).filter(Boolean)
    : [];
  const rawContent = String(value.content ?? '').trim();
  const mainMatch = rawContent.match(/^\s*<main\b[^>]*>([\s\S]*)<\/main>\s*$/i);
  const fallbackContent = String(mainMatch?.[1] ?? rawContent).trim();
  const sections = generatedSections.length ? generatedSections : fallbackContent ? [fallbackContent] : [];
  if (!sections.length) return rawContent;
  const decodeShortcode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
  const blockSections = sections.map((section) => {
    const shortcodeMatch = section.match(/<template\s+data-lulu-contact-form-shortcode[^>]*>([\s\S]*?)<\/template>/i);
    if (!shortcodeMatch) return `<!-- wp:html -->\n${section}\n<!-- /wp:html -->`;
    const marker = '<!--LULU_WORDPRESS_FORM_SLOT-->';
    const html = section
      .replace(/<form\s+data-lulu-contact-form-preview[^>]*>[\s\S]*?<\/form>/i, marker)
      .replace(/<template\s+data-lulu-contact-form-shortcode[^>]*>[\s\S]*?<\/template>/i, '');
    const shortcode = decodeShortcode(shortcodeMatch[1] ?? '').trim();
    const [before, after = ''] = html.split(marker);
    return `<!-- wp:html -->\n${before}\n<!-- /wp:html -->\n<!-- wp:shortcode -->\n${shortcode}\n<!-- /wp:shortcode -->\n<!-- wp:html -->\n${after}\n<!-- /wp:html -->`;
  }).join('\n');
  return [
    '<!-- wp:group {"align":"full","className":"lulu-generated-page","layout":{"type":"default"}} -->',
    '<div class="wp-block-group alignfull lulu-generated-page" style="width:100%;max-width:none;margin:0;padding:0;--wp--style--block-gap:0px">',
    blockSections,
    '</div>',
    '<!-- /wp:group -->',
  ].join('\n');
}

function escapeWordpressHtml(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function wordpressPageContent(page: unknown) {
  const value = objectValue(page);
  const content = value.content;
  if (typeof content === 'string') return content;
  const wrapped = objectValue(content);
  return String(wrapped.raw ?? wrapped.rendered ?? '');
}

export function isLuluGeneratedWordpressPage(page: unknown) {
  const content = wordpressPageContent(page);
  return /data-lulu-template=["']lulu-standard-v1["']|class=["'][^"']*lulu-generated-page|data-lulu-section=/i.test(content);
}

function canonicalWordpressSlug(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/-\d+$/, '');
}

export function findWordpressDuplicatePages(existingPages: unknown[], publishedPages: unknown[]) {
  const activeIds = new Set(publishedPages.map(objectValue).map((page) => String(page.id ?? page.ID ?? '')).filter(Boolean));
  const managedSlugs = new Set(publishedPages.map(objectValue).map((page) => canonicalWordpressSlug(page.slug)).filter(Boolean));
  return existingPages.map(objectValue).filter((page) => {
    const id = String(page.ID ?? page.id ?? '');
    const status = String(page.status ?? '').trim().toLowerCase();
    return Boolean(id)
      && !activeIds.has(id)
      && !['draft', 'trash'].includes(status)
      && managedSlugs.has(canonicalWordpressSlug(page.slug))
      && isLuluGeneratedWordpressPage(page);
  });
}

function safeWebsiteUrl(value: unknown, fallback = '/') {
  try {
    const url = new URL(String(value ?? ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function htmlBlock(markup: string) {
  return `<!-- wp:html -->\n${markup}\n<!-- /wp:html -->`;
}

export function wordpressSiteChrome(plan: unknown, publishedPages: unknown[], siteUrl: string) {
  const planValue = objectValue(plan);
  const palette = objectValue(planValue.palette);
  const pages = Array.isArray(planValue.pages) ? planValue.pages.map(objectValue) : [];
  const published = publishedPages.map(objectValue);
  const siteTitle = String(planValue.siteTitle ?? 'Website').trim() || 'Website';
  const seo = objectValue(planValue.globalSeo);
  const contentProfile = objectValue(planValue.contentProfile);
  const description = String(seo.description ?? '').trim();
  const tagline = String(contentProfile.tagline ?? description).trim();
  const primary = String(palette.primary ?? '#183c65');
  const secondary = String(palette.secondary ?? '#111827');
  const accent = String(palette.accent ?? '#22c55e');
  const ink = String(palette.ink ?? '#233142');
  const muted = String(palette.muted ?? '#657283');
  const baseUrl = safeWebsiteUrl(siteUrl, '/');
  const navigation = pages.map((page, index) => {
    const slug = String(page.slug ?? '').trim().toLowerCase();
    const record = published.find((candidate) => String(candidate.slug ?? '').trim().toLowerCase() === slug);
    const href = index === 0 ? baseUrl : safeWebsiteUrl(record?.url, `/${slug}/`);
    return { href, label: String(page.title ?? '').trim() || slug };
  });
  const headerLinks = navigation.map((item) => `<a href="${escapeWordpressHtml(item.href)}" style="padding:8px 4px;color:${escapeWordpressHtml(ink)};font-size:14px;font-weight:600;text-decoration:none">${escapeWordpressHtml(item.label)}</a>`).join('');
  const footerLinks = navigation.map((item) => `<a href="${escapeWordpressHtml(item.href)}" style="color:#dbe3ea;font-size:14px;text-decoration:none">${escapeWordpressHtml(item.label)}</a>`).join('');
  const contactItem = navigation.find((item) => /contact|kontakt|联系/i.test(item.label)) ?? navigation.at(-1);
  const contactHref = contactItem?.href ?? `${baseUrl.replace(/\/$/, '')}/contact/`;
  const contactLabel = contactItem?.label ?? 'Contact';
  const initial = siteTitle.charAt(0).toUpperCase();
  const responsiveHeaderStyle = `<style data-lulu-global-style>@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');@media(max-width:720px){[data-lulu-header-row]{min-height:64px!important;gap:12px!important;flex-wrap:nowrap!important}[data-lulu-brand]{min-width:0!important;flex:1}[data-lulu-brand-caption]{display:none!important}[data-lulu-desktop-nav],[data-lulu-header-cta]{display:none!important}[data-lulu-mobile-nav]{display:block!important}}</style>`;
  const mobileLinks = navigation.map((item) => `<a href="${escapeWordpressHtml(item.href)}" style="display:block;padding:11px 14px;border-bottom:1px solid #dce2e8;color:${escapeWordpressHtml(ink)};font-size:14px;font-weight:600;text-decoration:none">${escapeWordpressHtml(item.label)}</a>`).join('');
  const mobileNavigation = `<details data-lulu-mobile-nav style="display:none;position:relative;margin-left:auto"><summary aria-label="Open menu" style="display:grid;width:42px;height:42px;place-items:center;border:1px solid #dce2e8;background:#fff;color:${escapeWordpressHtml(ink)};cursor:pointer;font-size:22px;list-style:none">☰</summary><nav aria-label="Mobile navigation" style="position:absolute;right:0;top:48px;z-index:60;width:230px;border:1px solid #dce2e8;background:#fff;box-shadow:0 12px 28px rgba(15,23,42,.18)">${mobileLinks}</nav></details>`;
  const header = htmlBlock(`<div data-lulu-global="header" data-lulu-design-source="custom-bolt-forge" style="width:100%;max-width:none;margin:0;font-family:Barlow,'Helvetica Neue',Arial,sans-serif">${responsiveHeaderStyle}<div style="background:${escapeWordpressHtml(secondary)};color:#fff"><div style="display:flex;max-width:1280px;margin:0 auto;padding:8px 16px;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><span style="color:rgba(255,255,255,.8);font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase">${escapeWordpressHtml(tagline || siteTitle)}</span><a href="${escapeWordpressHtml(contactHref)}" style="color:${escapeWordpressHtml(accent)};font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;font-weight:600;letter-spacing:.14em;text-decoration:none;text-transform:uppercase">${escapeWordpressHtml(contactLabel)} →</a></div></div><header style="position:sticky;top:0;z-index:50;border-bottom:1px solid #dce2e8;background:#fff"><div data-lulu-header-row style="display:flex;min-height:72px;max-width:1280px;margin:0 auto;padding:12px 16px;align-items:center;gap:24px;flex-wrap:wrap"><a data-lulu-brand href="${escapeWordpressHtml(baseUrl)}" style="display:flex;min-width:220px;align-items:center;gap:12px;color:${escapeWordpressHtml(ink)};text-decoration:none"><span aria-hidden="true" style="display:grid;width:36px;height:36px;flex:0 0 36px;place-items:center;background:${escapeWordpressHtml(primary)};color:#fff;font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:19px;font-weight:700">${escapeWordpressHtml(initial)}</span><span><strong style="display:block;font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:20px;line-height:1.05">${escapeWordpressHtml(siteTitle)}</strong>${tagline ? `<small data-lulu-brand-caption style="display:block;margin-top:3px;color:${escapeWordpressHtml(muted)};font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:9px;letter-spacing:.08em;text-transform:uppercase">${escapeWordpressHtml(tagline.slice(0, 72))}</small>` : ''}</span></a><nav data-lulu-desktop-nav aria-label="Primary navigation" style="display:flex;margin-left:auto;align-items:center;gap:14px;flex-wrap:wrap">${headerLinks}</nav><a data-lulu-header-cta href="${escapeWordpressHtml(contactHref)}" style="display:inline-flex;min-height:40px;align-items:center;justify-content:center;padding:10px 16px;background:${escapeWordpressHtml(primary)};border:1px solid ${escapeWordpressHtml(primary)};color:#fff;font-size:14px;font-weight:700;text-decoration:none">${escapeWordpressHtml(contactLabel)}</a>${mobileNavigation}</div></header></div>`);
  const footer = htmlBlock(`<footer data-lulu-global="footer" data-lulu-design-source="custom-bolt-forge" style="width:100%;max-width:none;margin:0;background:${escapeWordpressHtml(secondary)};color:#fff;font-family:Barlow,'Helvetica Neue',Arial,sans-serif"><div style="display:grid;max-width:1280px;margin:0 auto;padding:56px 16px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:40px"><div style="grid-column:span 2"><div style="display:flex;align-items:center;gap:12px"><span aria-hidden="true" style="display:grid;width:36px;height:36px;place-items:center;background:${escapeWordpressHtml(primary)};color:#fff;font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:19px;font-weight:700">${escapeWordpressHtml(initial)}</span><strong style="font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-size:22px">${escapeWordpressHtml(siteTitle)}</strong></div>${description ? `<p style="max-width:430px;margin:16px 0 0;color:#bdc8d0;font-size:14px;line-height:1.7">${escapeWordpressHtml(description)}</p>` : ''}</div><div><p style="margin:0 0 16px;color:#aeb9c1;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase">Navigation</p><nav aria-label="Footer navigation" style="display:flex;align-items:flex-start;gap:10px;flex-direction:column">${footerLinks}</nav></div><div><p style="margin:0 0 16px;color:#aeb9c1;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase">${escapeWordpressHtml(contactLabel)}</p><a href="${escapeWordpressHtml(contactHref)}" style="display:inline-flex;min-height:42px;align-items:center;justify-content:center;padding:11px 17px;background:${escapeWordpressHtml(primary)};border:1px solid ${escapeWordpressHtml(primary)};color:#fff;font-size:14px;font-weight:700;text-decoration:none">${escapeWordpressHtml(contactLabel)}</a></div></div><div style="max-width:1280px;margin:0 auto;padding:20px 16px;border-top:1px solid rgba(255,255,255,.16);color:#aeb9c1;font-size:13px">© ${new Date().getFullYear()} ${escapeWordpressHtml(siteTitle)}</div></footer>`);
  return { header, footer, siteTitle, description };
}

export function wordpressTemplatePartForArea(parts: unknown[], area: 'header' | 'footer', activeTheme: string | null) {
  const candidates = parts.map(objectValue).filter((part) => String(part.area ?? '').toLowerCase() === area);
  if (!candidates.length) return null;
  if (activeTheme) {
    const normalizedTheme = activeTheme.toLowerCase();
    const active = candidates.find((part) => {
      const theme = String(part.theme ?? '').toLowerCase();
      return theme === normalizedTheme || theme.endsWith(`/${normalizedTheme}`) || normalizedTheme.endsWith(`/${theme}`);
    });
    if (active) return active;
  }
  return candidates[0] ?? null;
}

function wordpressTemplatePartsForArea(parts: unknown[], area: 'header' | 'footer', activeTheme: string | null) {
  const candidates = parts.map(objectValue).filter((part) => String(part.area ?? '').toLowerCase() === area);
  if (!activeTheme) return candidates;
  const normalizedTheme = activeTheme.toLowerCase();
  const active = candidates.filter((part) => {
    const theme = String(part.theme ?? '').toLowerCase();
    return theme === normalizedTheme || theme.endsWith(`/${normalizedTheme}`) || normalizedTheme.endsWith(`/${theme}`);
  });
  return active.length ? active : candidates;
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
  const storedSiteCustomization = objectValue(storedSetup.siteCustomization);
  const expectedHomepageId = Number(storedHomepage.pageId ?? 0);
  const actualMode = String(wordpressOption(details, 'show_on_front') ?? '').trim().toLowerCase();
  const actualHomepageId = Number(wordpressOption(details, 'page_on_front') ?? 0);
  const homepageConfigured = expectedHomepageId > 0 && actualMode === 'page' && actualHomepageId === expectedHomepageId;
  const deliveryCapabilities = wordpressDeliveryCapabilities(details);
  const activeTheme = wordpressActiveTheme(details);
  const themeActive = Boolean(activeTheme && (activeTheme === WORDPRESS_THEME_KEY || activeTheme.endsWith(`/${WORDPRESS_THEME_KEY}`)));
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
    ...storedTheme,
    status: themeActive ? 'active' : 'not_required',
    activeTheme,
    deliveryMode: 'gutenberg',
    installationAvailable: deliveryCapabilities.canInstallThemes,
    adminUrl: null,
    downloadPath: null,
    reason: themeActive ? null : 'theme_independent_gutenberg_delivery',
    checkedAt: new Date().toISOString(),
  };
  const setup = { homepage, theme, siteCustomization: storedSiteCustomization, capabilities: deliveryCapabilities };
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
        deliveryMode: 'gutenberg',
        deliveryCapabilities,
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
  const desiredSlug = String(page.slug ?? '').trim().toLowerCase();
  const desiredTitle = String(page.title ?? '').trim().toLowerCase();
  const exactSlug = existingPages.find((candidate: any) => {
    const candidateSlug = String(candidate.slug ?? '').trim().toLowerCase();
    const status = String(candidate.status ?? '').trim().toLowerCase();
    return desiredSlug && candidateSlug === desiredSlug && status !== 'trash';
  });
  if (exactSlug) return exactSlug;
  if (targetMode === 'new') return undefined;
  return existingPages.find((candidate: any) => String(candidate.title ?? '').trim().toLowerCase() === desiredTitle && String(candidate.status ?? '').trim().toLowerCase() !== 'trash');
}

async function assertPublishingNotCancelled(siteId: string, jobId: string) {
  const current = await repo.getJob(siteId, jobId);
  if (current?.status === 'cancelled') {
    throw new AppError(409, 'WEBSITE_GENERATION_CANCELLED', 'Website generation was cancelled by the user');
  }
  return current;
}

async function customizeWordpressSite(input: {
  workspaceId: string;
  externalSiteId: string;
  siteUrl: string;
  plan: unknown;
  existingPages: unknown[];
  publishedPages: unknown[];
  activeTheme: string | null;
  homepageId: string;
  previousHomepageId: string;
  homepageConfigured: boolean;
  targetMode: WebsiteGenerationTargetMode;
}) {
  const plan = objectValue(input.plan);
  const chrome = wordpressSiteChrome(plan, input.publishedPages, input.siteUrl);
  const result: Record<string, any> = {
    status: 'confirmed',
    siteIdentity: { status: 'pending' },
    header: { status: 'pending' },
    footer: { status: 'pending' },
    duplicatePages: { status: 'pending', archived: [] },
    contactForm: { status: String(JSON.stringify(plan.pages ?? '')).includes('[contact-form') ? 'confirmed' : 'missing' },
    ctaLinks: { status: 'confirmed' },
    checkedAt: new Date().toISOString(),
  };
  if (input.targetMode === 'existing') {
    return {
      ...result,
      status: result.contactForm.status === 'confirmed' ? 'confirmed' : 'partial',
      mode: 'content_only',
      siteIdentity: { status: 'preserved' },
      header: { status: 'preserved' },
      footer: { status: 'preserved' },
      duplicatePages: { status: 'preserved', archived: [] },
      warnings: result.contactForm.status === 'confirmed' ? [] : ['The generated contact form was not confirmed in the website plan'],
    };
  }
  result.mode = 'full_site';
  const warnings: string[] = [];

  try {
    await updateWordpressSiteIdentity(input.workspaceId, input.externalSiteId, { title: chrome.siteTitle, description: chrome.description });
    result.siteIdentity = { status: 'confirmed', title: chrome.siteTitle, description: chrome.description };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);
    result.siteIdentity = { status: 'failed', message };
  }

  try {
    const parts = await wordpressTemplateParts(input.workspaceId, input.externalSiteId);
    for (const area of ['header', 'footer'] as const) {
      const areaParts = wordpressTemplatePartsForArea(parts, area, input.activeTheme);
      const partIds = areaParts.map((part) => String(part.id ?? '')).filter(Boolean);
      if (!partIds.length) {
        result[area] = { status: 'not_supported', message: `No writable ${area} template part was exposed by WordPress` };
        warnings.push(`WordPress did not expose a writable ${area} template part`);
        continue;
      }
      const updatedPartIds: string[] = [];
      const partErrors: string[] = [];
      for (const partId of partIds) {
        try {
          await updateWordpressTemplatePart(input.workspaceId, input.externalSiteId, partId, chrome[area]);
          updatedPartIds.push(partId);
        } catch (error) {
          partErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (partErrors.length) warnings.push(...partErrors);
      result[area] = updatedPartIds.length === partIds.length
        ? { status: 'confirmed', partIds: updatedPartIds }
        : { status: updatedPartIds.length ? 'partial' : 'failed', partIds: updatedPartIds, errors: partErrors };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);
    result.header = { status: 'not_supported', message };
    result.footer = { status: 'not_supported', message };
  }

  const protectedHomepageId = input.homepageConfigured ? input.homepageId : input.previousHomepageId;
  const duplicatePages = findWordpressDuplicatePages(input.existingPages, input.publishedPages)
    .filter((page) => String(page.ID ?? page.id ?? '') !== protectedHomepageId);
  const archived: Array<{ id: string; title: string; slug: string }> = [];
  const cleanupErrors: string[] = [];
  for (const page of duplicatePages) {
    const id = String(page.ID ?? page.id ?? '');
    if (!id) continue;
    try {
      await setWordpressPageStatus(input.workspaceId, input.externalSiteId, id, 'draft');
      archived.push({ id, title: String(page.title ?? ''), slug: String(page.slug ?? '') });
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (cleanupErrors.length) {
    warnings.push(...cleanupErrors);
    result.duplicatePages = { status: 'partial', archived, errors: cleanupErrors };
  } else {
    result.duplicatePages = { status: 'confirmed', archived };
  }
  if (result.contactForm.status !== 'confirmed') warnings.push('The generated contact form was not confirmed in the website plan');
  result.status = warnings.length ? 'partial' : 'confirmed';
  result.warnings = warnings;
  result.checkedAt = new Date().toISOString();
  return result;
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
      let wordpressDetails: unknown = {};
      try {
        wordpressDetails = await wordpressSiteDetails(workspaceId, externalSiteId);
      } catch (capabilityInspectionError) {
        logger.warn({ jobId, siteId, externalSiteId, error: capabilityInspectionError instanceof Error ? capabilityInspectionError.message : String(capabilityInspectionError) }, 'WordPress delivery capabilities could not be inspected; theme-independent publishing will continue');
      }
      const deliveryCapabilities = wordpressDeliveryCapabilities(wordpressDetails);
      const previousHomepageId = String(wordpressOption(wordpressDetails, 'page_on_front') ?? '');
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
        const gutenbergContent = wordpressGutenbergContent(page);
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
          const draft = await withProviderConnectionError(workspaceId, 'wordpress', () => createWordpressPage(workspaceId, externalSiteId, { title: page.title, ...(desiredSlug ? { slug: desiredSlug } : {}), content: gutenbergContent, seoTitle: page.seoTitle, seoDescription: page.seoDescription, menuOrder: pageIndex + 1, status: 'draft' }));
          pageId = draft.ID ?? draft.id;
          if (!pageId) throw new AppError(502, 'WORDPRESS_CREATE_UNCONFIRMED', 'WordPress did not return an ID for the created page', { provider: 'wordpress', providerResult: draft });
          published = draft;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 750));
          published = await withProviderConnectionError(workspaceId, 'wordpress', () => updateWordpressPage(workspaceId, externalSiteId, String(pageId), { title: page.title, ...(desiredSlug ? { slug: desiredSlug } : {}), content: gutenbergContent, seoDescription: page.seoDescription, menuOrder: pageIndex + 1, status: 'draft' }));
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
        await recordPublishedPage({ id: pageId, url: String(publishedUrl), title: String(page.title ?? ''), slug: desiredSlug, status: 'published', deliveryMode: 'gutenberg', reused: Boolean(existing), publishedAt: new Date().toISOString() }, pageIndex + 1, plannedPages[pageIndex + 1]?.title ? String(plannedPages[pageIndex + 1].title) : null);
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
      const activeTheme = wordpressActiveTheme(wordpressDetails);
      await updatePublishingProgress('customizing_site', plannedPages.length, null, 98, { id: 'site-customization-started', code: 'site_customization_started', tone: 'info', params: {} });
      const siteCustomization = await customizeWordpressSite({
        workspaceId,
        externalSiteId,
        siteUrl: site.externalSiteUrl ?? String(createdPages[0]?.url ?? ''),
        plan,
        existingPages,
        publishedPages: createdPages,
        activeTheme,
        homepageId,
        previousHomepageId,
        homepageConfigured,
        targetMode,
      });
      const themeActive = Boolean(activeTheme && (activeTheme === WORDPRESS_THEME_KEY || activeTheme.endsWith(`/${WORDPRESS_THEME_KEY}`)));
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
        status: themeActive ? 'active' : 'not_required',
        activeTheme,
        deliveryMode: 'gutenberg',
        installationAvailable: deliveryCapabilities.canInstallThemes,
        adminUrl: null,
        downloadPath: null,
        reason: themeActive ? null : 'theme_independent_gutenberg_delivery',
      };
      const customizationWarning = siteCustomization.status === 'partial'
        ? 'The generated pages are live, but WordPress did not allow every global site customization. The confirmed changes remain saved.'
        : undefined;
      const setupWarning = homepageWarning ?? customizationWarning;
      const beforePublished = await repo.getJob(siteId, jobId);
      let finalPreview = beforePublished?.preview ?? job.preview;
      finalPreview = appendGenerationActivity(finalPreview, { id: 'gutenberg-layout-published', code: 'gutenberg_layout_published', tone: 'success', params: { pages: createdPages.length } });
      if (siteCustomization.siteIdentity?.status === 'confirmed') finalPreview = appendGenerationActivity(finalPreview, { id: 'site-identity-configured', code: 'site_identity_configured', tone: 'success', params: { title: String(siteCustomization.siteIdentity.title ?? '') } });
      if (siteCustomization.header?.status === 'confirmed' && siteCustomization.footer?.status === 'confirmed') finalPreview = appendGenerationActivity(finalPreview, { id: 'global-chrome-configured', code: 'global_chrome_configured', tone: 'success', params: {} });
      if (siteCustomization.contactForm?.status === 'confirmed') finalPreview = appendGenerationActivity(finalPreview, { id: 'contact-form-embedded', code: 'contact_form_embedded', tone: 'success', params: {} });
      if (Array.isArray(siteCustomization.duplicatePages?.archived) && siteCustomization.duplicatePages.archived.length) finalPreview = appendGenerationActivity(finalPreview, { id: 'duplicate-pages-archived', code: 'duplicate_pages_archived', tone: 'success', params: { pages: siteCustomization.duplicatePages.archived.length } });
      if (customizationWarning) finalPreview = appendGenerationActivity(finalPreview, { id: 'site-customization-partial', code: 'site_customization_partial', tone: 'warning', params: {} });
      if (homepageWarning) {
        finalPreview = appendGenerationActivity(finalPreview, { id: 'homepage-action-required', code: 'homepage_action_required', tone: 'warning', params: { page: String(createdPages[0]?.title ?? 'Home') } });
      }
      await repo.updateSiteSettings(workspaceId, siteId, { wordpressSetup: { homepage: homepageSetup, theme: themeSetup, siteCustomization, capabilities: deliveryCapabilities, updatedAt: new Date().toISOString() } }).catch((settingsError) => {
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
        providerResult: { provider: 'wordpress', targetMode, templateKey: plan?.templateKey ?? null, designSource: plan?.designSource ?? null, deliveryMode: 'gutenberg', deliveryCapabilities, siteCustomization, partial: false, pages: createdPages, homepageId, homepageConfigured, homepageSetup, themeSetup, ...(homepageWarning ? { homepageWarning } : {}), ...(customizationWarning ? { customizationWarning } : {}) },
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
