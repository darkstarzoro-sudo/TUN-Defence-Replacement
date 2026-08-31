// ============================================================
// src/utils/logger.js — Handles all logging (console + files)
// ============================================================

const { createLogger, format, transports } = require('winston');
const path = require('path');

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return stack
        ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
        : `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    // Print to the terminal
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
    // Save all logs to a file
    new transports.File({
      filename: path.join(__dirname, '../../logs/bot.log'),
      maxsize: 5 * 1024 * 1024, // 5MB max per file
      maxFiles: 5,
    }),
    // Save only errors to a separate file
    new transports.File({
      filename: path.join(__dirname, '../../logs/errors.log'),
      level: 'error',
    }),
  ],
});

module.exports = logger;
