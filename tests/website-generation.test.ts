import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCompleteWebsitePlan } from '../src/modules/websites/website.generation.service.js';
import { appendGenerationActivity, generationActivities } from '../src/modules/websites/website.activity.js';
import { automaticGenerationSchema } from '../src/modules/websites/website.validator.js';
import { completedWordpressPages, findReusableWordpressPage, wordpressActiveTheme, wordpressAdminUrl, wordpressHomepageWarning, wordpressOption } from '../src/modules/websites/website.publish.service.js';
import { AppError } from '../src/utils/app-error.js';

function pageContent(length: number) {
  return `<main data-lulu-template="lulu-standard-v1"><h1>Eine klare Überschrift</h1><section><p>${'Relevanter, überprüfter Inhalt für die Zielgruppe. '.repeat(length)}</p></section></main>`;
}

function planWith(content: string) {
  const page = (slug: string) => ({
    title: slug === 'home' ? 'Home' : slug,
    slug,
    purpose: 'Das Angebot verständlich erklären',
    sections: ['Einführung', 'Vorteile'],
    content,
    seoTitle: 'Lulu Test',
    seoDescription: 'Eine überprüfte Beschreibung.',
  });
  return {
    templateKey: 'lulu-standard-v1',
    siteTitle: 'Lulu Test',
    brandVoice: 'Klar und hilfreich',
    primaryLanguage: 'de',
    palette: { primary: '#183c65', secondary: '#303740', accent: '#e89110', ink: '#233142', muted: '#657283', surface: '#ffffff', background: '#f4f6f8' },
    contentProfile: {},
    pages: ['home', 'about', 'services', 'contact'].map(page),
    globalSeo: { title: 'Lulu Test', description: 'Beschreibung', keywords: [] },
    assets: [],
  };
}

describe('website generation quality gate', () => {
  it('accepts substantive semantic page content', () => {
    assert.equal(isCompleteWebsitePlan(planWith(pageContent(55))), true);
  });

  it('rejects short output and placeholder content', () => {
    assert.equal(isCompleteWebsitePlan(planWith('<main><h1>Kurz</h1></main>')), false);
    assert.equal(isCompleteWebsitePlan(planWith(`${pageContent(55)}<p>hello world</p>`)), false);
  });
});

describe('website generation activity log', () => {
  it('persists structured events and deduplicates retries by stable id', () => {
    const event = { id: 'section-saved:home:hero', code: 'section_saved', tone: 'success' as const, params: { page: 'Home', section: 'Hero' }, createdAt: '2026-08-23T14:30:00.000Z' };
    const first = appendGenerationActivity({}, event);
    const retried = appendGenerationActivity(first, { ...event, createdAt: '2026-08-23T14:31:00.000Z' });
    const activities = generationActivities(retried);
    assert.equal(activities.length, 1);
    assert.deepEqual(activities[0], event);
  });
});

describe('website generation target selection', () => {
  const siteId = '5895ec11-4459-4645-ac91-2380d083f758';

  it('requires an explicit existing-or-new decision', () => {
    assert.equal(automaticGenerationSchema.safeParse({ provider: 'wordpress', siteId }).success, false);
    assert.equal(automaticGenerationSchema.safeParse({ provider: 'wordpress', siteId, targetMode: 'existing' }).success, true);
    assert.equal(automaticGenerationSchema.safeParse({ provider: 'wordpress', siteId, targetMode: 'new' }).success, true);
  });

  it('rejects unsupported target modes', () => {
    assert.equal(automaticGenerationSchema.safeParse({ provider: 'wordpress', siteId, targetMode: 'overwrite' }).success, false);
  });

  it('reuses matching WordPress pages only in existing mode', () => {
    const pages = [{ ID: 42, slug: 'home', title: 'Home' }];
    assert.equal(findReusableWordpressPage(pages, { slug: 'home', title: 'Home' }, 'existing')?.ID, 42);
    assert.equal(findReusableWordpressPage(pages, { slug: 'home', title: 'Home' }, 'new'), undefined);
  });
});

describe('WordPress completion setup', () => {
  it('builds safe WordPress dashboard links without keeping unrelated query data', () => {
    assert.equal(wordpressAdminUrl('https://example.wordpress.com/home/?preview=1', '/wp-admin/options-reading.php'), 'https://example.wordpress.com/wp-admin/options-reading.php');
    assert.equal(wordpressAdminUrl(null, '/wp-admin/options-reading.php'), null);
    assert.equal(wordpressAdminUrl('not a url', '/wp-admin/options-reading.php'), null);
    assert.equal(wordpressAdminUrl('javascript:alert(1)', '/wp-admin/options-reading.php'), null);
  });

  it('recognizes Lulu Base from WordPress site options', () => {
    assert.equal(wordpressActiveTheme({ options: { stylesheet: 'lulu-base' } }), 'lulu-base');
    assert.equal(wordpressActiveTheme({ options: { theme_slug: 'pub/twentytwentyfive' } }), 'pub/twentytwentyfive');
    assert.equal(wordpressActiveTheme({}), null);
  });

  it('recovers only failed jobs with a complete set of confirmed WordPress pages', () => {
    const plan = { pages: [{ slug: 'home', title: 'Home' }, { slug: 'contact', title: 'Contact' }] };
    const pages = [
      { id: 10, slug: 'home', title: 'Home', url: 'https://example.com/' },
      { id: 11, slug: 'contact', title: 'Contact', url: 'https://example.com/contact/' },
    ];
    assert.equal(completedWordpressPages({ status: 'published', plan, providerResult: { pages } }), null);
    assert.equal(completedWordpressPages({ status: 'failed', plan, providerResult: { pages: pages.slice(0, 1) } }), null);
    assert.deepEqual(completedWordpressPages({ status: 'failed', plan, providerResult: { pages } }), pages);
  });

  it('normalizes wrapped WordPress option values used for verification', () => {
    assert.equal(wordpressOption({ options: { show_on_front: { value: 'page' }, page_on_front: 6 } }, 'show_on_front'), 'page');
    assert.equal(wordpressOption({ options: { show_on_front: { value: 'page' }, page_on_front: 6 } }, 'page_on_front'), 6);
  });

  it('turns an ignored homepage setting into an actionable completion warning', () => {
    const warning = wordpressHomepageWarning(new AppError(502, 'WORDPRESS_HOMEPAGE_CONFIGURATION_FAILED', 'WordPress did not confirm the generated page as the homepage'));
    assert.equal(warning.errorCode, 'WORDPRESS_HOMEPAGE_CONFIGURATION_FAILED');
    assert.match(warning.message, /published/i);
    assert.match(warning.message, /Reading settings/i);
  });
});
