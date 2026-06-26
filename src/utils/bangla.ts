/**
 * Bangla digit conversion + script detection.
 */

export const BANGLA_TO_ASCII: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

/**
 * Replace all Bangla digits in a string with their ASCII equivalents.
 * Used before amount extraction so the same regex works on both scripts.
 */
export function banglaToAscii(input: string): string {
  return input.replace(/[০-৯]/g, (ch) => BANGLA_TO_ASCII[ch] ?? ch);
}

/**
 * Count Bangla Unicode chars (U+0980..U+09FF) in a string.
 */
export function countBanglaChars(input: string): number {
  let count = 0;
  for (const ch of input) {
    if (ch >= '\u0980' && ch <= '\u09FF') count += 1;
  }
  return count;
}

/**
 * Ratio of Bangla characters to total characters.
 */
export function banglaRatio(input: string): number {
  if (input.length === 0) return 0;
  return countBanglaChars(input) / input.length;
}

/**
 * Normalize a Bangladesh phone number to +880XXXXXXXXXX form.
 * Accepts 017XXXXXXXX, 88017XXXXXXXX, +88017XXXXXXXX, 17XXXXXXXX.
 */
export function normalizeBdPhone(raw: string): string {
  if (!raw) return raw;
  const cleaned = raw.replace(/[\s-]/g, '');
  if (cleaned.startsWith('+880')) return cleaned;
  if (cleaned.startsWith('880')) return '+' + cleaned;
  if (cleaned.startsWith('0')) return '+880' + cleaned.slice(1);
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+880' + cleaned;
  return cleaned;
}
