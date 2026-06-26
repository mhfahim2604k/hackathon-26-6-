/**
 * Precompiled regex inventory. All patterns are module-level constants —
 * never recompiled per request.
 */

export const RE = {
  // Amount: 1–8 digits with optional thousand separators and currency hints.
  // Case-insensitive, global.
  amountArabic: /\b(\d{1,8}(?:[,. ]\d{3})*)\s*(?:taka|tk|৳|bdt)?\b/gi,

  // Bangla digit spans.
  banglaDigits: /[০-৯]+/g,

  // Bangladesh mobile (any of: +880171..., 880171..., 0171..., 171...).
  bdPhone: /(?:\+?880|0)?1[3-9]\d{8}/g,

  // Merchant / biller / MID IDs. Allows multi-segment IDs like MERCHANT-MOBILE-OP.
  merchantId: /(?:MERCHANT|BILLER|MID)[-_][A-Z0-9]+(?:[-_][A-Z0-9]+)*/gi,

  // Agent IDs.
  agentId: /AGENT[-_]?[A-Z0-9]+/gi,

  // Transaction IDs.
  txnId: /TXN[-_]?[A-Z0-9]+/gi,

  // Time keyword (English + Bangla).
  timeKeyword:
    /\b(today|tomorrow|yesterday|morning|evening|noon|afternoon|night|kal|aaj|আজ|কাল|গতকাল|আগামীকাল)\b/gi,

  // Time of day like "2pm", "14:30", "11 am".
  timeOfDay: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\b/g,

  // Wrong-transfer signal.
  wrongSignal: /\b(wrong\s*(?:number|person|recipient|transfer)?|bhul(?:\s*(?:number|person))?|ভুল)\b/i,

  // Refund / return signal.
  refundSignal: /\b(refund|return(?:\s+my)?|ferot|ফেরত)\b/i,

  // Phishing signal.
  phishingSignal:
    /\b(scam|fraud|hacked|phish(?:ing)?|otp|pin|password|account\s+(?:will\s+be\s+)?(?:blocked|unblocked))\b/i,

  // Cash-in signal.
  cashInSignal: /\b(cash[\s-]?in|joma|জমা)\b/i,

  // Settlement signal.
  settlementSignal: /\b(settle(?:ment)?|paihai)\b/i,

  // Duplicate signal.
  duplicateSignal: /\b(twice|duplicate|double[\s-]?charge|দুইবার|দুইবারে)\b/i,

  // Payment-failed signal.
  paymentFailedSignal:
    /\b(failed|deducted|katlo|কাটলো|কেটে\s*নিয়েছে|gone|missing)\b/i,

  // External URL (used to strip suspicious links).
  url: /https?:\/\/\S+|www\.\S+/gi,

  // Bangla Unicode range test (for script detection in utils/language.ts).
  // eslint-disable-next-line no-misleading-character-class
  banglaCharRange: /[\u0980-\u09FF]/,
} as const;
