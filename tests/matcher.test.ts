import { describe, it, expect } from 'vitest';
import { extract } from '../src/pipeline/extractor.js';
import { match } from '../src/pipeline/matcher.js';
import type { TicketRequest } from '../src/schemas/request.js';

function req(complaint: string): TicketRequest {
  return {
    ticket_id: 'TKT-TEST',
    complaint,
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [],
  } as TicketRequest;
}

describe('matcher — empty history', () => {
  it('returns insufficient_data when history is empty', () => {
    const ext = extract(req('I sent 5000 taka.'));
    const m = match(ext, []);
    expect(m.evidence_verdict).toBe('insufficient_data');
    expect(m.relevant_transaction_id).toBeNull();
  });
});

describe('matcher — de-duplication', () => {
  it('de-dupes txns by transaction_id', () => {
    const ext = extract(req('I sent 5000 taka.'));
    const dup = {
      transaction_id: 'TXN-1',
      timestamp: '2026-04-14T14:08:22Z',
      type: 'transfer' as const,
      amount: 5000,
      counterparty: '+8801719876543',
      status: 'completed' as const,
    };
    const m = match(ext, [dup, { ...dup }, { ...dup, transaction_id: 'TXN-2', counterparty: '+8801719876544' }]);
    expect(m.scores.length).toBe(2);
  });
});

describe('matcher — consistent match', () => {
  it('matches wrong-transfer with clean evidence → consistent', () => {
    const ext = extract(req('I sent 5000 taka to the wrong number around 2pm today.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-9101',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'transfer',
        amount: 5000,
        counterparty: '+8801719876543',
        status: 'completed',
      },
    ]);
    expect(m.evidence_verdict).toBe('consistent');
    expect(m.relevant_transaction_id).toBe('TXN-9101');
  });
});

describe('matcher — inconsistent match (established recipient)', () => {
  it('flags wrong-transfer when same counterparty 3+ times', () => {
    const ext = extract(req('I sent 2000 to the wrong person by mistake.'));
    const txn = {
      transaction_id: 'TXN-9202',
      timestamp: '2026-04-14T11:30:00Z',
      type: 'transfer' as const,
      amount: 2000,
      counterparty: '+8801812345678',
      status: 'completed' as const,
    };
    const m = match(ext, [
      txn,
      { ...txn, transaction_id: 'TXN-9180', timestamp: '2026-04-10T09:15:00Z', amount: 2500 },
      { ...txn, transaction_id: 'TXN-9145', timestamp: '2026-04-05T17:45:00Z', amount: 1500 },
    ]);
    expect(m.evidence_verdict).toBe('inconsistent');
    expect(m.relevant_transaction_id).toBe('TXN-9202');
    expect(m.reason_codes).toContain('established_recipient_pattern');
  });
});

describe('matcher — duplicate payment detection (60s window)', () => {
  it('returns second txn as relevant for two identical 850 BDT payments 12s apart', () => {
    const ext = extract(req('I paid 850 but it deducted twice.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-10001',
        timestamp: '2026-04-14T08:15:30Z',
        type: 'payment',
        amount: 850,
        counterparty: 'BILLER-DESCO',
        status: 'completed',
      },
      {
        transaction_id: 'TXN-10002',
        timestamp: '2026-04-14T08:15:42Z',
        type: 'payment',
        amount: 850,
        counterparty: 'BILLER-DESCO',
        status: 'completed',
      },
    ]);
    expect(m.evidence_verdict).toBe('consistent');
    expect(m.relevant_transaction_id).toBe('TXN-10002');
    expect(m.duplicate_of).toBe('TXN-10001');
  });

  it('does NOT flag as duplicate when gap > 60s', () => {
    const ext = extract(req('I was charged twice.'));
    const m = match(ext, [
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
        timestamp: '2026-04-14T08:20:00Z', // 4m30s later
        type: 'payment',
        amount: 850,
        counterparty: 'BILLER-DESCO',
        status: 'completed',
      },
    ]);
    expect(m.duplicate_of).toBeNull();
  });
});

describe('matcher — inconsistency: not_received but completed', () => {
  it('flags inconsistent when claim is not received but status is completed', () => {
    const ext = extract(req('I sent 1000 taka but he says he didn\'t get it.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-X',
        timestamp: '2026-04-13T11:20:00Z',
        type: 'transfer',
        amount: 1000,
        counterparty: '+8801712001122',
        status: 'completed',
      },
    ]);
    // not_received + completed + single match → inconsistent.
    expect(m.evidence_verdict).toBe('inconsistent');
    expect(m.relevant_transaction_id).toBe('TXN-X');
  });
});

describe('matcher — ambiguity detection', () => {
  it('returns null + insufficient_data when 3 txns tie on amount 1000', () => {
    const ext = extract(req('I sent 1000 taka to my brother yesterday.'));
    const tx = {
      type: 'transfer' as const,
      amount: 1000,
      status: 'completed' as const,
    };
    const m = match(ext, [
      { ...tx, transaction_id: 'TXN-1', timestamp: '2026-04-13T11:20:00Z', counterparty: '+8801712001122' },
      { ...tx, transaction_id: 'TXN-2', timestamp: '2026-04-13T19:45:00Z', counterparty: '+8801812334455' },
      { ...tx, transaction_id: 'TXN-3', timestamp: '2026-04-13T20:10:00Z', counterparty: '+8801712001123', status: 'failed' },
    ]);
    expect(m.evidence_verdict).toBe('insufficient_data');
    expect(m.relevant_transaction_id).toBeNull();
  });
});

describe('matcher — below threshold', () => {
  it('returns insufficient_data when no txn matches amount', () => {
    const ext = extract(req('I sent 99999 taka.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-A',
        timestamp: '2026-04-10T11:00:00Z',
        type: 'transfer',
        amount: 100,
        counterparty: '+8801700000000',
        status: 'completed',
      },
    ]);
    expect(m.evidence_verdict).toBe('insufficient_data');
    expect(m.relevant_transaction_id).toBeNull();
  });
});

describe('matcher — today/yesterday bonus', () => {
  it('matches recent transaction with today bonus', () => {
    const ext = extract(req('I sent 500 taka today.'));
    const today = new Date();
    const iso = today.toISOString();
    const m = match(ext, [
      {
        transaction_id: 'TXN-NOW',
        timestamp: iso,
        type: 'transfer',
        amount: 500,
        counterparty: '+8801700000000',
        status: 'completed',
      },
    ]);
    expect(m.evidence_verdict).toBe('consistent');
    expect(m.relevant_transaction_id).toBe('TXN-NOW');
  });
});

describe('matcher — score branches', () => {
  it('awards amount_within_5pct when off by less than 5%', () => {
    const ext = extract(req('I sent 1000 taka to wrong number.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-WITHIN',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'transfer',
        amount: 980, // -2%, within 5%
        counterparty: '+8801719876543',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('amount_within_5pct');
  });

  it('awards counterparty_id_match when both are merchant IDs', () => {
    const ext = extract(req('I paid BILLER-DESCO 850 by mistake.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-MID',
        timestamp: '2026-04-14T08:15:30Z',
        type: 'payment',
        amount: 850,
        counterparty: 'BILLER-DESCO',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('counterparty_id_match');
  });

  it('awards counterparty_phone_match when both are phones', () => {
    const ext = extract(req('I sent 5000 to 01719876543 wrong number.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-PHONE',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'transfer',
        amount: 5000,
        counterparty: '+8801719876543',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('counterparty_phone_match');
  });

  it('time_window_2h matches txn within ±2h of complaint time', () => {
    const ext = extract(req('I sent 500 taka at 2pm today.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-TIME',
        timestamp: '2026-04-14T13:30:00Z', // 30 minutes before 14:00
        type: 'transfer',
        amount: 500,
        counterparty: '+8801700000000',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('time_window_2h');
  });

  it('type_align_transfer awarded when intent is wrong + type is transfer', () => {
    const ext = extract(req('I sent 500 taka to wrong number.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-TA',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'transfer',
        amount: 500,
        counterparty: '+8801700000000',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('type_align_transfer');
  });

  it('type_align_cash_in awarded when intent is cash_in', () => {
    const ext = extract(req('I gave 5000 taka to agent for cash in.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-CI',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'cash_in',
        amount: 5000,
        counterparty: 'AGENT-512',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('type_align_cash_in');
  });

  it('type_align_settlement awarded when intent is settlement', () => {
    const ext = extract(req('My settlement has not been credited.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-SET',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'settlement',
        amount: 15000,
        counterparty: 'MERCHANT-SELF',
        status: 'pending',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('type_align_settlement');
  });

  it('type_align_payment_failed awarded for failed payments', () => {
    const ext = extract(req('Payment failed but balance deducted.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-PF',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'payment',
        amount: 1200,
        counterparty: 'BILLER-GP',
        status: 'failed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('type_align_payment_failed');
  });

  it('type_align_duplicate awarded for duplicate claims', () => {
    const ext = extract(req('I paid twice by mistake.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-DUP',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'payment',
        amount: 850,
        counterparty: 'BILLER-DESCO',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('type_align_duplicate');
  });

  it('type_align_payment awarded for refund intent', () => {
    const ext = extract(req('I want a refund.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-RF',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'refund',
        amount: 500,
        counterparty: 'MERCHANT-A',
        status: 'completed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('type_align_payment');
  });

  it('status_alignment_pending awarded for settlement on pending txn', () => {
    const ext = extract(req('My settlement has not been credited.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-SETP',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'settlement',
        amount: 15000,
        counterparty: 'MERCHANT-SELF',
        status: 'pending',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('status_alignment_pending');
  });

  it('status_alignment_failed awarded for payment_failed intent on failed txn', () => {
    const ext = extract(req('Payment failed.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-FAIL',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'payment',
        amount: 500,
        counterparty: 'BILLER-GP',
        status: 'failed',
      },
    ]);
    expect(m.scores[0]?.reasons).toContain('status_alignment_failed');
  });

  it('established_recipient_pattern detection with 3+ same counterparty', () => {
    const ext = extract(req('I sent 1000 to wrong person.'));
    const tx = {
      timestamp: '2026-04-14T11:30:00Z',
      type: 'transfer' as const,
      counterparty: '+8801812345678',
      status: 'completed' as const,
    };
    const m = match(ext, [
      { ...tx, transaction_id: 'TXN-1', amount: 1000 },
      { ...tx, transaction_id: 'TXN-2', amount: 1500, timestamp: '2026-04-10T09:15:00Z' },
      { ...tx, transaction_id: 'TXN-3', amount: 2000, timestamp: '2026-04-05T17:45:00Z' },
    ]);
    expect(m.evidence_verdict).toBe('inconsistent');
  });

  it('duplicate_claim_single_match flagged inconsistent', () => {
    const ext = extract(req('I paid 500 taka twice by mistake.'));
    const m = match(ext, [
      {
        transaction_id: 'TXN-SOLO',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'payment',
        amount: 500,
        counterparty: 'BILLER-GP',
        status: 'completed',
      },
    ]);
    expect(m.evidence_verdict).toBe('inconsistent');
    expect(m.reason_codes).toContain('duplicate_claim_single_match');
  });
});