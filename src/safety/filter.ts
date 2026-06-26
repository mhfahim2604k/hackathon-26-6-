/**
 * Safety filter — mandatory post-processor.
 *
 * The ONLY module allowed to mutate or replace generated text.
 *
 * Checks:
 *   - credential request (PIN / OTP / password / card)
 *   - refund / reversal / unblock promise
 *   - suspicious third-party / external link
 *   - prompt injection in output
 *   - stack trace leakage
 *   - API key / token pattern leakage
 *
 * Replacement policy:
 *   - critical violation → replace customer_reply with safe fallback (en or bn)
 *   - non-critical violation → surgical replacement of the offending phrase
 *   - 2+ critical violations in one response → full safe fallback for whole response
 */
import { SAFE_PHRASES, SAFETY_PATTERNS } from '../config.js';
import type { TicketResponse } from '../schemas/response.js';
import type { GeneratedDraft } from '../types/internal.js';

export interface FilterResult {
  output: TicketResponse;
  violations: string[];
  critical: boolean;
}

function matchesAny(text: string, patterns: readonly RegExp[]): RegExp | null {
  for (const p of patterns) {
    if (p.test(text)) return p;
  }
  return null;
}

function stripPatterns(text: string, patterns: readonly RegExp[]): string {
  let out = text;
  for (const p of patterns) out = out.replace(p, '');
  return out;
}

function safeFallback(language: 'en' | 'bn'): string {
  return language === 'bn' ? SAFE_PHRASES.BN_FALLBACK_REPLY : SAFE_PHRASES.EN_FALLBACK_REPLY;
}

/**
 * Sanitize a single text field. Returns the cleaned text and the list of
 * violation categories found in it.
 */
function sanitizeField(
  text: string,
  language: 'en' | 'bn',
): { text: string; violations: string[]; critical: boolean } {
  const violations: string[] = [];
  let critical = false;
  let out = text;

  // 1) Credential request → critical.
  if (matchesAny(out, SAFETY_PATTERNS.credentialRequest)) {
    violations.push('credential_request');
    critical = true;
  }

  // 2) Refund promise → critical.
  if (matchesAny(out, SAFETY_PATTERNS.refundPromise)) {
    violations.push('refund_promise');
    critical = true;
  }

  // 3) Suspicious third-party / external link.
  if (matchesAny(out, SAFETY_PATTERNS.suspiciousThirdParty)) {
    violations.push('suspicious_third_party');
    // Not always critical (a link can be stripped without full replacement),
    // but we treat it as critical for customer_reply to be safe.
    critical = true;
  }

  // 4) Prompt injection in output.
  if (matchesAny(out, SAFETY_PATTERNS.promptInjection)) {
    violations.push('prompt_injection_in_output');
    critical = true;
  }

  // 5) Stack trace leakage → strip silently.
  if (matchesAny(out, SAFETY_PATTERNS.stackTrace)) {
    out = stripPatterns(out, SAFETY_PATTERNS.stackTrace);
    violations.push('stack_trace_stripped');
  }

  // 6) API key pattern leakage → strip silently.
  if (matchesAny(out, SAFETY_PATTERNS.apiKey)) {
    out = stripPatterns(out, SAFETY_PATTERNS.apiKey);
    violations.push('api_key_stripped');
  }

  // If any critical violation was found, replace the whole field with safe fallback.
  if (critical) {
    out = safeFallback(language);
  }

  return { text: out, violations, critical };
}

/**
 * Sanitize the full generated draft and convert to TicketResponse.
 */
export function sanitize(draft: GeneratedDraft, ticketId: string, relevantTxnId: string | null): FilterResult {
  const violations: string[] = [];

  // Fields we scan: customer_reply + recommended_next_action.
  const replySan = sanitizeField(draft.customer_reply, draft.language);
  violations.push(...replySan.violations);

  const nextSan = sanitizeField(draft.recommended_next_action, draft.language);
  violations.push(...nextSan.violations);

  // Agent summary: still scan for credential/api-key leakage, but only strip silently.
  const summarySan = sanitizeField(draft.agent_summary, draft.language);
  violations.push(...summarySan.violations);

  // Count distinct critical violation categories across the response.
  const CRITICAL_TAGS = new Set([
    'credential_request',
    'refund_promise',
    'suspicious_third_party',
    'prompt_injection_in_output',
  ]);
  const distinctCritical = new Set(violations.filter((v) => CRITICAL_TAGS.has(v)));
  const criticalCount = distinctCritical.size;

  // If 2+ critical categories across the response → full safe fallback for customer_reply.
  let finalReply = replySan.text;
  if (criticalCount >= 2) {
    finalReply = safeFallback(draft.language);
    if (!violations.includes('multiple_critical_violations')) {
      violations.push('multiple_critical_violations');
    }
  }

  const output: TicketResponse = {
    ticket_id: ticketId,
    relevant_transaction_id: relevantTxnId,
    evidence_verdict: 'consistent', // overwritten by pipeline caller (we don't have it here)
    case_type: 'other',
    severity: 'low',
    department: 'customer_support',
    agent_summary: summarySan.text,
    recommended_next_action: nextSan.text,
    customer_reply: finalReply,
    human_review_required: false,
    confidence: null,
    reason_codes: [],
  };

  return { output, violations, critical: criticalCount > 0 };
}