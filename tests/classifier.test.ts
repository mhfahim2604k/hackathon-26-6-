import { describe, it, expect } from 'vitest';
import { classify } from '../src/pipeline/classifier.js';
import { extract } from '../src/pipeline/extractor.js';
import { match } from '../src/pipeline/matcher.js';
import type { TicketRequest } from '../src/schemas/request.js';

function fullPipeline(complaint: string, history: any[] = [], overrides: Partial<TicketRequest> = {}) {
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
  return { req, ext, m, c };
}

describe('classifier — case_type', () => {
  it('wrong_transfer with matching transfer txn', () => {
    const { c } = fullPipeline(
      'I sent 5000 taka to the wrong number.',
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
    expect(c.case_type).toBe('wrong_transfer');
    expect(c.department).toBe('dispute_resolution');
    expect(c.severity).toBe('high');
    expect(c.human_review_required).toBe(true);
  });

  it('payment_failed with deduction complaint', () => {
    const { c } = fullPipeline(
      'I tried to pay 1200 taka for recharge but the app showed failed. Balance was deducted.',
      [
        {
          transaction_id: 'TXN-FAIL',
          timestamp: '2026-04-14T16:00:00Z',
          type: 'payment',
          amount: 1200,
          counterparty: 'MERCHANT-MOBILE-OP',
          status: 'failed',
        },
      ],
    );
    expect(c.case_type).toBe('payment_failed');
    expect(c.department).toBe('payments_ops');
    expect(c.severity).toBe('high');
  });

  it('refund_request for simple refund', () => {
    const { c } = fullPipeline(
      'I paid 500 to a merchant but changed my mind. Please refund.',
      [
        {
          transaction_id: 'TXN-9401',
          timestamp: '2026-04-14T13:00:00Z',
          type: 'payment',
          amount: 500,
          counterparty: 'MERCHANT-7821',
          status: 'completed',
        },
      ],
    );
    expect(c.case_type).toBe('refund_request');
    expect(c.department).toBe('customer_support');
    expect(c.severity).toBe('low');
  });

  it('duplicate_payment from matcher', () => {
    const { c } = fullPipeline(
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
    expect(c.case_type).toBe('duplicate_payment');
    expect(c.department).toBe('payments_ops');
    expect(c.severity).toBe('high');
  });

  it('agent_cash_in_issue', () => {
    const { c } = fullPipeline(
      'I did cash in 2000 via agent but balance not updated.',
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
    );
    expect(c.case_type).toBe('agent_cash_in_issue');
    expect(c.department).toBe('agent_operations');
    expect(c.severity).toBe('high');
  });

  it('merchant_settlement_delay', () => {
    const { c } = fullPipeline(
      'I am a merchant. My yesterday sales of 15000 taka have not been settled.',
      [
        {
          transaction_id: 'TXN-9901',
          timestamp: '2026-04-13T18:00:00Z',
          type: 'settlement',
          amount: 15000,
          counterparty: 'MERCHANT-SELF',
          status: 'pending',
        },
      ],
      { user_type: 'merchant', channel: 'merchant_portal' },
    );
    expect(c.case_type).toBe('merchant_settlement_delay');
    expect(c.department).toBe('merchant_operations');
    expect(c.severity).toBe('medium');
  });

  it('phishing_or_social_engineering', () => {
    const { c } = fullPipeline('Someone called asking for my OTP.', []);
    expect(c.case_type).toBe('phishing_or_social_engineering');
    expect(c.department).toBe('fraud_risk');
    expect(c.severity).toBe('critical');
    expect(c.human_review_required).toBe(true);
  });

  it('other for vague complaint', () => {
    const { c } = fullPipeline('Something is wrong with my money. Please check.');
    expect(c.case_type).toBe('other');
    expect(c.department).toBe('customer_support');
  });
});

describe('classifier — severity bumps with campaign_context', () => {
  it('bumps severity by one level when campaign_context is present', () => {
    const { c } = fullPipeline(
      'I paid 500 to a merchant. Please refund.',
      [
        {
          transaction_id: 'TXN-RF',
          timestamp: '2026-04-14T13:00:00Z',
          type: 'payment',
          amount: 500,
          counterparty: 'MERCHANT-7821',
          status: 'completed',
        },
      ],
      { campaign_context: 'boishakh_bonanza_day_1' },
    );
    // refund + low → medium after bump.
    expect(c.severity).toBe('medium');
  });

  it('caps at critical when already critical + campaign', () => {
    const { c } = fullPipeline('Someone called asking for my OTP.', [], { campaign_context: 'campaign' });
    expect(c.severity).toBe('critical');
  });
});

describe('classifier — human_review_required', () => {
  it('insufficient_data ambiguous → false (ask first)', () => {
    const { c } = fullPipeline(
      'I sent 1000 to my brother yesterday.',
      [
        {
          transaction_id: 'TXN-1',
          timestamp: '2026-04-13T11:20:00Z',
          type: 'transfer',
          amount: 1000,
          counterparty: '+8801712001122',
          status: 'completed',
        },
        {
          transaction_id: 'TXN-2',
          timestamp: '2026-04-13T19:45:00Z',
          type: 'transfer',
          amount: 1000,
          counterparty: '+8801812334455',
          status: 'completed',
        },
      ],
    );
    expect(c.human_review_required).toBe(false);
  });

  it('wrong_transfer inconsistent → true', () => {
    const { c } = fullPipeline(
      'I sent 2000 to the wrong person.',
      [
        { transaction_id: 'T1', timestamp: '2026-04-14T11:30:00Z', type: 'transfer', amount: 2000, counterparty: '+8801812345678', status: 'completed' },
        { transaction_id: 'T2', timestamp: '2026-04-10T09:15:00Z', type: 'transfer', amount: 2500, counterparty: '+8801812345678', status: 'completed' },
        { transaction_id: 'T3', timestamp: '2026-04-05T17:45:00Z', type: 'transfer', amount: 1500, counterparty: '+8801812345678', status: 'completed' },
      ],
    );
    expect(c.human_review_required).toBe(true);
  });
});