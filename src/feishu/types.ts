export interface MentionInfo {
  openId: string;
  name: string;
}

export interface Attachment {
  kind: 'file' | 'image';
  fileKey: string;
  name: string;
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  userId: string;
  text: string;
  parentId?: string;
  rootId?: string;
  isMentioned: boolean;
  mentions: MentionInfo[];
  attachments: Attachment[];
  createTime: number;
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;
