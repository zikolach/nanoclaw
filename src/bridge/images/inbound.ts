import { Channel, NewMessage } from '../../types.js';
import { formatMessages } from '../../router.js';
import { DownloadedAttachment, PreparedPrompt } from './types.js';
import {
  assertImageSizeWithinLimit,
  assertSupportedImageMimeType,
} from './validation.js';

function extractLatestImageMessage(
  messages: NewMessage[],
): { message: NewMessage; attachmentIndex: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const attachments = messages[i].attachments;
    if (!attachments) continue;
    const attachmentIndex = attachments.findIndex((a) => a.kind === 'image');
    if (attachmentIndex !== -1) {
      return { message: messages[i], attachmentIndex };
    }
  }
  return undefined;
}

export async function preparePromptWithImages(
  messages: NewMessage[],
  timezone: string,
  channel: Channel,
): Promise<PreparedPrompt> {
  const prompt = formatMessages(messages, timezone);
  const latestImage = extractLatestImageMessage(messages);
  if (!latestImage || !channel.downloadAttachment) {
    return { prompt };
  }

  const attachment =
    latestImage.message.attachments![latestImage.attachmentIndex];
  const downloaded = (await channel.downloadAttachment(
    latestImage.message,
    attachment,
  )) as DownloadedAttachment;

  assertSupportedImageMimeType(downloaded.mimeType);
  assertImageSizeWithinLimit(downloaded.bytes.byteLength);

  return {
    prompt:
      latestImage.message.content.trim() &&
      latestImage.message.content !== '[Photo]'
        ? prompt
        : `${prompt}\n\nPlease describe this image.`,
    images: [
      {
        type: 'image',
        data: downloaded.bytes.toString('base64'),
        mimeType: downloaded.mimeType,
      },
    ],
  };
}
