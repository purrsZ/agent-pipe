import type { Clock } from './types.js';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
