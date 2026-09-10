import pino, { type DestinationStream } from 'pino';

export function createLogger(level: string, destination?: DestinationStream) {
  const options = {
    level, base: undefined,
    redact: { paths: ['authorization', 'cookie', 'password', 'token', 'secret', 'body', 'headers', 'query', 'gps', '*.token', '*.password', '*.secret'], censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

type RequestLog = { requestId: string; routeTemplate: string; method: string; status: number; durationMs: number };
export function logRequest(logger: ReturnType<typeof createLogger>, fields: RequestLog) {
  // Explicit allowlist: never pass Request, raw URL, body, or untrusted context.
  const { requestId, routeTemplate, method, status, durationMs } = fields;
  logger.info({ requestId, routeTemplate, method, status, durationMs }, 'http_request');
}
