import { describe, it, expect } from 'vitest';
import {
  TicketRequestSchema,
  TransactionEntrySchema,
} from '../src/schemas/request.js';
import { TicketResponseSchema } from '../src/schemas/response.js';
import {
  CaseTypeSchema,
  ChannelSchema,
  DepartmentSchema,
  EvidenceVerdictSchema,
  LanguageSchema,
  SeveritySchema,
  TransactionStatusSchema,
  TransactionTypeSchema,
  UserTypeSchema,
} from '../src/schemas/enums.js';

describe('Enum schemas — case-sensitive exact match', () => {
  it('language accepts en/bn/mixed and rejects others', () => {
    expect(LanguageSchema.parse('en')).toBe('en');
    expect(LanguageSchema.parse('bn')).toBe('bn');
    expect(LanguageSchema.parse('mixed')).toBe('mixed');
    expect(() => LanguageSchema.parse('EN')).toThrow();
    expect(() => LanguageSchema.parse('bangla')).toThrow();
  });

  it('channel accepts exact values', () => {
    for (const v of ['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent']) {
      expect(ChannelSchema.parse(v)).toBe(v);
    }
    expect(() => ChannelSchema.parse('phone')).toThrow();
    expect(() => ChannelSchema.parse('In_App_Chat')).toThrow();
  });

  it('user_type accepts exact values', () => {
    for (const v of ['customer', 'merchant', 'agent', 'unknown']) {
      expect(UserTypeSchema.parse(v)).toBe(v);
    }
    expect(() => UserTypeSchema.parse('Customer')).toThrow();
  });

  it('transaction_type accepts exact values', () => {
    for (const v of ['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund']) {
      expect(TransactionTypeSchema.parse(v)).toBe(v);
    }
    expect(() => TransactionTypeSchema.parse('Transfer')).toThrow();
    expect(() => TransactionTypeSchema.parse('transfer_')).toThrow();
  });

  it('transaction_status accepts exact values', () => {
    for (const v of ['completed', 'failed', 'pending', 'reversed']) {
      expect(TransactionStatusSchema.parse(v)).toBe(v);
    }
    expect(() => TransactionStatusSchema.parse('COMPLETED')).toThrow();
  });

  it('evidence_verdict accepts exact values', () => {
    for (const v of ['consistent', 'inconsistent', 'insufficient_data']) {
      expect(EvidenceVerdictSchema.parse(v)).toBe(v);
    }
    expect(() => EvidenceVerdictSchema.parse('consistent_')).toThrow();
  });

  it('case_type accepts all 8 exact values', () => {
    for (const v of [
      'wrong_transfer',
      'payment_failed',
      'refund_request',
      'duplicate_payment',
      'merchant_settlement_delay',
      'agent_cash_in_issue',
      'phishing_or_social_engineering',
      'other',
    ]) {
      expect(CaseTypeSchema.parse(v)).toBe(v);
    }
    expect(() => CaseTypeSchema.parse('WrongTransfer')).toThrow();
    expect(() => CaseTypeSchema.parse('duplicate')).toThrow();
  });

  it('severity accepts all 4 values', () => {
    for (const v of ['low', 'medium', 'high', 'critical']) {
      expect(SeveritySchema.parse(v)).toBe(v);
    }
    expect(() => SeveritySchema.parse('urgent')).toThrow();
  });

  it('department accepts all 6 values', () => {
    for (const v of [
      'customer_support',
      'dispute_resolution',
      'payments_ops',
      'merchant_operations',
      'agent_operations',
      'fraud_risk',
    ]) {
      expect(DepartmentSchema.parse(v)).toBe(v);
    }
    expect(() => DepartmentSchema.parse('customer support')).toThrow();
  });
});

describe('TransactionEntrySchema', () => {
  it('accepts a valid entry', () => {
    const e = TransactionEntrySchema.parse({
      transaction_id: 'TXN-9101',
      timestamp: '2026-04-14T14:08:22Z',
      type: 'transfer',
      amount: 5000,
      counterparty: '+8801719876543',
      status: 'completed',
    });
    expect(e.transaction_id).toBe('TXN-9101');
  });

  it('rejects bad type', () => {
    expect(() =>
      TransactionEntrySchema.parse({
        transaction_id: 'TXN-9101',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'transferr',
        amount: 1,
        counterparty: 'x',
        status: 'completed',
      }),
    ).toThrow();
  });
});

describe('TicketRequestSchema', () => {
  it('requires ticket_id and complaint', () => {
    const r = TicketRequestSchema.parse({
      ticket_id: 'TKT-001',
      complaint: 'I sent 5000 taka to a wrong number',
    });
    expect(r.ticket_id).toBe('TKT-001');
    expect(r.transaction_history).toEqual([]);
  });

  it('rejects unknown fields', () => {
    expect(() =>
      TicketRequestSchema.parse({
        ticket_id: 'TKT-1',
        complaint: 'x',
        unknown: 'y',
      } as any),
    ).toThrow();
  });

  it('rejects missing ticket_id', () => {
    expect(() => TicketRequestSchema.parse({ complaint: 'x' } as any)).toThrow();
  });
});

describe('TicketResponseSchema', () => {
  it('accepts a minimal response', () => {
    const r = TicketResponseSchema.parse({
      ticket_id: 'TKT-1',
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      case_type: 'other',
      severity: 'low',
      department: 'customer_support',
      agent_summary: 'Summary',
      recommended_next_action: 'Next',
      customer_reply: 'Reply',
      human_review_required: false,
    });
    expect(r.ticket_id).toBe('TKT-1');
  });

  it('rejects bad enum', () => {
    expect(() =>
      TicketResponseSchema.parse({
        ticket_id: 'TKT-1',
        relevant_transaction_id: null,
        evidence_verdict: 'CONSISTENT',
        case_type: 'other',
        severity: 'low',
        department: 'customer_support',
        agent_summary: 'Summary',
        recommended_next_action: 'Next',
        customer_reply: 'Reply',
        human_review_required: false,
      } as any),
    ).toThrow();
  });

  it('rejects confidence outside [0,1]', () => {
    expect(() =>
      TicketResponseSchema.parse({
        ticket_id: 'TKT-1',
        relevant_transaction_id: null,
        evidence_verdict: 'consistent',
        case_type: 'other',
        severity: 'low',
        department: 'customer_support',
        agent_summary: 'Summary',
        recommended_next_action: 'Next',
        customer_reply: 'Reply',
        human_review_required: false,
        confidence: 1.5,
      } as any),
    ).toThrow();
  });
});