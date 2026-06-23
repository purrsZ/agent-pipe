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
  /** 飞书原生话题 id（消息在话题中时由事件携带）。spike：用于把 probe 收进一个话题。 */
  threadId?: string;
  isMentioned: boolean;
  mentions: MentionInfo[];
  attachments: Attachment[];
  createTime: number;
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

/**
 * A card button callback, delivered over the existing ws connection (R06/D-12 — no HTTP
 * endpoint). The kernel treats `value` as an OPAQUE payload and never interprets its
 * contents (the upper adapter decodes it); keeping it `unknown` here is what holds the
 * kernel red-line (no business vocabulary leaks into feishu).
 */
export interface CardAction {
  value: unknown;
  operatorId: string;
  token?: string;
  messageId?: string;
  /**
   * Form-submit values keyed by each component's `name` (AskUserQuestion 表单卡 only).
   * MUST stay optional: button-callback cards (e.g. checkpoint 灯卡) carry no form_value, so
   * their parse/handle path is untouched.
   */
  formValue?: Record<string, unknown>;
}

export type CardActionHandler = (action: CardAction) => void | Promise<void>;
