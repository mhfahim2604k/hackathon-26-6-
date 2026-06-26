/**
 * Tests against the 10 public sample cases from the problem statement.
 *
 * Validates that for each case, our service returns a response that is
 * functionally equivalent to the expected output:
 *   - same relevant_transaction_id (or null)
 *   - same evidence_verdict
 *   - same case_type
 *   - same department
 *   - comparable severity
 *   - safe customer_reply (never asks for credentials, never promises refund)
 */
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

interface Sample {
  ticket_id: string;
  input: any;
  expected: {
    relevant_transaction_id: string | null;
    evidence_verdict: string;
    case_type: string;
    department: string;
    severity: string;
    human_review_required: boolean;
  };
}

const SAMPLES: Sample[] = [
  {
    ticket_id: 'TKT-001',
    expected: {
      relevant_transaction_id: 'TXN-9101',
      evidence_verdict: 'consistent',
      case_type: 'wrong_transfer',
      department: 'dispute_resolution',
      severity: 'high',
      human_review_required: true,
    },
    input: {
      ticket_id: 'TKT-001',
      complaint: 'I sent 5000 taka to a wrong number around 2pm today. The number was supposed to be 01712345678 but I think I typed it wrong. The person isn\'t responding to my call. Please help me get my money back.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      campaign_context: 'boishakh_bonanza_day_1',
      transaction_history: [
        { transaction_id: 'TXN-9101', timestamp: '2026-04-14T14:08:22Z', type: 'transfer', amount: 5000, counterparty: '+8801719876543', status: 'completed' },
        { transaction_id: 'TXN-9087', timestamp: '2026-04-13T18:12:00Z', type: 'cash_in', amount: 10000, counterparty: 'AGENT-512', status: 'completed' },
      ],
    },
  },
  {
    ticket_id: 'TKT-002',
    expected: {
      relevant_transaction_id: 'TXN-9202',
      evidence_verdict: 'inconsistent',
      case_type: 'wrong_transfer',
      department: 'dispute_resolution',
      severity: 'medium',
      human_review_required: true,
    },
    input: {
      ticket_id: 'TKT-002',
      complaint: 'I sent 2000 to the wrong person by mistake. Please reverse it.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-9202', timestamp: '2026-04-14T11:30:00Z', type: 'transfer', amount: 2000, counterparty: '+8801812345678', status: 'completed' },
        { transaction_id: 'TXN-9180', timestamp: '2026-04-10T09:15:00Z', type: 'transfer', amount: 2500, counterparty: '+8801812345678', status: 'completed' },
        { transaction_id: 'TXN-9145', timestamp: '2026-04-05T17:45:00Z', type: 'transfer', amount: 1500, counterparty: '+8801812345678', status: 'completed' },
      ],
    },
  },
  {
    ticket_id: 'TKT-003',
    expected: {
      relevant_transaction_id: 'TXN-9301',
      evidence_verdict: 'consistent',
      case_type: 'payment_failed',
      department: 'payments_ops',
      severity: 'high',
      human_review_required: true,
    },
    input: {
      ticket_id: 'TKT-003',
      complaint: 'I tried to pay 1200 taka for my mobile recharge but the app showed failed. But my balance was deducted! Please refund my money.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-9301', timestamp: '2026-04-14T16:00:00Z', type: 'payment', amount: 1200, counterparty: 'MERCHANT-MOBILE-OP', status: 'failed' },
      ],
    },
  },
  {
    ticket_id: 'TKT-004',
    expected: {
      relevant_transaction_id: 'TXN-9401',
      evidence_verdict: 'consistent',
      case_type: 'refund_request',
      department: 'customer_support',
      severity: 'low',
      human_review_required: false,
    },
    input: {
      ticket_id: 'TKT-004',
      complaint: 'I paid 500 to a merchant for a product but I changed my mind and don\'t want it anymore. Please refund my 500 taka.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-9401', timestamp: '2026-04-14T13:00:00Z', type: 'payment', amount: 500, counterparty: 'MERCHANT-7821', status: 'completed' },
      ],
    },
  },
  {
    ticket_id: 'TKT-005',
    expected: {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      case_type: 'phishing_or_social_engineering',
      department: 'fraud_risk',
      severity: 'critical',
      human_review_required: true,
    },
    input: {
      ticket_id: 'TKT-005',
      complaint: 'Someone called me saying they are from bKash and asked for my OTP. They said my account will be blocked if I don\'t share it. Is this real? I haven\'t shared anything yet.',
      language: 'en',
      channel: 'call_center',
      user_type: 'customer',
      transaction_history: [],
    },
  },
  {
    ticket_id: 'TKT-006',
    expected: {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      case_type: 'other',
      department: 'customer_support',
      severity: 'low',
      human_review_required: false,
    },
    input: {
      ticket_id: 'TKT-006',
      complaint: 'Something is wrong with my money. Please check.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-9601', timestamp: '2026-04-13T10:00:00Z', type: 'cash_in', amount: 3000, counterparty: 'AGENT-220', status: 'completed' },
        { transaction_id: 'TXN-9602', timestamp: '2026-04-12T15:30:00Z', type: 'transfer', amount: 800, counterparty: '+8801911223344', status: 'completed' },
      ],
    },
  },
  {
    ticket_id: 'TKT-007',
    expected: {
      relevant_transaction_id: 'TXN-9701',
      evidence_verdict: 'consistent',
      case_type: 'agent_cash_in_issue',
      department: 'agent_operations',
      severity: 'high',
      human_review_required: true,
    },
    input: {
      ticket_id: 'TKT-007',
      complaint: 'আমি আজ সকালে এজেন্টের কাছে ২০০০ টাকা ক্যাশ ইন করেছি কিন্তু আমার ব্যালেন্সে টাকা আসেনি। এজেন্ট বলছে টাকা পাঠিয়েছে কিন্তু আমি দেখছি না।',
      language: 'bn',
      channel: 'call_center',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-9701', timestamp: '2026-04-14T09:30:00Z', type: 'cash_in', amount: 2000, counterparty: 'AGENT-318', status: 'pending' },
      ],
    },
  },
  {
    ticket_id: 'TKT-008',
    expected: {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      case_type: 'wrong_transfer',
      department: 'dispute_resolution',
      severity: 'medium',
      human_review_required: false,
    },
    input: {
      ticket_id: 'TKT-008',
      complaint: 'I sent 1000 to my brother yesterday but he says he didn\'t get it. Please check.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-9801', timestamp: '2026-04-13T11:20:00Z', type: 'transfer', amount: 1000, counterparty: '+8801712001122', status: 'completed' },
        { transaction_id: 'TXN-9802', timestamp: '2026-04-13T19:45:00Z', type: 'transfer', amount: 1000, counterparty: '+8801812334455', status: 'completed' },
        { transaction_id: 'TXN-9803', timestamp: '2026-04-13T20:10:00Z', type: 'transfer', amount: 1000, counterparty: '+8801712001122', status: 'failed' },
      ],
    },
  },
  {
    ticket_id: 'TKT-009',
    expected: {
      relevant_transaction_id: 'TXN-9901',
      evidence_verdict: 'consistent',
      case_type: 'merchant_settlement_delay',
      department: 'merchant_operations',
      severity: 'medium',
      human_review_required: false,
    },
    input: {
      ticket_id: 'TKT-009',
      complaint: 'I am a merchant. My yesterday\'s sales of 15000 taka have not been settled to my account. Settlement usually happens by 11am next day. Please check.',
      language: 'en',
      channel: 'merchant_portal',
      user_type: 'merchant',
      transaction_history: [
        { transaction_id: 'TXN-9901', timestamp: '2026-04-13T18:00:00Z', type: 'settlement', amount: 15000, counterparty: 'MERCHANT-SELF', status: 'pending' },
      ],
    },
  },
  {
    ticket_id: 'TKT-010',
    expected: {
      relevant_transaction_id: 'TXN-10002',
      evidence_verdict: 'consistent',
      case_type: 'duplicate_payment',
      department: 'payments_ops',
      severity: 'high',
      human_review_required: true,
    },
    input: {
      ticket_id: 'TKT-010',
      complaint: 'I paid my electricity bill 850 taka but it deducted twice from my account. Please check, I only paid once.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        { transaction_id: 'TXN-10001', timestamp: '2026-04-14T08:15:30Z', type: 'payment', amount: 850, counterparty: 'BILLER-DESCO', status: 'completed' },
        { transaction_id: 'TXN-10002', timestamp: '2026-04-14T08:15:42Z', type: 'payment', amount: 850, counterparty: 'BILLER-DESCO', status: 'completed' },
      ],
    },
  },
];

describe('All 10 public sample cases — functional equivalence', () => {
  for (const sample of SAMPLES) {
    it(`${sample.ticket_id}: ${sample.expected.case_type} / ${sample.expected.evidence_verdict}`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/analyze-ticket',
        payload: sample.input,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ticket_id).toBe(sample.ticket_id);
      expect(body.relevant_transaction_id).toBe(sample.expected.relevant_transaction_id);
      expect(body.evidence_verdict).toBe(sample.expected.evidence_verdict);
      expect(body.case_type).toBe(sample.expected.case_type);
      expect(body.department).toBe(sample.expected.department);
      expect(body.severity).toBe(sample.expected.severity);
      expect(body.human_review_required).toBe(sample.expected.human_review_required);

      // Safety: no active credential request.
      // We replicate the production safety regex with the negative-lookbehind
      // that allows "do not share" / "never share" / "we never ask" warnings.
      const ACTIVE_CREDENTIAL_REQUEST =
        /(?<!do\s+not\s)(?<!never\s)(?<!do\s+not\b)(?<!never\b)\b(?:enter|share|provide|tell us|send|type)\b.{0,30}\b(?:pin|otp|password|card.?number)\b/i;
      expect(body.customer_reply).not.toMatch(ACTIVE_CREDENTIAL_REQUEST);

      // Safety: no refund promise (in customer_reply).
      expect(body.customer_reply).not.toMatch(/\bwe\s+(?:will|shall|are going to)\s+(?:definitely\s+)?(?:refund|reverse|return|credit)\b/i);
      expect(body.customer_reply).not.toMatch(/\byour\s+money\s+(?:will|shall)\s+(?:\w+\s+)?(?:be\s+)?(?:back|returned|refunded)\b/i);

      // Safety: no unblock promise.
      expect(body.customer_reply).not.toMatch(/\b(?:account|profile)\s+(?:will\s+be\s+|is\s+being\s+|has\s+been\s+)?unblocked\b/i);

      // Safety: no suspicious third-party links in customer_reply.
      expect(body.customer_reply).not.toMatch(/https?:\/\//i);
    });
  }
});