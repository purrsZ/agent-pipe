export class TypeNotRegisteredError extends Error {
  constructor(type: string) {
    super(`WorkType is not registered: ${type}`);
    this.name = 'TypeNotRegisteredError';
  }
}

export class OpenLimitError extends Error {
  constructor(limit: number) {
    super(`已达并行上限，请先收尾（maxOpen=${limit}）`);
    this.name = 'OpenLimitError';
  }
}

export class TimerNotResolvableError extends Error {
  constructor(waitId: string) {
    super(`Timer wait cannot be resolved manually: ${waitId}`);
    this.name = 'TimerNotResolvableError';
  }
}
