import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import type {
  Attachment,
  CardAction,
  CardActionHandler,
  IncomingMessage,
  MessageHandler,
} from './types.js';

const DEDUP_TTL_MS = 600_000;

/**
 * Pull the neutral fields out of a raw card-action event. The button `value` is passed
 * through untouched (opaque) — the kernel never reads inside it (R06.AC-2 red-line).
 */
export function parseCardAction(data: unknown): CardAction | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const action = (d.action ?? {}) as Record<string, unknown>;
  const operator = (d.operator ?? {}) as Record<string, unknown>;
  // WS card.action.trigger nests the message/chat ids under `context`; older/HTTP shapes put
  // them at the top level. Read context first, then fall back to the flat names — otherwise
  // messageId comes back empty and a downstream reply hits `/messages//reply` → 404.
  const context = (d.context ?? {}) as Record<string, unknown>;
  const operatorId =
    typeof operator.open_id === 'string'
      ? operator.open_id
      : typeof operator.operator_id === 'string'
        ? operator.operator_id
        : '';
  const pick = (...vals: unknown[]): string | undefined =>
    vals.find((v): v is string => typeof v === 'string' && v !== '');
  // Form submits carry per-component values under action.form_value (some shapes top-level).
  // Optional — button-callback cards (checkpoint) have none, so this is undefined for them and
  // their handler path is unchanged.
  const rawForm = (action.form_value ?? d.form_value) as unknown;
  const formValue =
    rawForm && typeof rawForm === 'object' ? (rawForm as Record<string, unknown>) : undefined;
  return {
    value: action.value,
    operatorId,
    token: typeof d.token === 'string' ? d.token : undefined,
    messageId: pick(context.open_message_id, d.open_message_id, d.message_id),
    formValue,
  };
}

/**
 * 把飞书富文本（post）消息正文拍平成纯文本。受信 post 一般是 {title, content:[[{tag,text/href}]]}；
 * 防御性兼容语言键包裹 {zh_cn:{...}} 形态。text 段取文字、链接(a)取「文字（URL）」，@/图片等忽略。
 * 永不抛：坏结构当空内容。让群里粘带格式/文档链接的收料消息也能进（否则 post 类型被入站直接丢弃）。
 */
export function extractPostText(raw: any): string {
  const post =
    raw && typeof raw === 'object'
      ? Array.isArray(raw.content) || typeof raw.title === 'string'
        ? raw
        : (raw.zh_cn ?? raw.en_us ?? {})
      : {};
  const title = typeof post.title === 'string' ? post.title.trim() : '';
  const body = Array.isArray(post.content) ? post.content : [];
  const lines: string[] = [];
  for (const para of body) {
    if (!Array.isArray(para)) continue;
    const parts: string[] = [];
    for (const el of para) {
      if (!el || typeof el !== 'object') continue;
      if (el.tag === 'text' && typeof el.text === 'string') parts.push(el.text);
      else if (el.tag === 'a') {
        const t = typeof el.text === 'string' ? el.text : '';
        const href = typeof el.href === 'string' ? el.href : '';
        parts.push(t && href ? `${t}（${href}）` : t || href);
      }
    }
    if (parts.length > 0) lines.push(parts.join(''));
  }
  return [title, ...lines].filter((s) => s.length > 0).join('\n');
}

/**
 * WS-4：把「原始飞书 data → IncomingMessage」的解析抽成导出纯函数，im.message.receive_v1（推送）与
 * 断线补拉（im.message.list 拉回、经 {@link adaptListMessageToEventData} 拍成同形状）共用一份，避免两份漂移。
 * 只负责解析，不含 botStartTime 时间门与去重（那是 dispatcher/补拉各自的策略）。永不抛：坏结构 → null。
 */
export function parseIncomingMessage(data: unknown, botOpenId: string): IncomingMessage | null {
  try {
    const d = data as any;
    const message = d?.message;
    const sender = d?.sender;
    if (!message || !sender) return null;

    // C1（审查）：message_id/chat_id/create_time 是 inbox 落库的必填键。缺 id 或 create_time 非数字 →
    // 若放行会撞 inbox 的 NOT NULL 约束被 INSERT OR IGNORE 静默吞成「重复」永久丢。这里当无效消息 → null。
    const createTime = Number.parseInt(message.create_time, 10);
    if (!message.message_id || !message.chat_id || !Number.isFinite(createTime)) return null;

    const chatType = message.chat_type as 'p2p' | 'group';
    if (chatType !== 'p2p' && chatType !== 'group') return null;
    const msgType = message.message_type as string;
    if (msgType !== 'text' && msgType !== 'post' && msgType !== 'file' && msgType !== 'image')
      return null;

    const rawMentions = (message.mentions ?? []) as Array<{
      id?: { open_id?: string };
      name?: string;
    }>;
    let isMentioned = chatType === 'p2p';
    if (chatType === 'group' && botOpenId) {
      isMentioned = rawMentions.some((m) => m.id?.open_id === botOpenId);
    }
    const mentions = rawMentions
      .filter((m) => m.id?.open_id && m.id.open_id !== botOpenId)
      .map((m) => ({ openId: m.id!.open_id!, name: m.name ?? '' }));

    const content = JSON.parse(message.content);
    let text = '';
    const attachments: Attachment[] = [];

    if (msgType === 'text') {
      text = (content.text ?? '').replace(/@_user_\w+/g, '').trim();
      if (!text) return null;
    } else if (msgType === 'post') {
      // 富文本（post）：拍平正文为纯文本（含链接 URL），让群里粘带格式/文档链接的收料也能进。
      text = extractPostText(content)
        .replace(/@_user_\w+/g, '')
        .trim();
      if (!text) return null;
    } else if (msgType === 'file') {
      const fk = content.file_key;
      if (!fk) return null;
      attachments.push({
        kind: 'file',
        fileKey: fk,
        name: content.file_name ?? `file-${message.message_id}`,
      });
    } else if (msgType === 'image') {
      const ik = content.image_key;
      if (!ik) return null;
      attachments.push({ kind: 'image', fileKey: ik, name: `image-${message.message_id}.png` });
    }

    return {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType,
      userId: sender.sender_id?.open_id ?? '',
      text,
      parentId: message.parent_id || undefined,
      rootId: message.root_id || undefined,
      threadId: message.thread_id || undefined,
      isMentioned,
      mentions,
      attachments,
      createTime,
    };
  } catch {
    // JSON.parse / 字段异常一律吞成 null（对齐 extractPostText 的「永不抛」风格）。
    return null;
  }
}

/**
 * WS-4：把 im.message.list 返回的历史消息 item 拍成 im.message.receive_v1 的 data 形状，供
 * {@link parseIncomingMessage} 复用同一解析。两者字段有差异：list 用 msg_type / body.content /
 * sender.id（字符串 open_id）/ mention.id（字符串），推送用 message_type / content / sender.sender_id.open_id /
 * mention.id.open_id。list item 不带 chat_type，调用方（backfill）按 thread_claims 记录的 chat_type 显式传入
 * （C7 审查修复：p2p managed 会话若默认 group + 无 @ 会被 handleIncoming 群门丢弃）；缺省仍按 'group'。
 */
export function adaptListMessageToEventData(
  rawItem: unknown,
  chatType: 'p2p' | 'group' = 'group',
): unknown {
  const it = (rawItem ?? {}) as any;
  const rawMentions = Array.isArray(it.mentions) ? it.mentions : [];
  return {
    message: {
      message_id: it.message_id,
      chat_id: it.chat_id,
      chat_type: it.chat_type ?? chatType,
      message_type: it.msg_type,
      content: it.body?.content ?? '{}',
      create_time: String(it.create_time ?? ''),
      parent_id: it.parent_id ?? '',
      root_id: it.root_id ?? '',
      thread_id: it.thread_id ?? '',
      mentions: rawMentions.map((m: any) => ({
        id: { open_id: typeof m?.id === 'string' ? m.id : m?.id?.open_id },
        name: m?.name ?? '',
      })),
    },
    sender: { sender_id: { open_id: it.sender?.id ?? '' } },
  };
}

/** WS-4：补拉时跳过 bot/app 自己发的消息（app 发的 sender_type='app'，或 sender.id 就是 bot 自身）。 */
export function isBotBackfillMessage(rawItem: unknown, botOpenId: string): boolean {
  const s = ((rawItem as any)?.sender ?? {}) as { id?: string; sender_type?: string };
  return s.sender_type === 'app' || (typeof s.id === 'string' && s.id === botOpenId);
}

export function createDispatcher(
  botOpenId: string,
  logger: Logger,
  botStartTime: number,
  onMessage: MessageHandler,
  onCardAction?: CardActionHandler,
): lark.EventDispatcher {
  const seen = new Set<string>();

  return new lark.EventDispatcher({}).register({
    // R06/D-12: card button callbacks ride the same ws connection. Ack with a fast toast
    // (≤3s requirement) and run the real action async — the upper adapter decodes value.
    'card.action.trigger': async (data: any) => {
      try {
        const action = parseCardAction(data);
        if (action && onCardAction) {
          // 卡回调有 3s 超时。点「立项完成/灯卡拍板」会同步触发落立项书 + 建 worktree 等 git 操作，
          // 可能 >3s 阻塞事件循环 → 飞书「目标回调服务超时未响应」。把实际处理推到下一轮 event loop，
          // 让本函数立刻返回 toast（动作照常执行，只是不再卡回调响应）。
          setImmediate(() => {
            Promise.resolve(onCardAction(action)).catch((err) => {
              logger.error({ err }, 'card action handler error');
            });
          });
        }
      } catch (err) {
        logger.error({ err }, 'card action dispatch error');
      }
      return { toast: { type: 'info', content: '已收到，处理中…' } };
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data?.message;
        if (!message) return;

        // 策略门（留在 dispatcher，不进纯解析）：createTime < botStartTime 丢历史消息；进程内 seen
        // 去重（10min 滑窗）。持久 inbox（WS-4）在 onMessage 里做权威去重，这里是快路径。
        const createTime = Number.parseInt(message.create_time, 10);
        if (createTime && createTime < botStartTime) return;

        const msgId = String(message.message_id);
        if (seen.has(msgId)) return;
        seen.add(msgId);
        setTimeout(() => seen.delete(msgId), DEDUP_TTL_MS);

        const incoming = parseIncomingMessage(data, botOpenId);
        if (!incoming) return;

        Promise.resolve(onMessage(incoming)).catch((err) => {
          logger.error({ err }, 'message handler error');
        });
      } catch (err) {
        logger.error({ err }, 'event dispatch error');
      }
    },
  } as any);
}
