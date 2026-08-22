import pino from 'pino';
import pinoHttpPkg from 'pino-http';
import { env, isProd } from './env.js';

const pinoHttp = (pinoHttpPkg as any).default ?? (pinoHttpPkg as any);

const isServerless = !!process.env.VERCEL;

const loggerOptions: any = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'authorization',
      'cookie',
      'set-cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'request.headers.authorization',
      'request.headers.cookie',
      'res.headers["set-cookie"]',
      'response.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
};

if (!isProd && !isServerless && process.stdout.isTTY) {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
  };
}

export const logger = pino(loggerOptions);

export function serializeRequest(req: any) {
  const rawUrl = typeof req.url === 'string' ? req.url : '';
  return {
    id: req.id,
    method: req.method,
    url: rawUrl.split('?')[0],
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

export function serializeResponse(res: any) {
  return { statusCode: res.statusCode };
}

export const requestLogger = pinoHttp({
  logger,
  autoLogging: true,
  serializers: {
    req: serializeRequest,
    res: serializeResponse,
    err: pino.stdSerializers.err,
  },
});
