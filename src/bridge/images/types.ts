export interface MessageAttachment {
  kind: 'image';
  mimeType: string;
  fileId?: string;
  fileName?: string;
  caption?: string;
}

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface PreparedPrompt {
  prompt: string;
  images?: PromptImage[];
}

export interface DownloadedAttachment {
  bytes: Buffer;
  mimeType: string;
}
