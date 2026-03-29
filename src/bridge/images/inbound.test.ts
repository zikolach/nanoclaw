import { describe, expect, it, vi } from 'vitest';

import { preparePromptWithImages } from './inbound.js';
import type { Channel, NewMessage } from '../../types.js';

function createChannel(): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    downloadAttachment: vi.fn(async () => ({
      bytes: Buffer.from('image-bytes'),
      mimeType: 'image/jpeg',
    })),
  };
}

describe('preparePromptWithImages', () => {
  it('returns text-only prompt when there are no attachments', async () => {
    const channel = createChannel();
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ];

    const result = await preparePromptWithImages(messages, 'UTC', channel);
    expect(result.images).toBeUndefined();
    expect(result.prompt).toContain('hello');
  });

  it('adds image payload and fallback prompt for placeholder-only photo', async () => {
    const channel = createChannel();
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: '[Photo]',
        timestamp: '2024-01-01T00:00:00.000Z',
        attachments: [
          {
            kind: 'image',
            mimeType: 'image/jpeg',
            fileId: 'abc',
          },
        ],
      },
    ];

    const result = await preparePromptWithImages(messages, 'UTC', channel);
    expect(result.images).toEqual([
      {
        type: 'image',
        data: Buffer.from('image-bytes').toString('base64'),
        mimeType: 'image/jpeg',
      },
    ]);
    expect(result.prompt).toContain('Please describe this image.');
  });
});
