const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function assertSupportedImageMimeType(mimeType: string): void {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image mime type: ${mimeType}`);
  }
}

export function assertImageSizeWithinLimit(byteLength: number): void {
  if (byteLength <= 0) {
    throw new Error('Image payload is empty');
  }
  if (byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image payload too large: ${byteLength} bytes (limit ${MAX_IMAGE_BYTES})`,
    );
  }
}
