import winston from 'winston';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

/** Console: readable + coloured (what you watch in the terminal). File: JSON lines in logs/ (rotated). */
export const log = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(errors({ stack: true }), timestamp({ format: 'HH:mm:ss' })),
  transports: [
    new winston.transports.Console({
      format: combine(colorize({ level: true }), printf(({ timestamp: t, level, message, stack }) => `${t} ${level} ${stack ?? message}`)),
    }),
    new winston.transports.File({ filename: 'logs/void.log', maxsize: 5_000_000, maxFiles: 5, tailable: true, format: combine(timestamp(), json()) }),
  ],
});
