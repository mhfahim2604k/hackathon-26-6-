/**
 * Internal pipeline types (not exposed to the API).
 */
import type { TransactionEntry } from '../schemas/request.js';
import type {
  CaseType,
  Department,
  EvidenceVerdict,
  Severity,
} from '../schemas/enums.js';
import type { ReplyLanguage } from '../utils/language.js';

export type { CaseType, Department, Severity, EvidenceVerdict };

export type Intent =
  | 'taka'
  | 'sent'
  | 'not_received'
  | 'wrong'
  | 'refund'
  | 'cash_in'
  | 'agent'
  | 'merchant'
  | 'settlement'
  | 'otp_mention'
  | 'pin_mention'
  | 'password_mention'
  | 'link_mention'
  | 'phishing_signal'
  | 'duplicate'
  | 'payment_failed';

export interface ComplaintExtraction {
  ticketId: string;
  rawComplaint: string;
  normalizedComplaint: string; // Bangla digits → ASCII, lower-cased keywords map applied
  language: ReplyLanguage;
  amounts: number[];
  primaryAmount: number | null;
  phones: string[]; // normalized to +880...
  merchantIds: string[];
  agentIds: string[];
  txnIds: string[];
  timeKeyword: 'today' | 'yesterday' | 'tomorrow' | 'morning' | 'evening' | 'noon' | 'afternoon' | 'night' | 'unknown';
  timeOfDayHour: number | null;
  intents: Set<Intent>;
  phishing: boolean;
  promptInjectionInComplaint: boolean;
  mentionedCounterparty: string | null; // best guess of counterparty from complaint
}

export interface TxnScore {
  txn: TransactionEntry;
  score: number;
  reasons: string[];
}

export interface MatchResult {
  relevant_transaction_id: string | null;
  evidence_verdict: EvidenceVerdict;
  topScore: number;
  scores: TxnScore[];
  reason_codes: string[];
  // Duplicate detection (sets txn id when applicable).
  duplicate_of: string | null;
}

export interface Classification {
  case_type: CaseType;
  department: Department;
  severity: Severity;
  human_review_required: boolean;
  confidence: number;
  reason_codes: string[];
}

export interface GeneratedDraft {
  ticket_id: string;
  agent_summary: string;
  recommended_next_action: string;
  customer_reply: string;
  language: ReplyLanguage;
}
