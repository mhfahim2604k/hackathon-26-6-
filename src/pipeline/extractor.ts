/**
 * Extractor — text mining ONLY. Never classifies, never scores transactions.
 *
 * Input: TicketRequest
 * Output: ComplaintExtraction
 *
 * Responsibility:
 *   - Amount extraction (Arabic + Bangla digits)
 *   - Phone / merchant / agent / transaction ID detection
 *   - Time keyword + time-of-day parsing
 *   - Banglish keyword → intent normalization
 *   - Phishing & prompt-injection signal detection
 *   - Best-guess counterparty from complaint text
 */
import { BANGLISH_KEYWORDS } from '../config.js';
import type { TicketRequest } from '../schemas/request.js';
import type { ComplaintExtraction, Intent } from '../types/internal.js';
import { banglaToAscii, normalizeBdPhone } from '../utils/bangla.js';
import { detectReplyLanguage } from '../utils/language.js';
import { RE } from '../utils/regex.js';

const TIME_KEYWORD_MAP: Record<string, ComplaintExtraction['timeKeyword']> = {
  today: 'today',
  aaj: 'today',
  aj: 'today',
  আজ: 'today',
  yesterday: 'yesterday',
  kal: 'yesterday',
  কাল: 'yesterday',
  গতকাল: 'yesterday',
  tomorrow: 'tomorrow',
  আগামীকাল: 'tomorrow',
  morning: 'morning',
  সকাল: 'morning',
  evening: 'evening',
  সন্ধ্যা: 'evening',
  noon: 'noon',
  দুপুর: 'noon',
  afternoon: 'afternoon',
  বিকেল: 'afternoon',
  night: 'night',
  রাত: 'night',
};

function normalizeBdPhoneLocalRemoved(): void {
  // Local definition removed; now imported from utils/bangla.ts.
}

function parseAmounts(raw: string): number[] {
  // 1) Bangla digits → ASCII, then run Arabic regex.
  const ascii = banglaToAscii(raw);
  const out: number[] = [];
  const re = new RegExp(RE.amountArabic.source, RE.amountArabic.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(ascii)) !== null) {
    const group = m[1];
    if (!group) continue;
    // Strip thousand separators (commas, dots, spaces) but preserve decimal intent:
    // We treat the LAST dot/comma as decimal if there are 1–2 digits after, otherwise thousand sep.
    let s = group.replace(/\s/g, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    const lastSep = Math.max(lastDot, lastComma);
    if (lastSep >= 0) {
      const tail = s.slice(lastSep + 1);
      if (tail.length <= 2 && /^\d+$/.test(tail)) {
        // Treat as decimal — strip other separators.
        s = s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + tail;
      } else {
        // Thousand separator.
        s = s.replace(/[.,]/g, '');
      }
    }
    const n = parseFloat(s);
    if (!Number.isNaN(n) && Number.isFinite(n)) out.push(n);
  }
  return out;
}

function parsePhones(raw: string): string[] {
  const found = raw.match(RE.bdPhone) ?? [];
  return Array.from(new Set(found.map(normalizeBdPhone)));
}

function parseMerchantIds(raw: string): string[] {
  const found = raw.match(RE.merchantId) ?? [];
  return Array.from(new Set(found.map((s) => s.toUpperCase())));
}

function parseAgentIds(raw: string): string[] {
  const found = raw.match(RE.agentId) ?? [];
  return Array.from(new Set(found.map((s) => s.toUpperCase())));
}

function parseTxnIds(raw: string): string[] {
  const found = raw.match(RE.txnId) ?? [];
  return Array.from(new Set(found.map((s) => s.toUpperCase())));
}

function parseTimeKeyword(raw: string): ComplaintExtraction['timeKeyword'] {
  const lower = raw.toLowerCase();
  for (const [k, v] of Object.entries(TIME_KEYWORD_MAP)) {
    if (lower.includes(k.toLowerCase())) return v;
  }
  return 'unknown';
}

function parseTimeOfDayHour(raw: string): number | null {
  const lower = raw.toLowerCase();
  // Look for patterns like "2pm", "11 am", "14:30", "around 2pm"
  const patterns: RegExp[] = [
    /\b(\d{1,2})\s*(am|pm)\b/i,
    /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i,
  ];
  for (const p of patterns) {
    const m = lower.match(p);
    if (!m) continue;
    if (p === patterns[0] && m[1] && m[2]) {
      let h = parseInt(m[1], 10);
      const ampm = m[2].toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      if (h >= 0 && h <= 23) return h;
    } else if (m[1]) {
      const h = parseInt(m[1], 10);
      if (h >= 0 && h <= 23) return h;
    }
  }
  return null;
}

function detectIntents(normalized: string, raw: string): Set<Intent> {
  const out = new Set<Intent>();
  const lower = normalized.toLowerCase();
  const rawLower = raw.toLowerCase();

  for (const [key, intent] of Object.entries(BANGLISH_KEYWORDS)) {
    if (key.length === 0) continue;
    if (lower.includes(key.toLowerCase()) || rawLower.includes(key.toLowerCase())) {
      out.add(intent as Intent);
    }
  }
  return out;
}

function detectPhishingSignal(raw: string, intents: Set<Intent>): boolean {
  if (intents.has('phishing_signal')) return true;
  // OTP / PIN / password / link mention is treated as phishing signal.
  // Rationale: legitimate customers asking about these in the context of
  // a complaint strongly implies they were prompted by a third party.
  if (
    intents.has('otp_mention') ||
    intents.has('pin_mention') ||
    intents.has('password_mention') ||
    intents.has('link_mention')
  ) {
    return true;
  }
  // Suspicious action verbs near credentials also count.
  if (/\b(asked|asked for|requested|threatened|demand|share|tell|give|send|provide)\b[\s\S]{0,40}\b(otp|pin|password|card)\b/i.test(raw)) {
    return true;
  }
  if (/\b(block(?:ed)?|suspend)\b/i.test(raw) && /\b(account|number)\b/i.test(raw)) {
    return true;
  }
  return false;
}

function detectPromptInjection(raw: string): boolean {
  return (
    /ignore\s+(?:previous|all|above)\s+instructions?/i.test(raw) ||
    /\bsystem\s*[:：]\s*/i.test(raw) ||
    /\byou\s+are\s+now\s+(?:a|an)\s+/i.test(raw) ||
    /\bpretend\s+(?:you\s+are|to\s+be)/i.test(raw) ||
    /\b(jailbreak|dan\s*mode|developer\s*mode)\b/i.test(raw)
  );
}

function detectMentionedCounterparty(
  raw: string,
  phones: string[],
  merchantIds: string[],
  agentIds: string[],
): string | null {
  // Prefer phone if mentioned in the complaint (the counterparty is usually a phone number).
  if (phones.length > 0) return phones[0] ?? null;
  if (merchantIds.length > 0) return merchantIds[0] ?? null;
  if (agentIds.length > 0) return agentIds[0] ?? null;
  return null;
}

/**
 * Main entry point. Pure function — no I/O, no side effects.
 */
export function extract(request: TicketRequest): ComplaintExtraction {
  const raw = request.complaint ?? '';
  const normalized = banglaToAscii(raw).toLowerCase();

  const amounts = parseAmounts(raw);
  const phones = parsePhones(raw);
  const merchantIds = parseMerchantIds(raw);
  const agentIds = parseAgentIds(raw);
  const txnIds = parseTxnIds(raw);

  const timeKeyword = parseTimeKeyword(raw);
  const timeOfDayHour = parseTimeOfDayHour(raw);
  const intents = detectIntents(normalized, raw);

  const phishing = detectPhishingSignal(raw, intents);
  const promptInjectionInComplaint = detectPromptInjection(raw);
  const mentionedCounterparty = detectMentionedCounterparty(raw, phones, merchantIds, agentIds);

  const language = detectReplyLanguage(request.language, raw);

  return {
    ticketId: request.ticket_id,
    rawComplaint: raw,
    normalizedComplaint: normalized,
    language,
    amounts,
    primaryAmount: amounts[0] ?? null,
    phones,
    merchantIds,
    agentIds,
    txnIds,
    timeKeyword,
    timeOfDayHour,
    intents,
    phishing,
    promptInjectionInComplaint,
    mentionedCounterparty,
  };
}