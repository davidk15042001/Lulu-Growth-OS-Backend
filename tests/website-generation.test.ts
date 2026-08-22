import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCompleteWebsitePlan } from '../src/modules/websites/website.generation.service.js';

function pageContent(length: number) {
  return `<main><h1>Eine klare Überschrift</h1><section><p>${'Relevanter, überprüfter Inhalt für die Zielgruppe. '.repeat(length)}</p></section></main>`;
}

function planWith(content: string) {
  return {
    siteTitle: 'Lulu Test',
    brandVoice: 'Klar und hilfreich',
    primaryLanguage: 'de',
    pages: [{
      title: 'Startseite',
      slug: 'startseite',
      purpose: 'Das Angebot verständlich erklären',
      sections: ['Einführung', 'Vorteile'],
      content,
      seoTitle: 'Lulu Test',
      seoDescription: 'Eine überprüfte Beschreibung.',
    }],
    globalSeo: { title: 'Lulu Test', description: 'Beschreibung', keywords: [] },
    assets: [],
  };
}

describe('website generation quality gate', () => {
  it('accepts substantive semantic page content', () => {
    assert.equal(isCompleteWebsitePlan(planWith(pageContent(40))), true);
  });

  it('rejects short output and placeholder content', () => {
    assert.equal(isCompleteWebsitePlan(planWith('<main><h1>Kurz</h1></main>')), false);
    assert.equal(isCompleteWebsitePlan(planWith(`${pageContent(40)}<p>hello world</p>`)), false);
  });
});
