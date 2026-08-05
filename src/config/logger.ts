import pino from 'pino';
import pinoHttpPkg from 'pino-http';
import { env, isProd } from './env.js';

const pinoHttp = (pinoHttpPkg as any).default ?? (pinoHttpPkg as any);

const isServerless = !!process.env.VERCEL;

const loggerOptions: any = {
  level: env.LOG_LEVEL,
};

if (!isProd && !isServerless) {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
  };
}

export const logger = pino(loggerOptions);

export const requestLogger = pinoHttp({
  logger,
  autoLogging: true,
});
