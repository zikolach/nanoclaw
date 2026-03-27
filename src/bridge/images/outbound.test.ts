import { describe, expect, it } from 'vitest';

import { mapPiContentToImageOperations } from './outbound.js';

describe('mapPiContentToImageOperations', () => {
  it('maps image content and uses first text block as caption', () => {
    const operations = mapPiContentToImageOperations([
      { type: 'text', text: 'caption here' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'text', text: 'extra text' },
    ]);

    expect(operations).toEqual([
      {
        kind: 'image',
        data: 'abc',
        mimeType: 'image/png',
        caption: 'caption here',
      },
    ]);
  });
});
