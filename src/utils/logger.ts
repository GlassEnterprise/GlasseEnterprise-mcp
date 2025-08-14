import winston from "winston";

export class Logger {
  private logger: winston.Logger;

  constructor(scope: string) {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf((info: any) => {
          const { level, message, timestamp, ...meta } = info;
          const metaStr =
            meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
          return `[${timestamp}] [${scope}] ${level}: ${message}${metaStr}`;
        })
      ),
      transports: [new winston.transports.Console()],
    });
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.logger.info(message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.logger.warn(message, meta);
  }

  error(message: string, error?: unknown) {
    if (error instanceof Error) {
      this.logger.error(`${message} - ${error.message}`, {
        stack: error.stack,
      });
    } else {
      this.logger.error(message, { error });
    }
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.logger.debug(message, meta);
  }

  logPerformance(operation: string, ms: number) {
    this.info(`Performance: ${operation} took ${ms}ms`);
  }
}
