/**
 * Classifier — decision engine.
 *
 * Consumes MatchResult + ComplaintExtraction (+ original request) and
 * produces case_type, department, severity, human_review_required.
 *
 * Never generates text.
 */
import { HIGH_VALUE_WRONG_TRANSFER_BDT, SEVERITY_ORDER, bumpSeverity } from '../config.js';
import type { TicketRequest } from '../schemas/request.js';
import type {
  CaseType,
  Classification,
  Department,
  Severity,
} from '../types/internal.js';
import type { ComplaintExtraction, MatchResult } from '../types/internal.js';

function determineCaseType(ext: ComplaintExtraction, match: MatchResult): CaseType {
  // Phishing takes precedence over everything.
  if (ext.phishing) return 'phishing_or_social_engineering';

  // Duplicate payment flagged by matcher.
  if (match.duplicate_of) return 'duplicate_payment';

  // Strong intent + strong match → specific case_type.
  if (ext.intents.has('wrong') && match.relevant_transaction_id !== null && match.evidence_verdict !== 'insufficient_data') {
    return 'wrong_transfer';
  }
  if (ext.intents.has('cash_in') && match.relevant_transaction_id !== null) {
    return 'agent_cash_in_issue';
  }
  if (ext.intents.has('settlement') && match.relevant_transaction_id !== null) {
    return 'merchant_settlement_delay';
  }
  if (ext.intents.has('payment_failed') && match.relevant_transaction_id !== null) {
    return 'payment_failed';
  }
  if (ext.intents.has('refund') && match.relevant_transaction_id !== null) {
    return 'refund_request';
  }

  // Intent present but no matching transaction → classify by intent, but only
  // when the complaint has enough specificity (a primary amount OR a counterparty).
  // Vague "something is wrong" complaints with neither fall through to 'other'.
  const hasSpecifics = ext.primaryAmount !== null || ext.mentionedCounterparty !== null;

  if (ext.intents.has('wrong') && hasSpecifics) return 'wrong_transfer';
  // "not_received" with an amount (and either counterparty or any transfer-type
  // evidence in history) is treated as wrong_transfer: the customer is claiming
  // their transfer was not delivered to the intended recipient, which is the
  // definition of a wrong-transfer dispute.
  if (ext.intents.has('not_received') && hasSpecifics) {
    // Only count as wrong_transfer if there is at least one transfer-type txn
    // in history matching the amount (otherwise the customer may simply have
    // an expectation problem — e.g., cash-in hasn't arrived yet).
    const transferHit = match.scores.some(
      (s) =>
        s.txn.type === 'transfer' &&
        ext.primaryAmount !== null &&
        s.txn.amount === ext.primaryAmount,
    );
    if (transferHit || ext.mentionedCounterparty !== null) {
      return 'wrong_transfer';
    }
  }

  if (ext.intents.has('cash_in') && hasSpecifics) return 'agent_cash_in_issue';
  if (ext.intents.has('settlement') && hasSpecifics) return 'merchant_settlement_delay';
  if (ext.intents.has('payment_failed') && hasSpecifics) return 'payment_failed';
  if (ext.intents.has('refund') && hasSpecifics) return 'refund_request';

  // No clear intent or insufficient specificity → other.
  return 'other';
}

function determineDepartment(caseType: CaseType, severity: Severity): Department {
  switch (caseType) {
    case 'wrong_transfer':
      return 'dispute_resolution';
    case 'refund_request':
      return severity === 'low' ? 'customer_support' : 'dispute_resolution';
    case 'payment_failed':
    case 'duplicate_payment':
      return 'payments_ops';
    case 'merchant_settlement_delay':
      return 'merchant_operations';
    case 'agent_cash_in_issue':
      return 'agent_operations';
    case 'phishing_or_social_engineering':
      return 'fraud_risk';
    case 'other':
    default:
      return 'customer_support';
  }
}

function determineSeverity(
  caseType: CaseType,
  ext: ComplaintExtraction,
  match: MatchResult,
  request: TicketRequest,
): Severity {
  let base: Severity = 'low';

  if (caseType === 'phishing_or_social_engineering') {
    base = 'critical';
  } else if (caseType === 'wrong_transfer') {
    const amount = match.relevant_transaction_id && match.scores[0]
      ? match.scores[0].txn.amount
      : ext.primaryAmount ?? 0;
    base = amount >= HIGH_VALUE_WRONG_TRANSFER_BDT ? 'high' : 'medium';
  } else if (caseType === 'duplicate_payment') {
    base = 'high';
  } else if (caseType === 'agent_cash_in_issue') {
    base = 'high';
  } else if (caseType === 'payment_failed') {
    base = ext.intents.has('not_received') || ext.intents.has('payment_failed') ? 'high' : 'medium';
  } else if (caseType === 'merchant_settlement_delay') {
    base = 'medium';
  } else if (caseType === 'refund_request') {
    base = 'low';
  } else if (caseType === 'other') {
    // Vague / no intent → low unless the evidence is inconsistent or the
    // complaint carries an unsafe signal. The previous "insufficient_data → medium"
    // rule over-escalated vague complaints (see TKT-006 expected severity: low).
    base = 'low';
  }

  // Inconsistent or ambiguous → medium minimum.
  if (match.evidence_verdict === 'inconsistent') {
    const idx = SEVERITY_ORDER.indexOf(base);
    if (idx < SEVERITY_ORDER.indexOf('medium')) base = 'medium';
  }

  // Campaign bump: one level up, capped at critical.
  // Only applied when the base severity is below 'high' — once already high
  // or critical, the campaign bump does not further escalate (matches the
  // expected behavior for TKT-001 where a high-severity wrong transfer with
  // campaign_context remains 'high', not 'critical').
  if (request.campaign_context && request.campaign_context.length > 0) {
    const baseIdx = SEVERITY_ORDER.indexOf(base);
    if (baseIdx < SEVERITY_ORDER.indexOf('high')) {
      base = bumpSeverity(base);
    }
  }

  return base;
}

function determineHumanReview(
  caseType: CaseType,
  severity: Severity,
  match: MatchResult,
): boolean {
  // Phishing is always reviewed.
  if (caseType === 'phishing_or_social_engineering') return true;
  // Duplicate payments always reviewed.
  if (caseType === 'duplicate_payment') return true;
  // Agent cash-in issues always reviewed.
  if (caseType === 'agent_cash_in_issue') return true;
  // Wrong transfers are reviewed ONLY when we have a confident verdict
  // (consistent or inconsistent). insufficient_data means we need more info
  // from the customer first — a human can't act on it yet.
  if (caseType === 'wrong_transfer' && match.evidence_verdict !== 'insufficient_data') return true;
  if (caseType === 'refund_request' && severity !== 'low') return true;
  if (match.evidence_verdict === 'inconsistent') return true;
  if (severity === 'high' || severity === 'critical') return true;
  // insufficient_data → false (ask for clarification first).
  return false;
}

function computeConfidence(
  caseType: CaseType,
  match: MatchResult,
  ext: ComplaintExtraction,
): number {
  if (match.evidence_verdict === 'insufficient_data') {
    if (match.topScore === 0 && ext.amounts.length === 0) return 0.5;
    return 0.65;
  }
  if (match.evidence_verdict === 'inconsistent') return 0.75;
  // consistent: higher confidence for higher match scores.
  if (match.topScore >= 80) return 0.93;
  if (match.topScore >= 60) return 0.9;
  if (match.topScore >= 40) return 0.85;
  return 0.8;
}

/**
 * Main entry point.
 */
export function classify(
  match: MatchResult,
  ext: ComplaintExtraction,
  request: TicketRequest,
): Classification {
  const case_type = determineCaseType(ext, match);
  const severity = determineSeverity(case_type, ext, match, request);
  const department = determineDepartment(case_type, severity);
  const human_review_required = determineHumanReview(case_type, severity, match);
  const confidence = computeConfidence(case_type, match, ext);

  const reason_codes: string[] = [case_type];
  if (match.duplicate_of) reason_codes.push('duplicate_payment');
  if (match.evidence_verdict === 'consistent') reason_codes.push('transaction_match');
  if (match.evidence_verdict === 'inconsistent') reason_codes.push('evidence_inconsistent');
  if (match.evidence_verdict === 'insufficient_data') reason_codes.push('needs_clarification');
  if (human_review_required) reason_codes.push('human_review_required');
  if (request.campaign_context) reason_codes.push('campaign_context');

  return {
    case_type,
    department,
    severity,
    human_review_required,
    confidence,
    reason_codes,
  };
}