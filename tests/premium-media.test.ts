import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPremiumVideoModels, normalizeKieTask } from '../src/modules/premium-media/kie-media.client.js';
import { buildPremiumImagePrompt, buildPremiumVideoPrompt, marketVideoParameters } from '../src/modules/premium-media/premium-media.service.js';
import { createPremiumMediaSchema } from '../src/modules/premium-media/premium-media.validator.js';

const product = {
  name: 'Lulu One',
  shortDescription: 'A precision-built product',
  longDescription: null,
};

describe('premium media production', () => {
  it('normalizes successful Kie tasks and preserves exact metering data', () => {
    const task = normalizeKieTask({
      code: 200,
      data: {
        taskId: 'task-premium-1',
        successFlag: 1,
        creditsConsumed: 84.25,
        resultJson: JSON.stringify({ resultUrls: ['https://file.aiquickdraw.com/result.png'] }),
      },
    });
    assert.equal(task.state, 'success');
    assert.equal(task.taskId, 'task-premium-1');
    assert.equal(task.creditsConsumed, 84.25);
    assert.deepEqual(task.resultUrls, ['https://file.aiquickdraw.com/result.png']);
  });

  it('normalizes provider failures without accepting an empty result', () => {
    const task = normalizeKieTask({ data: { task_id: 'failed-1', successFlag: 2, failCode: 'CONTENT_FAILED', failMsg: 'Generation failed' } });
    assert.equal(task.state, 'failed');
    assert.equal(task.errorCode, 'CONTENT_FAILED');
    assert.deepEqual(task.resultUrls, []);
  });

  it('builds product-identity preserving image and video briefs', () => {
    const image = buildPremiumImagePrompt(product, 'Minimal obsidian studio', 'Correct label alignment');
    const video = buildPremiumVideoPrompt(product);
    assert.match(image, /absolute source of truth/i);
    assert.match(image, /Correct label alignment/);
    assert.match(video, /remain visually identical in every frame/i);
    assert.match(video, /No morphing, flicker, warped text/i);
  });

  it('creates a strict premium identity brief for new text-only product concepts', () => {
    const image = buildPremiumImagePrompt(product, null, null, false);
    assert.match(image, /one definitive, physically plausible product identity/i);
    assert.match(image, /Do not invent logos, brand marks, label copy/i);
    assert.doesNotMatch(image, /supplied product photographs/i);
  });

  it('uses the supported Kling V3 Turbo image-to-video contract', () => {
    assert.ok(getPremiumVideoModels().includes('kling/v3-turbo-image-to-video'));
    assert.deepEqual(
      marketVideoParameters('kling/v3-turbo-image-to-video', 'Premium movement', 'https://example.test/product.png', '16:9'),
      {
        image_urls: ['https://example.test/product.png'],
        prompt: 'Premium movement',
        duration: '5',
        resolution: '720p',
      },
    );
  });

  it('defaults to both premium deliverables and blocks insecure references', () => {
    const defaults = createPremiumMediaSchema.parse({});
    assert.equal(defaults.deliverImage, true);
    assert.equal(defaults.deliverVideo, true);
    assert.throws(() => createPremiumMediaSchema.parse({ referenceImageUrls: ['http://example.test/product.png'] }));
    assert.throws(() => createPremiumMediaSchema.parse({ deliverImage: false, deliverVideo: false }));
  });
});
