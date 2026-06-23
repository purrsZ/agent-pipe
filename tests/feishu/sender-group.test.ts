import { describe, expect, it, vi } from 'vitest';
import { Sender } from '../../src/feishu/sender.js';

// Sender.createGroup（立项建群能力，M-I2）：假 client 验证两步调用与失败兜底；真建群=live（需 im:chat scope）。

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
function fakeClient(chat: unknown, members: unknown) {
  return { im: { chat: { create: chat }, chatMembers: { create: members } } };
}

describe('Sender.createGroup', () => {
  it('建群 + 拉人成功 → 返回 chatId，两步参数正确', async () => {
    const chatCreate = vi.fn().mockResolvedValue({ data: { chat_id: 'oc_123' } });
    const membersCreate = vi.fn().mockResolvedValue({ data: {} });
    const sender = new Sender(fakeClient(chatCreate, membersCreate) as never, logger() as never);

    const chatId = await sender.createGroup('需求群', ['ou_a', 'ou_b']);
    expect(chatId).toBe('oc_123');
    expect(chatCreate).toHaveBeenCalledWith({ data: { name: '需求群', chat_mode: 'group' } });
    expect(membersCreate).toHaveBeenCalledWith({
      path: { chat_id: 'oc_123' },
      params: { member_id_type: 'open_id' },
      data: { id_list: ['ou_a', 'ou_b'] },
    });
  });

  it('建群失败（如 im:chat scope 未授 → 401）→ 返回 null，不拉人', async () => {
    const chatCreate = vi.fn().mockRejectedValue(new Error('401'));
    const membersCreate = vi.fn();
    const sender = new Sender(fakeClient(chatCreate, membersCreate) as never, logger() as never);

    expect(await sender.createGroup('群', ['ou_a'])).toBeNull();
    expect(membersCreate).not.toHaveBeenCalled();
  });

  it('拉人失败不致命 → 群已建好，仍返回 chatId（发起人可自加）', async () => {
    const chatCreate = vi.fn().mockResolvedValue({ data: { chat_id: 'oc_x' } });
    const membersCreate = vi.fn().mockRejectedValue(new Error('member fail'));
    const sender = new Sender(fakeClient(chatCreate, membersCreate) as never, logger() as never);

    expect(await sender.createGroup('群', ['ou_a'])).toBe('oc_x');
  });

  it('无成员 → 只建群，不调 chatMembers；建群无 chat_id → null', async () => {
    const membersCreate = vi.fn();
    const okSender = new Sender(
      fakeClient(vi.fn().mockResolvedValue({ data: { chat_id: 'oc_y' } }), membersCreate) as never,
      logger() as never,
    );
    expect(await okSender.createGroup('群', [])).toBe('oc_y');
    expect(membersCreate).not.toHaveBeenCalled();

    const noIdSender = new Sender(
      fakeClient(vi.fn().mockResolvedValue({ data: {} }), membersCreate) as never,
      logger() as never,
    );
    expect(await noIdSender.createGroup('群', ['ou_a'])).toBeNull();
  });
});
