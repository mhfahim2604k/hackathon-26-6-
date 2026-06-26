/**
 * Matcher — transaction investigation ONLY.
 *
 * Input: ComplaintExtraction + transaction_history
 * Output: MatchResult
 *
 * Algorithm:
 *   1. De-duplicate txns by transaction_id
 *   2. Check for duplicate-payment pair (60s window, same amount+counterparty+type)
 *   3. Score each remaining txn
 *   4. Pick the top scorer
 *   5. Apply verdict rules (consistent / inconsistent / insufficient_data)
 *
 * Never classifies. Never generates text.
 */
import {
  DUPLICATE_WINDOW_SECONDS,
  HIGH_VALUE_WRONG_TRANSFER_BDT,
  SCORE,
} from '../config.js';
import type { TransactionEntry } from '../schemas/request.js';
import type { ComplaintExtraction, MatchResult, TxnScore } from '../types/internal.js';
import { hoursBetween, isToday, isYesterday, nowUtc, parseIso, secondsBetween } from '../utils/time.js';
import { normalizeBdPhone } from '../utils/bangla.js';

function dedupeTxns(txns: TransactionEntry[]): TransactionEntry[] {
  const seen = new Set<string>();
  const out: TransactionEntry[] = [];
  for (const t of txns) {
    if (!t.transaction_id) continue;
    if (seen.has(t.transaction_id)) continue;
    seen.add(t.transaction_id);
    out.push(t);
  }
  return out;
}

function normalizeCounterparty(raw: string): string {
  // Phones → +880 form. IDs → uppercased.
  if (/^(\+?880|0)?1[3-9]\d{8}$/.test(raw.replace(/[\s-]/g, ''))) {
    return normalizeBdPhone(raw);
  }
  return raw.toUpperCase();
}

function isPhoneLike(s: string): boolean {
  const cleaned = s.replace(/[\s-]/g, '');
  return /^(\+?880|0)?1[3-9]\d{8}$/.test(cleaned);
}

function detectDuplicatePair(txns: TransactionEntry[]): { first: TransactionEntry; second: TransactionEntry } | null {
  // Sort by timestamp ascending for stable pair detection.
  const sorted = [...txns].sort((a, b) => {
    const ta = parseIso(a.timestamp)?.getTime() ?? 0;
    const tb = parseIso(b.timestamp)?.getTime() ?? 0;
    return ta - tb;
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b) continue;
    if (a.type !== b.type) continue;
    if (a.amount !== b.amount) continue;
    if (a.counterparty.toUpperCase() !== b.counterparty.toUpperCase()) continue;
    const da = parseIso(a.timestamp);
    const db = parseIso(b.timestamp);
    if (!da || !db) continue;
    const delta = Math.abs(secondsBetween(da, db));
    if (delta <= DUPLICATE_WINDOW_SECONDS) {
      return { first: a, second: b };
    }
  }
  return null;
}

function withinPct(actual: number, expected: number, pct: number): boolean {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) / expected <= pct;
}

function scoreTxn(
  txn: TransactionEntry,
  ext: ComplaintExtraction,
  ref: Date,
): TxnScore {
  let score = 0;
  const reasons: string[] = [];

  // Amount match.
  if (ext.primaryAmount !== null) {
    if (txn.amount === ext.primaryAmount) {
      score += SCORE.AMOUNT_EXACT;
      reasons.push('amount_exact');
    } else if (withinPct(txn.amount, ext.primaryAmount, 0.05)) {
      score += SCORE.AMOUNT_WITHIN_5PCT;
      reasons.push('amount_within_5pct');
    }
  }

  // Counterparty match.
  if (ext.mentionedCounterparty) {
    const mc = ext.mentionedCounterparty;
    const tc = normalizeCounterparty(txn.counterparty);
    if (isPhoneLike(mc) && isPhoneLike(tc)) {
      if (mc === tc) {
        score += SCORE.COUNTERPARTY_PHONE;
        reasons.push('counterparty_phone_match');
      }
    } else if (!isPhoneLike(mc) && !isPhoneLike(tc)) {
      if (mc.toUpperCase() === tc.toUpperCase()) {
        score += SCORE.COUNTERPARTY_MID;
        reasons.push('counterparty_id_match');
      }
    }
  }

  // Time window match (within ±2h of mentioned time).
  const txnDate = parseIso(txn.timestamp);
  if (txnDate && ext.timeOfDayHour !== null) {
    const txnHour = txnDate.getUTCHours();
    const delta = Math.abs(txnHour - ext.timeOfDayHour);
    const wrapped = Math.min(delta, 24 - delta);
    if (wrapped <= 2) {
      score += SCORE.TIME_WINDOW_2H;
      reasons.push('time_window_2h');
    }
  }

  // Type alignment: complaint is about a transfer / payment / cash_in / settlement / refund.
  if (ext.intents.has('wrong') || ext.intents.has('sent') || ext.intents.has('not_received')) {
    if (txn.type === 'transfer') {
      score += SCORE.TYPE_ALIGN;
      reasons.push('type_align_transfer');
    }
  } else if (ext.intents.has('refund')) {
    if (txn.type === 'payment' || txn.type === 'refund') {
      score += SCORE.TYPE_ALIGN;
      reasons.push('type_align_payment');
    }
  } else if (ext.intents.has('cash_in')) {
    if (txn.type === 'cash_in') {
      score += SCORE.TYPE_ALIGN;
      reasons.push('type_align_cash_in');
    }
  } else if (ext.intents.has('settlement')) {
    if (txn.type === 'settlement') {
      score += SCORE.TYPE_ALIGN;
      reasons.push('type_align_settlement');
    }
  } else if (ext.intents.has('payment_failed')) {
    if (txn.type === 'payment') {
      score += SCORE.TYPE_ALIGN;
      reasons.push('type_align_payment_failed');
    }
  } else if (ext.intents.has('duplicate')) {
    if (txn.type === 'payment') {
      score += SCORE.TYPE_ALIGN;
      reasons.push('type_align_duplicate');
    }
  }

  // Today / yesterday bonus.
  if (txnDate) {
    if (isToday(txnDate, ref)) {
      score += SCORE.TODAY_YESTERDAY;
      reasons.push('today');
    } else if (isYesterday(txnDate, ref)) {
      score += SCORE.TODAY_YESTERDAY;
      reasons.push('yesterday');
    }
  }

  // Status alignment: only boost when the customer's intent actually
  // maps to the txn's status semantics. A "not_received" complaint
  // should NOT boost a FAILED txn — the customer's claim is about the
  // counterparty not receiving a COMPLETED transfer, not about a
  // system-level failure.
  if (ext.intents.has('payment_failed')) {
    if (txn.status === 'failed' || txn.status === 'pending') {
      score += 15;
      reasons.push('status_alignment_failed');
    }
  } else if (ext.intents.has('settlement')) {
    if (txn.status === 'pending') {
      score += 15;
      reasons.push('status_alignment_pending');
    }
  }
  // Other intents (not_received, wrong, duplicate, refund, cash_in)
  // do not get an automatic status bonus.

  return { txn, score, reasons };
}

function countSameCounterparty(
  target: TransactionEntry,
  history: TransactionEntry[],
): number {
  const tc = normalizeCounterparty(target.counterparty);
  return history.filter((t) => normalizeCounterparty(t.counterparty) === tc).length;
}

/**
 * Main entry point.
 */
export function match(ext: ComplaintExtraction, history: TransactionEntry[]): MatchResult {
  const reason_codes: string[] = [];
  const txns = dedupeTxns(history);

  // Empty history → insufficient_data.
  if (txns.length === 0) {
    return {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      topScore: 0,
      scores: [],
      reason_codes: ['empty_history'],
      duplicate_of: null,
    };
  }

  // Duplicate-payment short-circuit.
  const dupPair = detectDuplicatePair(txns);
  if (dupPair) {
    reason_codes.push('duplicate_payment_detected');
    return {
      relevant_transaction_id: dupPair.second.transaction_id,
      evidence_verdict: 'consistent',
      topScore: SCORE.AMOUNT_EXACT + SCORE.COUNTERPARTY_PHONE,
      scores: [
        { txn: dupPair.first, score: SCORE.AMOUNT_EXACT + SCORE.COUNTERPARTY_PHONE, reasons: ['duplicate_pair_first'] },
        { txn: dupPair.second, score: SCORE.AMOUNT_EXACT + SCORE.COUNTERPARTY_PHONE, reasons: ['duplicate_pair_second'] },
      ],
      reason_codes,
      duplicate_of: dupPair.first.transaction_id,
    };
  }

  const ref = nowUtc();
  const scored = txns.map((t) => scoreTxn(t, ext, ref));
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) {
    return {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      topScore: 0,
      scores: [],
      reason_codes: ['no_match'],
      duplicate_of: null,
    };
  }

  // No confident match.
  if (top.score < SCORE.MATCH_THRESHOLD) {
    reason_codes.push('below_match_threshold');
    return {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      topScore: top.score,
      scores: scored,
      reason_codes,
      duplicate_of: null,
    };
  }

  // Ambiguity check: ties within AMBIGUITY_DELTA.
  const tied = scored.filter((s) => Math.abs(s.score - top.score) <= SCORE.AMBIGUITY_DELTA);
  if (tied.length > 1) {
    reason_codes.push('ambiguous_multiple_matches');
    return {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      topScore: top.score,
      scores: scored,
      reason_codes,
      duplicate_of: null,
    };
  }

  // Inconsistency detection.
  // Case A: wrong-transfer claim but counterparty appears 3+ times in history.
  if (
    ext.intents.has('wrong') &&
    top.txn.type === 'transfer' &&
    countSameCounterparty(top.txn, txns) >= 3
  ) {
    reason_codes.push('established_recipient_pattern');
    return {
      relevant_transaction_id: top.txn.transaction_id,
      evidence_verdict: 'inconsistent',
      topScore: top.score,
      scores: scored,
      reason_codes,
      duplicate_of: null,
    };
  }

  // Case B: "never happened" claim but top txn status is completed.
  if (
    ext.intents.has('not_received') &&
    top.txn.status === 'completed' &&
    top.txn.type === 'transfer' &&
    // Only flag when no other lower-scoring txn has a failed status that better matches.
    !scored.some((s) => s.txn.status === 'failed' && s.score >= top.score - SCORE.AMBIGUITY_DELTA)
  ) {
    reason_codes.push('claim_not_received_but_completed');
    return {
      relevant_transaction_id: top.txn.transaction_id,
      evidence_verdict: 'inconsistent',
      topScore: top.score,
      scores: scored,
      reason_codes,
      duplicate_of: null,
    };
  }

  // Case C: duplicate-payment claim but only one matching txn.
  if (ext.intents.has('duplicate') && scored.length === 1) {
    reason_codes.push('duplicate_claim_single_match');
    return {
      relevant_transaction_id: top.txn.transaction_id,
      evidence_verdict: 'inconsistent',
      topScore: top.score,
      scores: scored,
      reason_codes,
      duplicate_of: null,
    };
  }

  // Default: consistent.
  reason_codes.push(...top.reasons);
  if (top.txn.amount >= HIGH_VALUE_WRONG_TRANSFER_BDT) {
    reason_codes.push('high_value_txn');
  }
  return {
    relevant_transaction_id: top.txn.transaction_id,
    evidence_verdict: 'consistent',
    topScore: top.score,
    scores: scored,
    reason_codes,
    duplicate_of: null,
  };
}