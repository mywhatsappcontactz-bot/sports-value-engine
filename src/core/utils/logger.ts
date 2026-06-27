// src/core/utils/logger.ts
import winston from 'winston';
import path from 'path';
import fs from 'fs';

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const isDev = process.env.NODE_ENV !== 'production';

const cliFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? `\n  ${JSON.stringify(meta, null, 2)}`
      : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  transports: [
    // Error log
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
    }),
    // Combined log
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // Console - dev only, CLI friendly
    ...(isDev && process.env.CLI_SILENT !== 'true'
  ? [new winston.transports.Console({ format: cliFormat })]
  : []
),
  ],
});

// Correlation ID support for tracing bet decisions
export function logWithCorrelation(
  correlationId: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  meta?: Record<string, unknown>
): void {
  logger[level](message, { correlationId, ...meta });
}