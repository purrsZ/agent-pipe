import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
