import type { WorkType } from './types.js';

export class WorkTypeAlreadyRegisteredError extends Error {
  constructor(id: string) {
    super(`WorkType already registered: ${id}`);
    this.name = 'WorkTypeAlreadyRegisteredError';
  }
}

export class WorkTypeRegistry {
  private readonly types = new Map<string, WorkType>();

  register(type: WorkType): void {
    if (this.types.has(type.id)) {
      throw new WorkTypeAlreadyRegisteredError(type.id);
    }
    this.types.set(type.id, type);
  }

  get(id: string): WorkType | undefined {
    return this.types.get(id);
  }
}
