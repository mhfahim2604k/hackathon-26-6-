/**
 * Vercel serverless entry point.
 *
 * Exports the Fastify app so @vercel/node can adapt it into a request
 * handler. The app is built once per cold start; subsequent invocations
 * within the same lambda instance reuse it.
 */
import { buildServer } from '../src/server.js';

let appPromise: ReturnType<typeof buildServer> | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = buildServer();
  }
  return appPromise;
}

export default async function handler(req: any, res: any) {
  const app = await getApp();
  await app.ready();
  app.server.emit('request', req, res);
}