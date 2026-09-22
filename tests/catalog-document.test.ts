import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogImageDataToPng, catalogTextBlocks } from '../src/modules/onboarding/catalog-document.service.js';

describe('catalog PDF image evidence', () => {
  it('encodes decoded PDF RGBA data as a bounded PNG asset', () => {
    const width = 32;
    const height = 32;
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 24;
      data[index + 1] = 180;
      data[index + 2] = 120;
      data[index + 3] = 255;
    }
    const result = catalogImageDataToPng({ width, height, data });
    assert.ok(result);
    assert.deepEqual([...result.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(result.byteLength > 80);
  });

  it('does not accept malformed or tiny PDF image objects as product evidence', () => {
    assert.equal(catalogImageDataToPng({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }), null);
    assert.equal(catalogImageDataToPng({ width: 32, height: 32, data: new Uint8Array(32) }), null);
  });

  it('keeps bounded text geometry for source-page review', () => {
    const blocks = catalogTextBlocks({ items: [
      { str: '  Green screw  ', transform: [1, 0, 0, 12, 48, 720], width: 84, height: 12 },
      { str: '5 cm', transform: [1, 0, 0, 12, 48, 700], width: 24, height: 12 },
      { str: '', transform: [1, 0, 0, 12, 48, 680], width: 24, height: 12 },
    ] });
    assert.deepEqual(blocks, [
      { text: 'Green screw', x: 48, y: 720, width: 84, height: 12 },
      { text: '5 cm', x: 48, y: 700, width: 24, height: 12 },
    ]);
  });
});
