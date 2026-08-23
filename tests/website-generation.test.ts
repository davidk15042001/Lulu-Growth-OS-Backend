import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCompleteWebsitePlan, renderHome, websiteCtaDestination, wordpressContactFormShortcode } from '../src/modules/websites/website.generation.service.js';
import { appendGenerationActivity, generationActivities } from '../src/modules/websites/website.activity.js';
import { automaticGenerationSchema } from '../src/modules/websites/website.validator.js';
import { completedWordpressPages, findReusableWordpressPage, findWordpressDuplicatePages, isLuluGeneratedWordpressPage, wordpressActiveTheme, wordpressAdminUrl, wordpressDeliveryCapabilities, wordpressGutenbergContent, wordpressHomepageWarning, wordpressOption, wordpressSiteChrome, wordpressTemplatePartForArea } from '../src/modules/websites/website.publish.service.js';
import { AppError } from '../src/utils/app-error.js';

function pageContent(length: number) {
  return `<main data-lulu-template="lulu-standard-v1" data-lulu-design-source="custom-bolt-forge" data-lulu-design-version="2026-08-23"><h1>Eine klare Überschrift</h1><section><p>${'Relevanter, überprüfter Inhalt für die Zielgruppe. '.repeat(length)}</p></section></main>`;
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
    designSource: 'custom-bolt-forge',
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
    assert.equal(isCompleteWebsitePlan(planWith(pageContent(55).replace('data-lulu-design-version="2026-08-23"', 'data-lulu-design-version="legacy"'))), false);
  });

  it('maps generated CTA labels to deterministic destinations and builds a real contact form', () => {
    assert.equal(websiteCtaDestination('Explore our services', '/contact/'), '/services/');
    assert.equal(websiteCtaDestination('Contact us', '/services/'), '/contact/');
    assert.equal(websiteCtaDestination('Kontakt aufnehmen', '/services/'), '/contact/');
    const form = wordpressContactFormShortcode('de', "Lulu's Company");
    assert.match(form, /^\[contact-form/);
    assert.match(form, /type='email' required='1'/);
    assert.match(form, /type='textarea' required='1'/);
    assert.doesNotMatch(form, /Lulu's/);
  });

  it('renders the fixed Custom Bolt Forge visual structure independently from AI copy', () => {
    const cards = [{ title: 'Solution', description: 'Verified solution details for the intended audience.', cta: 'Learn more' }];
    const profile = {
      siteTitle: 'Acme AI', tagline: 'Verified business software', brandVoice: 'Clear', primaryLanguage: 'en', globalSeo: { title: 'Acme AI', description: 'Verified business software', keywords: [] },
      home: {
        eyebrow: 'Business software', headline: 'A clear business headline', introduction: 'Verified introduction for the intended customer audience.', primaryCta: 'Contact us', secondaryCta: 'Explore services', trustItems: ['B2B', 'Software', 'Support'], audienceHeading: 'What do you need?', audienceIntroduction: 'Choose the most relevant route.', audienceCards: cards, servicesHeading: 'Services', servicesIntroduction: 'Verified services.', featureEyebrow: 'Core strengths', featureHeading: 'Built for real requirements', featureIntroduction: 'Focused delivery.', featureCards: cards, highlightEyebrow: 'Why choose us', highlightTitle: 'A focused partner', highlightText: 'Verified differentiation.', splitEyebrow: 'Delivery', splitTitle: 'How we support your goals', splitText: 'Verified delivery model.', splitItems: ['Discovery', 'Delivery', 'Support'], processHeading: 'How we work', processIntroduction: 'A clear process.', processSteps: [{ title: 'Understand', description: 'Review the requirements.' }], capabilityHeading: 'Capability and quality', capabilityIntroduction: 'Reliable delivery.', capabilityCards: cards, faqHeading: 'Questions', faqs: [{ question: 'How do we start?', answer: 'Contact the team.' }, { question: 'Who is this for?', answer: 'Business customers.' }], finalCtaTitle: 'Ready to start?', finalCtaText: 'Start a focused conversation.', finalCtaLabel: 'Contact us',
      },
      about: { title: 'About', introduction: 'About Acme.', sections: [{ heading: 'Focus', body: 'Verified focus.' }], ctaTitle: 'Talk to us', ctaText: 'Contact Acme.', ctaLabel: 'Contact us' },
      services: { title: 'Services', introduction: 'Verified services.', items: cards, processHeading: 'Process', processSteps: [{ title: 'Understand', description: 'Review requirements.' }], ctaTitle: 'Find the right solution', ctaText: 'Share your requirements.', ctaLabel: 'Contact us' },
      contact: { title: 'Contact Acme', introduction: 'Share your requirements.', preparationHeading: 'Helpful information', preparationItems: ['Requirement', 'Timing'], nextStepTitle: 'What happens next', nextStepText: 'The team reviews the request.' },
    } as any;
    const palette = { primary: '#183c65', secondary: '#303740', accent: '#e89110', ink: '#233142', muted: '#657283', surface: '#ffffff', background: '#f4f6f8' };
    const rendered = renderHome(profile, palette, []);
    const html = `${rendered.openingHtml}${rendered.sections.map((section) => section.html).join('')}${rendered.closingHtml}`;
    assert.match(html, /data-lulu-design-source="custom-bolt-forge"/);
    assert.match(html, /data-lulu-design-version="2026-08-23"/);
    assert.match(html, /max-width:1280px/);
    assert.match(html, /Barlow Condensed/);
    assert.deepEqual(rendered.sections.map((section) => section.key), ['hero', 'trust', 'buyer-routing', 'portfolio', 'core-strengths', 'differentiator', 'split-feature', 'process', 'capabilities', 'business-call-to-action', 'request-form', 'faq', 'call-to-action']);
    assert.equal(new Set(rendered.sections.map((section) => section.key)).size, rendered.sections.length);
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

  it('reuses canonical WordPress slugs in both modes without overwriting unrelated pages by title', () => {
    const pages = [{ ID: 42, slug: 'home', title: 'Home' }];
    assert.equal(findReusableWordpressPage(pages, { slug: 'home', title: 'Home' }, 'existing')?.ID, 42);
    assert.equal(findReusableWordpressPage(pages, { slug: 'home', title: 'Home' }, 'new')?.ID, 42);
    assert.equal(findReusableWordpressPage([{ ID: 44, slug: 'welcome', title: 'Home' }], { slug: 'home', title: 'Home' }, 'new'), undefined);
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

  it('never assumes theme installation rights and detects explicit WordPress capabilities', () => {
    const standard = wordpressDeliveryCapabilities({ capabilities: { edit_posts: true, publish_posts: true }, is_fse_active: true });
    assert.deepEqual({ ...standard, checkedAt: '<timestamp>' }, {
      deliveryMode: 'gutenberg',
      canEditContent: true,
      canPublishContent: true,
      canManageHomepage: false,
      canInstallThemes: false,
      fullSiteEditing: true,
      userCanManage: false,
      isWordpressComAtomic: false,
      planSlug: null,
      checkedAt: '<timestamp>',
    });
    assert.match(standard.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    const elevated = wordpressDeliveryCapabilities({ capabilities: { edit_theme_options: '1', install_themes: true }, user_can_manage: true, plan: { product_slug: 'personal-bundle' } });
    assert.equal(elevated.canManageHomepage, true);
    assert.equal(elevated.canInstallThemes, true);
    assert.equal(elevated.userCanManage, true);
    assert.equal(elevated.planSlug, 'personal-bundle');
  });

  it('serializes generated sections as theme-independent Gutenberg blocks', () => {
    const content = wordpressGutenbergContent({
      content: '<main data-lulu-template="lulu-standard-v1"><section>Fallback</section></main>',
      generatedSections: [
        { key: 'hero', title: 'Hero', html: '<section data-lulu-section="hero"><h1>Hello</h1></section>' },
        { key: 'services', title: 'Services', html: '<section data-lulu-section="services"><p>Service</p></section>' },
      ],
    });
    assert.match(content, /<!-- wp:group/);
    assert.equal((content.match(/<!-- wp:html -->/g) ?? []).length, 2);
    assert.match(content, /class="wp-block-group alignfull lulu-generated-page"/);
    assert.doesNotMatch(content, /<main\b/i);
  });

  it('replaces the visual form preview with a native WordPress shortcode block when publishing', () => {
    const content = wordpressGutenbergContent({
      generatedSections: [{
        key: 'contact-form',
        html: '<section><form data-lulu-contact-form-preview><input disabled></form><template data-lulu-contact-form-shortcode>[contact-form]&amp;[/contact-form]</template></section>',
      }],
    });
    assert.match(content, /<!-- wp:shortcode -->/);
    assert.match(content, /\[contact-form\]&\[\/contact-form\]/);
    assert.match(content, /<section>\s*<!-- \/wp:html -->[\s\S]*<!-- wp:shortcode -->[\s\S]*<!-- wp:html -->\s*<\/section>/);
    assert.doesNotMatch(content, /data-lulu-contact-form-preview|data-lulu-contact-form-shortcode/);
  });

  it('identifies only recoverable Lulu duplicates and excludes the active canonical pages', () => {
    const generated = (id: number, slug: string, status = 'publish') => ({ ID: id, slug, status, content: '<main data-lulu-template="lulu-standard-v1"><section data-lulu-section="hero">Lulu</section></main>' });
    const duplicates = findWordpressDuplicatePages([
      generated(1, 'home'),
      generated(2, 'home-2'),
      generated(3, 'about-3'),
      { ID: 4, slug: 'about', status: 'publish', content: '<p>Customer-owned page</p>' },
      generated(5, 'services-2', 'draft'),
    ], [{ id: 1, slug: 'home' }, { id: 9, slug: 'about' }, { id: 10, slug: 'services' }]);
    assert.deepEqual(duplicates.map((page) => page.ID), [2, 3]);
    assert.equal(isLuluGeneratedWordpressPage(duplicates[0]), true);
    assert.equal(isLuluGeneratedWordpressPage({ content: '<p>Normal page</p>' }), false);
  });

  it('builds verified global site chrome without WordPress placeholders', () => {
    const chrome = wordpressSiteChrome({
      siteTitle: 'Acme AI',
      palette: { secondary: '#111827', accent: '#22c55e' },
      globalSeo: { description: 'Verified AI services.' },
      pages: [
        { title: 'Home', slug: 'home' },
        { title: 'Services', slug: 'services' },
        { title: 'Contact', slug: 'contact' },
      ],
    }, [
      { slug: 'home', url: 'https://example.com/home/' },
      { slug: 'services', url: 'https://example.com/services/' },
      { slug: 'contact', url: 'https://example.com/contact/' },
    ], 'https://example.com/');
    assert.match(chrome.header, /data-lulu-global="header"/);
    assert.match(chrome.footer, /data-lulu-global="footer"/);
    assert.match(chrome.header, /data-lulu-design-source="custom-bolt-forge"/);
    assert.match(chrome.header, /position:sticky/);
    assert.match(chrome.header, /max-width:1280px/);
    assert.match(chrome.footer, /Barlow/);
    assert.match(chrome.header, /https:\/\/example\.com\/services\//);
    assert.doesNotMatch(`${chrome.header}${chrome.footer}`, /123 Example Street|hi@example\.com/i);
    assert.equal(wordpressTemplatePartForArea([{ id: 'old//header', area: 'header', theme: 'old' }, { id: 'active//header', area: 'header', theme: 'pub/active' }], 'header', 'pub/active')?.id, 'active//header');
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
