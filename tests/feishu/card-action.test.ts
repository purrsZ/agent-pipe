import { describe, expect, it } from 'vitest';
import { parseCardAction } from '../../src/feishu/event-router.js';

describe('parseCardAction (R06: opaque value pass-through)', () => {
  it('extracts the neutral fields and passes value through untouched', () => {
    const value = {
      workitemId: 'wi-1',
      checkpoint: 'requirement:合同',
      decision: { approved: true },
    };
    const action = parseCardAction({
      action: { value },
      operator: { open_id: 'ou_x' },
      token: 'tok-1',
      open_message_id: 'om_1',
    });
    expect(action).not.toBeNull();
    // value is forwarded as-is; the kernel never reads inside it.
    expect(action!.value).toBe(value);
    expect(action!.operatorId).toBe('ou_x');
    expect(action!.token).toBe('tok-1');
    expect(action!.messageId).toBe('om_1');
  });

  it('falls back to operator_id and message_id field names', () => {
    const action = parseCardAction({
      action: { value: 'v' },
      operator: { operator_id: 'ou_y' },
      message_id: 'm_2',
    });
    expect(action!.operatorId).toBe('ou_y');
    expect(action!.messageId).toBe('m_2');
  });

  it('returns null for a non-object payload', () => {
    expect(parseCardAction(null)).toBeNull();
    expect(parseCardAction('nope')).toBeNull();
  });
});
