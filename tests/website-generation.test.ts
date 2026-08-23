import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCompleteWebsitePlan } from '../src/modules/websites/website.generation.service.js';
import { appendGenerationActivity, generationActivities } from '../src/modules/websites/website.activity.js';

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
