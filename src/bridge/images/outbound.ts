type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };

export interface OutboundImageOperation {
  kind: 'image';
  data: string;
  mimeType: string;
  caption?: string;
}

export function mapPiContentToImageOperations(
  content: Array<TextContent | ImageContent>,
): OutboundImageOperation[] {
  const textBlocks = content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean);
  const caption = textBlocks[0] || undefined;

  return content
    .filter((block): block is ImageContent => block.type === 'image')
    .map((block) => ({
      kind: 'image' as const,
      data: block.data,
      mimeType: block.mimeType,
      caption,
    }));
}
