import { createServer } from 'node:http';
import { renderHome } from '../src/modules/websites/website.generation.service.js';
import { wordpressSiteChrome } from '../src/modules/websites/website.publish.service.js';

const port = Number(process.env.TEMPLATE_PREVIEW_PORT ?? 4174);
const cards = [
  { title: 'AI Operations', description: 'Automate recurring work with verified workflows and clear human oversight.', cta: 'Explore services' },
  { title: 'Business Intelligence', description: 'Turn connected business information into focused, actionable insight.', cta: 'Learn more' },
  { title: 'Growth Systems', description: 'Build a reliable operating system for acquisition, delivery and support.', cta: 'Explore services' },
  { title: 'Expert Guidance', description: 'Clarify requirements and choose a practical next step with the team.', cta: 'Contact us' },
];
const profile = {
  siteTitle: 'Hongkong Lulu Development Limited', tagline: 'AI-powered software for business growth', brandVoice: 'Clear', primaryLanguage: 'en',
  globalSeo: { title: 'Lulu AI', description: 'AI-powered software and operating systems for ambitious businesses.', keywords: [] },
  home: {
    eyebrow: 'AI SOFTWARE · AUTOMATION · GROWTH', headline: 'Build a Smarter Business with AI', introduction: 'Lulu brings your website, operations and customer workflows together in one focused AI platform.', primaryCta: 'Start a conversation', secondaryCta: 'Explore our services', trustItems: ['AI software', 'Business automation', 'Connected workflows', 'Human oversight', 'Growth systems'],
    audienceHeading: 'What Do You Need?', audienceIntroduction: 'Choose the route that best matches your current business priority.', audienceCards: cards,
    servicesHeading: 'AI Solutions for Modern Businesses', servicesIntroduction: 'A structured portfolio covering customer experience, automation, insight and digital growth.',
    featureEyebrow: 'Core strengths', featureHeading: 'Built for Real Business Requirements', featureIntroduction: 'A reliable foundation for teams that need clarity, speed and control.', featureCards: cards.slice(0, 3),
    highlightEyebrow: 'Why choose us', highlightTitle: 'Focused on Practical AI Innovation', highlightText: 'Technology is only valuable when it produces a clear business outcome. Lulu combines connected data, structured workflows and understandable automation.',
    splitEyebrow: 'Focused delivery', splitTitle: 'From Company Context to a Working System', splitText: 'Verified company information drives the content and configuration while the reference design remains consistent.', splitItems: ['Verified company data', 'Structured implementation', 'Responsive design', 'SEO foundation', 'Connected customer journey', 'Clear next steps'],
    processHeading: 'How We Work', processIntroduction: 'A straightforward process keeps every requirement and decision transparent.', processSteps: [{ title: 'Discover', description: 'Understand the company and its audience.' }, { title: 'Structure', description: 'Organize content into the fixed reference layout.' }, { title: 'Publish', description: 'Create and verify every WordPress page.' }],
    capabilityHeading: 'Capability and Quality', capabilityIntroduction: 'A production-ready approach to layout, publishing and customer experience.', capabilityCards: cards.slice(0, 2),
    faqHeading: 'Products & Business Questions', faqs: [{ question: 'How does the website stay consistent?', answer: 'The design structure is fixed and only verified content changes.' }, { question: 'Can the website use existing images?', answer: 'Available WordPress media can be placed into the defined image areas.' }, { question: 'What happens after publishing?', answer: 'Lulu verifies the pages, homepage, navigation and global site elements.' }],
    finalCtaTitle: 'Ready to Build Your AI Growth System?', finalCtaText: 'Share your business requirements and move forward with a clear next step.', finalCtaLabel: 'Contact us',
  },
  about: { title: 'About Lulu', introduction: 'AI software for business growth.', sections: [{ heading: 'Focused delivery', body: 'Clear systems for real requirements.' }], ctaTitle: 'Talk to us', ctaText: 'Share your requirements.', ctaLabel: 'Contact us' },
  services: { title: 'Services', introduction: 'AI services.', items: cards, processHeading: 'Process', processSteps: [{ title: 'Discover', description: 'Review requirements.' }], ctaTitle: 'Find the Right Solution', ctaText: 'Share your requirements and receive a focused response.', ctaLabel: 'Contact us' },
  contact: { title: 'Submit Your Requirement', introduction: 'Send your goals and requirements to the Lulu team.', preparationHeading: 'Helpful Information to Include', preparationItems: ['Your current priority', 'The desired outcome', 'Timing and constraints', 'Relevant systems or files'], nextStepTitle: 'What Happens Next', nextStepText: 'The team reviews the request and confirms the next step.' },
} as any;
const palette = { primary: '#1d4ed8', secondary: '#1e1b4b', accent: '#06b6d4', ink: '#172554', muted: '#65718c', surface: '#ffffff', background: '#eff6ff' };
const rendered = renderHome(profile, palette, []);
const content = `${rendered.openingHtml}${rendered.sections.map((section) => section.html).join('')}${rendered.closingHtml}`;
const pageDefinitions = [{ title: 'Home', slug: 'home' }, { title: 'About', slug: 'about' }, { title: 'Services', slug: 'services' }, { title: 'Contact', slug: 'contact' }];
const publishedPages = pageDefinitions.map((page, index) => ({ ...page, url: index ? `http://127.0.0.1:${port}/${page.slug}/` : `http://127.0.0.1:${port}/` }));
const chrome = wordpressSiteChrome({ siteTitle: profile.siteTitle, palette, globalSeo: profile.globalSeo, contentProfile: profile, pages: pageDefinitions }, publishedPages, `http://127.0.0.1:${port}/`);
const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WordPress template preview</title><style>*{box-sizing:border-box}body{margin:0}h1,h2,h3,p{overflow-wrap:anywhere}input,textarea{width:100%;font:inherit}</style></head><body>${chrome.header}${content}${chrome.footer}</body></html>`;

createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(request.url?.startsWith('/mobile')
    ? `<!doctype html><html><head><meta charset="utf-8"><title>Mobile WordPress template preview</title><style>body{margin:0;padding:24px;background:#e5e7eb}iframe{display:block;width:390px;height:844px;margin:auto;border:0;background:#fff;box-shadow:0 20px 50px #0003}</style></head><body><iframe title="Mobile template" src="/"></iframe></body></html>`
    : document);
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`WordPress template preview: http://127.0.0.1:${port}/\n`);
});
