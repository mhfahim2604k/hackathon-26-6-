/**
 * Generator — produces all text fields.
 *
 * Never reasons. Never classifies. Never scores transactions.
 *
 * Tone by user_type. Language matches the complaint. PIN/OTP warning always appended.
 *
 * Optional LLM: if OPENAI_API_KEY is set, the draft customer_reply is sent through
 * the LLM for polish. If the LLM fails or returns nothing, the deterministic draft
 * is used.
 */
import { SAFE_PHRASES } from '../config.js';
import { rewriteCustomerReply } from '../llm/client.js';
import type { TicketRequest } from '../schemas/request.js';
import type { Classification, ComplaintExtraction, GeneratedDraft, MatchResult } from '../types/internal.js';

const DEPARTMENT_LABEL: Record<string, string> = {
  customer_support: 'customer support',
  dispute_resolution: 'dispute resolution',
  payments_ops: 'payments operations',
  merchant_operations: 'merchant operations',
  agent_operations: 'agent operations',
  fraud_risk: 'fraud risk',
};

function userTypeLabel(t: TicketRequest['user_type']): string {
  switch (t) {
    case 'customer':
      return 'Customer';
    case 'merchant':
      return 'Merchant';
    case 'agent':
      return 'Agent';
    default:
      return 'Customer';
  }
}

function buildAgentSummary(
  cls: Classification,
  match: MatchResult,
  ext: ComplaintExtraction,
  request: TicketRequest,
): string {
  const userLabel = userTypeLabel(request.user_type).toLowerCase();
  const txnLabel = match.relevant_transaction_id
    ? ` via ${match.relevant_transaction_id}`
    : '';

  let evidenceSentence: string;
  switch (match.evidence_verdict) {
    case 'consistent':
      evidenceSentence = match.relevant_transaction_id
        ? ` Evidence supports this claim based on the matched transaction.`
        : ` Evidence supports this claim.`;
      break;
    case 'inconsistent':
      evidenceSentence = ` Transaction history suggests this may not be a typical case and warrants human review.`;
      break;
    case 'insufficient_data':
    default:
      evidenceSentence = match.relevant_transaction_id
        ? ` More information may be required to act confidently.`
        : ` Insufficient detail to identify a relevant transaction.`;
      break;
  }

  let caseDesc: string;
  switch (cls.case_type) {
    case 'wrong_transfer':
      caseDesc = `reports a wrong transfer${ext.primaryAmount !== null ? ` of ${ext.primaryAmount} BDT` : ''}`;
      break;
    case 'payment_failed':
      caseDesc = `reports a failed payment${ext.primaryAmount !== null ? ` of ${ext.primaryAmount} BDT` : ''} with possible balance deduction`;
      break;
    case 'refund_request':
      caseDesc = `requests a refund${ext.primaryAmount !== null ? ` of ${ext.primaryAmount} BDT` : ''}`;
      break;
    case 'duplicate_payment':
      caseDesc = `reports a duplicate payment${ext.primaryAmount !== null ? ` of ${ext.primaryAmount} BDT` : ''}`;
      break;
    case 'merchant_settlement_delay':
      caseDesc = `reports a delayed merchant settlement${ext.primaryAmount !== null ? ` of ${ext.primaryAmount} BDT` : ''}`;
      break;
    case 'agent_cash_in_issue':
      caseDesc = `reports a cash-in not reflected in balance${ext.primaryAmount !== null ? ` of ${ext.primaryAmount} BDT` : ''}`;
      break;
    case 'phishing_or_social_engineering':
      caseDesc = `reports a suspected phishing or social engineering attempt`;
      break;
    default:
      caseDesc = `raises a concern that requires review`;
  }

  return `${userLabel[0]!.toUpperCase()}${userLabel.slice(1)} ${caseDesc}${txnLabel}.${evidenceSentence}`;
}

function buildRecommendedNextAction(
  cls: Classification,
  match: MatchResult,
): string {
  const dept = DEPARTMENT_LABEL[cls.department] ?? cls.department;
  const txnRef = match.relevant_transaction_id ? ` ${match.relevant_transaction_id}` : '';

  let base: string;
  switch (cls.case_type) {
    case 'wrong_transfer':
      base = `Route to ${dept} to verify transaction${txnRef} with the customer and initiate the wrong-transfer dispute review workflow per policy.`;
      break;
    case 'payment_failed':
      base = `Route to ${dept} to investigate transaction${txnRef} ledger status. If a balance deduction is confirmed on a failed payment, initiate the standard automatic reversal flow within SLA.`;
      break;
    case 'refund_request':
      base = cls.department === 'dispute_resolution'
        ? `Route to ${dept} to review the refund eligibility of transaction${txnRef} per policy.`
        : `Inform the customer that refund eligibility depends on merchant policy for transaction${txnRef}. Provide guidance on next steps.`;
      break;
    case 'duplicate_payment':
      base = `Route to ${dept} to verify the duplicate with the biller for transaction${txnRef}. If the biller confirms only one payment, initiate the reversal workflow for the duplicate transaction.`;
      break;
    case 'merchant_settlement_delay':
      base = `Route to ${dept} to verify the settlement batch status for transaction${txnRef}. If delayed, communicate a revised ETA to the merchant.`;
      break;
    case 'agent_cash_in_issue':
      base = `Route to ${dept} to investigate the pending cash-in transaction${txnRef} with the agent and confirm settlement state within the standard cash-in SLA.`;
      break;
    case 'phishing_or_social_engineering':
      base = `Escalate to ${dept} immediately. Confirm to the customer that the company never asks for OTP. Log the reported number for fraud pattern analysis.`;
      break;
    default:
      base = `Route to ${dept} to review the customer's concern${txnRef ? ` for transaction ${txnRef}` : ''}.`;
  }

  if (cls.human_review_required) {
    base += ' Flag for human review.';
  }

  return base;
}

function buildCustomerReplyEn(cls: Classification, match: MatchResult, request: TicketRequest): string {
  const txn = match.relevant_transaction_id ? match.relevant_transaction_id : null;
  const isMerchant = request.user_type === 'merchant';

  let opener: string;
  switch (cls.case_type) {
    case 'wrong_transfer':
      opener = txn
        ? `We have noted your concern about transaction ${txn}. `
        : `We have noted your concern about a possible wrong transfer. `;
      break;
    case 'payment_failed':
      opener = txn
        ? `We have noted that transaction ${txn} may have caused an unexpected balance deduction. `
        : `We have noted your failed payment concern. `;
      break;
    case 'refund_request':
      opener = isMerchant
        ? `Thank you for contacting merchant support regarding the refund request. `
        : `Thank you for reaching out regarding the refund. `;
      break;
    case 'duplicate_payment':
      opener = txn
        ? `We have noted the possible duplicate payment for transaction ${txn}. `
        : `We have noted your duplicate payment concern. `;
      break;
    case 'merchant_settlement_delay':
      opener = txn
        ? `We have noted your concern about settlement ${txn}. `
        : `We have noted your settlement concern. `;
      break;
    case 'agent_cash_in_issue':
      opener = txn
        ? `We have noted your concern about transaction ${txn}. `
        : `We have noted your cash-in concern. `;
      break;
    case 'phishing_or_social_engineering':
      opener = `Thank you for reaching out before sharing any information. `;
      break;
    default:
      opener = `Thank you for reaching out. `;
  }

  let body: string;
  switch (cls.case_type) {
    case 'wrong_transfer':
      body = `Our dispute team will review the case and contact you through official support channels.`;
      break;
    case 'payment_failed':
      body = `Our payments team will review the case and ${SAFE_PHRASES.EN_REFUND_SAFE.toLowerCase()}`;
      break;
    case 'refund_request':
      body = isMerchant
        ? `Our merchant operations team will review your case and respond through official channels.`
        : `Refunds for completed merchant payments depend on the merchant's own policy. We recommend contacting the merchant directly. If you need help reaching them, please reply and we will guide you.`;
      break;
    case 'duplicate_payment':
      body = `Our payments team will verify with the biller and ${SAFE_PHRASES.EN_REFUND_SAFE.toLowerCase()}`;
      break;
    case 'merchant_settlement_delay':
      body = `Our merchant operations team will check the batch status and update you on the expected settlement time through official channels.`;
      break;
    case 'agent_cash_in_issue':
      body = `Our agent operations team will verify this quickly and update you through official channels.`;
      break;
    case 'phishing_or_social_engineering':
      body = `We never ask for your PIN, OTP, or password under any circumstances. Please do not share these with anyone, even if they claim to be from us. Our fraud team has been notified of this incident.`;
      break;
    default:
      body = match.relevant_transaction_id
        ? `To help you faster, please share any additional details about transaction ${match.relevant_transaction_id}. `
        : `To help you faster, please share the transaction ID, the amount involved, and a short description of what went wrong. `;
      body += `Our support team will review and respond through official channels.`;
  }

  let pinWarning: string;
  if (cls.case_type === 'phishing_or_social_engineering') {
    // Already included in body.
    pinWarning = '';
  } else {
    pinWarning = ` ${SAFE_PHRASES.EN_PIN_WARNING}`;
  }

  return `${opener}${body}${pinWarning}`;
}

function buildCustomerReplyBn(cls: Classification, match: MatchResult, _request: TicketRequest): string {
  const txn = match.relevant_transaction_id ? match.relevant_transaction_id : null;

  let opener: string;
  switch (cls.case_type) {
    case 'wrong_transfer':
      opener = txn
        ? `আপনার লেনদেন ${txn} এর বিষয়ে আমরা অবগত হয়েছি। `
        : `আপনার ভুল লেনদেনের বিষয়ে আমরা অবগত হয়েছি। `;
      break;
    case 'payment_failed':
      opener = txn
        ? `আপনার লেনদেন ${txn} এর বিষয়ে আমরা অবগত হয়েছি। `
        : `আপনার ব্যর্থ পেমেন্টের বিষয়ে আমরা অবগত হয়েছি। `;
      break;
    case 'refund_request':
      opener = `আপনার ফেরত অনুরোধের বিষয়ে আমরা অবগত হয়েছি। `;
      break;
    case 'duplicate_payment':
      opener = txn
        ? `আপনার লেনদেন ${txn} এর সদৃশ পেমেন্টের বিষয়ে আমরা অবগত হয়েছি। `
        : `আপনার সদৃশ পেমেন্টের বিষয়ে আমরা অবগত হয়েছি। `;
      break;
    case 'merchant_settlement_delay':
      opener = txn
        ? `আপনার সেটেলমেন্ট ${txn} এর বিষয়ে আমরা অবগত হয়েছি। `
        : `আপনার সেটেলমেন্ট বিষয়ে আমরা অবগত হয়েছি। `;
      break;
    case 'agent_cash_in_issue':
      opener = txn
        ? `আপনার লেনদেন ${txn} এর বিষয়ে আমরা অবগত হয়েছি। `
        : `আপনার ক্যাশ-ইন বিষয়ে আমরা অবগত হয়েছি। `;
      break;
    case 'phishing_or_social_engineering':
      opener = `কোনো তথ্য শেয়ার করার আগে আমাদের জানানোর জন্য ধন্যবাদ। `;
      break;
    default:
      opener = `আমাদের সাথে যোগাযোগ করার জন্য ধন্যবাদ। `;
  }

  let body: string;
  switch (cls.case_type) {
    case 'wrong_transfer':
    case 'payment_failed':
    case 'duplicate_payment':
    case 'merchant_settlement_delay':
    case 'agent_cash_in_issue':
      body = `আমাদের দল এটি দ্রুত যাচাই করবে এবং অফিসিয়াল চ্যানেলে আপনাকে জানাবে।`;
      break;
    case 'refund_request':
      body = `ফেরত প্রাপ্তি মার্চেন্টের নীতির উপর নির্ভর করে। আমরা শীঘ্রই অফিসিয়াল চ্যানেলে আপনার সাথে যোগাযোগ করব।`;
      break;
    case 'phishing_or_social_engineering':
      body = `আমরা কখনো আপনার পিন, ওটিপি বা পাসওয়ার্ড চাইব না। অনুগ্রহ করে এগুলো কারো সাথে শেয়ার করবেন না, এমনকি নিজেকে আমাদের প্রতিনিধি বললেও। আমাদের ফ্রড টিম এই ঘটনা সম্পর্কে অবহিত হয়েছে।`;
      break;
    default:
      body = `আমাদের সাপোর্ট দল এটি পর্যালোচনা করবে এবং অফিসিয়াল চ্যানেলে আপনার সাথে যোগাযোগ করবে।`;
  }

  let pinWarning: string;
  if (cls.case_type === 'phishing_or_social_engineering') {
    pinWarning = '';
  } else {
    pinWarning = ` ${SAFE_PHRASES.BN_PIN_WARNING}`;
  }

  return `${opener}${body}${pinWarning}`;
}

function buildRulesDraft(
  cls: Classification,
  match: MatchResult,
  ext: ComplaintExtraction,
  request: TicketRequest,
): GeneratedDraft {
  const language = ext.language;
  const agent_summary = buildAgentSummary(cls, match, ext, request);
  const recommended_next_action = buildRecommendedNextAction(cls, match);
  const customer_reply =
    language === 'bn' ? buildCustomerReplyBn(cls, match, request) : buildCustomerReplyEn(cls, match, request);

  return {
    ticket_id: request.ticket_id,
    agent_summary,
    recommended_next_action,
    customer_reply,
    language,
  };
}

/**
 * Main entry point. Async because of the optional LLM step.
 */
export async function generate(
  cls: Classification,
  match: MatchResult,
  ext: ComplaintExtraction,
  request: TicketRequest,
): Promise<GeneratedDraft> {
  const draft = buildRulesDraft(cls, match, ext, request);

  // Optional LLM rewrite of customer_reply only.
  const rewritten = await rewriteCustomerReply({
    ticket_id: request.ticket_id,
    case_type: cls.case_type,
    severity: cls.severity,
    language: draft.language,
    draft_customer_reply: draft.customer_reply,
    draft_recommended_next_action: draft.recommended_next_action,
  });

  if (rewritten && rewritten.customer_reply && rewritten.customer_reply.length > 0) {
    return { ...draft, customer_reply: rewritten.customer_reply };
  }

  return draft;
}