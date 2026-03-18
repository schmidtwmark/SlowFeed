import winston from 'winston';
import Transport from 'winston-transport';

// In-memory log storage for the web UI
interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

const MAX_LOG_ENTRIES = 500;
const logBuffer: LogEntry[] = [];

// Custom transport to store logs in memory
class MemoryTransport extends Transport {
  log(info: { timestamp?: string; level: string; message: string }, callback: () => void): void {
    setImmediate(() => {
      logBuffer.push({
        timestamp: info.timestamp || new Date().toISOString(),
        level: info.level.replace(/\u001b\[\d+m/g, ''), // Strip ANSI color codes
        message: String(info.message),
      });

      // Keep buffer size limited
      while (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
      }
    });

    callback();
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      const msg = `${timestamp} [${level.toUpperCase()}] ${message}`;
      return stack ? `${msg}\n${stack}` : msg;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, stack }) => {
          const msg = `${timestamp} [${level}] ${message}`;
          return stack ? `${msg}\n${stack}` : msg;
        })
      ),
    }),
    new MemoryTransport({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return JSON.stringify({ timestamp, level, message });
        })
      ),
    }),
  ],
});

// Export function to get logs for the web UI
export function getLogs(limit?: number): LogEntry[] {
  if (limit && limit < logBuffer.length) {
    return logBuffer.slice(-limit);
  }
  return [...logBuffer];
}

// Export function to clear logs
export function clearLogs(): void {
  logBuffer.length = 0;
}
