/**
 * Fastify server bootstrap.
 *
 * - Binds to 0.0.0.0:${PORT}
 * - Sets strict JSON content-type
 * - Global JSON error handler (never returns HTML, never leaks stack)
 * - Hides framework version, hides 'X-Powered-By'
 * - Pino logger redacts secrets
 */
import Fastify from 'fastify';
import { env } from './config.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAnalyzeTicketRoute } from './routes/analyzeTicket.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-goog-api-key"]',
  'GEMINI_API_KEY',
  '*.api_key',
  '*.apiKey',
  '*.token',
  '*.password',
  // The Gemini client passes the API key as a query-string param (?key=...).
  // We never log the Gemini URL directly, but redact defensively in case
  // a future log path surfaces it.
  'req.query.key',
];

async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1024 * 1024, // 1 MB cap on request bodies
    trustProxy: true,
    disableRequestLogging: false,
    requestIdHeader: false,
    requestIdLogLabel: 'reqId',
  });

  // Hide framework signature.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = body as string;
      if (raw.length === 0) {
        return done(null, {});
      }
      try {
        const json = JSON.parse(raw);
        done(null, json);
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Default error handler — always JSON, never HTML, no stack.
  app.setErrorHandler((err, request, reply) => {
    request.log.warn({ err: err.message, code: err.statusCode }, 'request error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? 'internal_error' : 'bad_request',
      message: status === 500 ? 'An internal error occurred. Please try again.' : err.message,
    });
  });

  // 404 handler — JSON, not HTML.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` });
  });

  // Register routes.
  await registerHealthRoute(app);
  await registerAnalyzeTicketRoute(app);

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    const address = await app.listen({ host: '0.0.0.0', port: env.PORT });
    app.log.info(`QueueStorm Investigator listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Run if executed directly.
const isMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  void main();
}

export { buildServer };