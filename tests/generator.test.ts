import { describe, it, expect } from 'vitest';
import { extract } from '../src/pipeline/extractor.js';
import { match } from '../src/pipeline/matcher.js';
import { classify } from '../src/pipeline/classifier.js';
import { generate } from '../src/pipeline/generator.js';
import type { TicketRequest } from '../src/schemas/request.js';

async function fullPipeline(complaint: string, history: any[] = [], overrides: Partial<TicketRequest> = {}) {
  const req: TicketRequest = {
    ticket_id: 'TKT-TEST',
    complaint,
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: history,
    ...overrides,
  } as TicketRequest;
  const ext = extract(req);
  const m = match(ext, req.transaction_history ?? []);
  const c = classify(m, ext, req);
  const draft = await generate(c, m, ext, req);
  return { req, ext, m, c, draft };
}

describe('generator — language awareness', () => {
  it('returns Bangla customer_reply when complaint is Bangla', async () => {
    const { draft } = await fullPipeline(
      'আমি আজ সকালে এজেন্টের কাছে ২০০০ টাকা ক্যাশ ইন করেছি কিন্তু আমার ব্যালেন্সে টাকা আসেনি।',
      [
        {
          transaction_id: 'TXN-9701',
          timestamp: '2026-04-14T09:30:00Z',
          type: 'cash_in',
          amount: 2000,
          counterparty: 'AGENT-318',
          status: 'pending',
        },
      ],
      { language: 'bn' },
    );
    expect(draft.language).toBe('bn');
    expect(draft.customer_reply).toMatch(/[\u0980-\u09FF]/);
    expect(draft.customer_reply).toContain('পিন');
  });

  it('returns English customer_reply when complaint is English', async () => {
    const { draft } = await fullPipeline(
      'I sent 5000 taka to a wrong number.',
      [
        {
          transaction_id: 'TXN-9101',
          timestamp: '2026-04-14T14:08:22Z',
          type: 'transfer',
          amount: 5000,
          counterparty: '+8801719876543',
          status: 'completed',
        },
      ],
    );
    expect(draft.language).toBe('en');
    expect(draft.customer_reply).toMatch(/PIN|OTP/);
  });
});

describe('generator — PIN/OTP warning appended', () => {
  it('appends English PIN warning', async () => {
    const { draft } = await fullPipeline(
      'I sent 5000 taka to a wrong number.',
      [
        {
          transaction_id: 'TXN-1',
          timestamp: '2026-04-14T14:08:22Z',
          type: 'transfer',
          amount: 5000,
          counterparty: '+8801719876543',
          status: 'completed',
        },
      ],
    );
    expect(draft.customer_reply).toContain('Please do not share your PIN or OTP with anyone.');
  });

  it('appends Bangla PIN warning', async () => {
    const { draft } = await fullPipeline(
      'আমার ব্যালেন্সে টাকা আসেনি।',
      [
        {
          transaction_id: 'TXN-1',
          timestamp: '2026-04-14T09:30:00Z',
          type: 'cash_in',
          amount: 2000,
          counterparty: 'AGENT-318',
          status: 'pending',
        },
      ],
      { language: 'bn' },
    );
    expect(draft.customer_reply).toContain('পিন');
    expect(draft.customer_reply).toContain('ওটিপি');
  });
});

describe('generator — tone by user_type', () => {
  it('merchant reply is business-formal and includes settlement wording', async () => {
    const { draft } = await fullPipeline(
      'My yesterday settlement has not been received.',
      [
        {
          transaction_id: 'TXN-S',
          timestamp: '2026-04-13T18:00:00Z',
          type: 'settlement',
          amount: 15000,
          counterparty: 'MERCHANT-SELF',
          status: 'pending',
        },
      ],
      { user_type: 'merchant', channel: 'merchant_portal' },
    );
    expect(draft.customer_reply).toContain('settlement');
    // Generator renders the department label in human form ("merchant operations").
    expect(draft.recommended_next_action).toMatch(/merchant operations/i);
  });

  it('customer reply is empathetic and reassuring', async () => {
    const { draft } = await fullPipeline(
      'I sent 5000 to a wrong number.',
      [
        {
          transaction_id: 'TXN-1',
          timestamp: '2026-04-14T14:08:22Z',
          type: 'transfer',
          amount: 5000,
          counterparty: '+8801719876543',
          status: 'completed',
        },
      ],
    );
    expect(draft.agent_summary.toLowerCase()).toContain('customer');
  });
});

describe('generator — never promises refund', () => {
  it('rules output uses safe refund phrasing', async () => {
    const { draft } = await fullPipeline(
      'I was charged twice.',
      [
        {
          transaction_id: 'TXN-A',
          timestamp: '2026-04-14T08:15:30Z',
          type: 'payment',
          amount: 850,
          counterparty: 'BILLER-DESCO',
          status: 'completed',
        },
        {
          transaction_id: 'TXN-B',
          timestamp: '2026-04-14T08:15:42Z',
          type: 'payment',
          amount: 850,
          counterparty: 'BILLER-DESCO',
          status: 'completed',
        },
      ],
    );
    expect(/we will refund/i.test(draft.customer_reply)).toBe(false);
    expect(/your account will be unblocked/i.test(draft.customer_reply)).toBe(false);
  });
});