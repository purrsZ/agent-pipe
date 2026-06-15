import { describe, expect, it } from 'vitest';
import { WorkTypeAlreadyRegisteredError, WorkTypeRegistry } from '../../src/workitems/registry.js';
import type { WorkType } from '../../src/workitems/types.js';

function workType(id: string): WorkType {
  return {
    id,
    triggers: { api: true },
    initialPhase: () => 'initial',
    onEvent: () => ({}),
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

describe('WorkTypeRegistry', () => {
  it('registers and returns the same WorkType instance by id', () => {
    const registry = new WorkTypeRegistry();
    const type = workType('noop');

    registry.register(type);

    expect(registry.get('noop')).toBe(type);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('rejects duplicate WorkType ids', () => {
    const registry = new WorkTypeRegistry();
    registry.register(workType('noop'));

    expect(() => registry.register(workType('noop'))).toThrow(WorkTypeAlreadyRegisteredError);
  });
});
