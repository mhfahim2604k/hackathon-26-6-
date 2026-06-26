import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns {"status":"ok"}', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('POST /analyze-ticket', () => {
  it('handles a wrong-transfer happy path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: {
        ticket_id: 'TKT-API-1',
        complaint: 'I sent 5000 taka to a wrong number around 2pm today.',
        language: 'en',
        channel: 'in_app_chat',
        user_type: 'customer',
        transaction_history: [
          {
            transaction_id: 'TXN-9101',
            timestamp: '2026-04-14T14:08:22Z',
            type: 'transfer',
            amount: 5000,
            counterparty: '+8801719876543',
            status: 'completed',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ticket_id).toBe('TKT-API-1');
    expect(body.relevant_transaction_id).toBe('TXN-9101');
    expect(body.case_type).toBe('wrong_transfer');
    expect(body.evidence_verdict).toBe('consistent');
    expect(body.department).toBe('dispute_resolution');
    expect(typeof body.customer_reply).toBe('string');
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: { complaint: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 on empty complaint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: {
        ticket_id: 'TKT-EMPTY',
        complaint: '',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('empty_complaint');
  });

  it('returns 400 on invalid enum', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: {
        ticket_id: 'TKT-ENUM',
        complaint: 'test',
        user_type: 'Customer', // wrong case
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('handles empty transaction_history', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: {
        ticket_id: 'TKT-EMPTY-HIST',
        complaint: 'Something is wrong with my money.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.relevant_transaction_id).toBeNull();
    expect(body.evidence_verdict).toBe('insufficient_data');
    expect(body.department).toBe('customer_support');
  });
});

describe('Response shape is always JSON (never HTML)', () => {
  it('returns JSON content-type on errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: '{garbage',
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).not.toMatch(/<html|<body/i);
  });
});

describe('Response does not leak secrets or stack traces', () => {
  it('500-style error response has no stack trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze-ticket',
      payload: '{not-json',
    });
    expect(res.body).not.toMatch(/at \w+\.\w+ \(/);
    expect(res.body).not.toMatch(/Error: \w+Error/);
  });
});