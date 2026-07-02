import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

let tmpDir: string;
let store: Store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-thread-claims-'));
  store = new Store(path.join(tmpDir, 'db.sqlite'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('thread claims registry (WI-D)', () => {
  it('claim / get / release roundtrip', () => {
    store.claimThread('root-1', 'managed', 'owner-123');
    const c = store.getThreadClaim('root-1');
    expect(c?.owner_kind).toBe('managed');
    expect(c?.owner_id).toBe('owner-123');
    store.releaseThreadClaim('root-1');
    expect(store.getThreadClaim('root-1')).toBeUndefined();
  });

  it('re-claim overwrites the previous owner (upsert)', () => {
    store.claimThread('root-2', 'bridge', 'task-a');
    store.claimThread('root-2', 'managed', 'owner-9');
    const c = store.getThreadClaim('root-2');
    expect(c?.owner_kind).toBe('managed');
    expect(c?.owner_id).toBe('owner-9');
  });

  it('unclaimed root returns undefined', () => {
    expect(store.getThreadClaim('never-claimed')).toBeUndefined();
  });

  it('release of an unclaimed root is a no-op (no throw)', () => {
    expect(() => store.releaseThreadClaim('nope')).not.toThrow();
  });

  it('getThreadRootByOwner reverse-looks-up the managed claim (M1b WI-6)', () => {
    store.claimThread('anchor-1', 'managed', 'wi-1');
    expect(store.getThreadRootByOwner('wi-1')).toBe('anchor-1');
    expect(store.getThreadRootByOwner('wi-missing')).toBeUndefined();
  });

  it('getThreadRootByOwner ignores bridge claims', () => {
    store.claimThread('root-b', 'bridge', 'task-x');
    expect(store.getThreadRootByOwner('task-x')).toBeUndefined();
  });

  // WI-8: the real-bot串台 bug — the claim must key on the thread root (the user's /probe
  // message), while the anchor card lives at a DIFFERENT message id. Both round-trip apart.
  it('WI-8: stores anchor_msg_id apart from the thread-root key', () => {
    const threadRoot = 'om_user_probe_msg';
    const anchor = 'om_anchor_card_msg';
    store.claimThread(threadRoot, 'managed', 'wi-7', anchor);

    // routing + report replies key on the thread root, NOT the anchor card
    const c = store.getThreadClaim(threadRoot);
    expect(c?.owner_id).toBe('wi-7');
    expect(c?.anchor_msg_id).toBe(anchor);
    expect(store.getThreadClaim(anchor)).toBeUndefined();

    // reverse lookups: root for replyCard, anchor for updateCard
    expect(store.getThreadRootByOwner('wi-7')).toBe(threadRoot);
    expect(store.getThreadAnchorByOwner('wi-7')).toBe(anchor);
  });

  it('WI-8: anchor_msg_id defaults to null when omitted', () => {
    store.claimThread('root-x', 'managed', 'wi-8');
    expect(store.getThreadClaim('root-x')?.anchor_msg_id).toBeNull();
    expect(store.getThreadAnchorByOwner('wi-8')).toBeUndefined();
  });

  it('WI-8: getThreadAnchorByOwner ignores bridge claims', () => {
    store.claimThread('root-bridge', 'bridge', 'task-y', 'anchor-y');
    expect(store.getThreadAnchorByOwner('task-y')).toBeUndefined();
  });

  // WS-4: 断线补拉需要「managed 认领过哪些 chat」——claimThread 记 chat_id，listManagedClaimChatIds
  // 给出去重后的 managed chat 列表（bridge 认领与空 chat 不计入）。
  it('WS-4: stores chat_id and lists distinct managed chat ids', () => {
    store.claimThread('root-1', 'managed', 'wi-1', null, 'oc_chat_1');
    store.claimThread('root-2', 'managed', 'wi-2', null, 'oc_chat_1'); // 同 chat 去重
    store.claimThread('root-3', 'managed', 'wi-3', null, 'oc_chat_2');
    store.claimThread('root-b', 'bridge', 'task-x', null, 'oc_bridge'); // bridge 不计入
    expect(store.getThreadClaim('root-1')?.chat_id).toBe('oc_chat_1');
    expect([...store.listManagedClaimChatIds()].sort()).toEqual(['oc_chat_1', 'oc_chat_2']);
  });

  it('WS-4: chat_id defaults to null and null chats are excluded from the managed list', () => {
    store.claimThread('root-x', 'managed', 'wi-x'); // 无 chat_id
    expect(store.getThreadClaim('root-x')?.chat_id).toBeNull();
    expect(store.listManagedClaimChatIds()).toEqual([]);
  });

  // C7（审查）：记 chat_type，断线补拉据此把 p2p 会话正确还原（否则默认 group + 无 @ 被群门丢）。
  it('WS-4: stores chat_type and looks it up by chat_id for backfill', () => {
    store.claimThread('root-dm', 'managed', 'wi-1', null, 'oc_dm', 'p2p');
    store.claimThread('root-grp', 'managed', 'wi-2', null, 'oc_grp', 'group');
    expect(store.getThreadClaim('root-dm')?.chat_type).toBe('p2p');
    expect(store.managedChatType('oc_dm')).toBe('p2p');
    expect(store.managedChatType('oc_grp')).toBe('group');
    expect(store.managedChatType('oc_unknown')).toBeUndefined();
  });
});
