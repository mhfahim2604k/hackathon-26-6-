/**
 * Reply language detection.
 *
 * - Explicit `language` field wins when set to 'en' or 'bn'.
 * - Otherwise we infer from the script ratio of the complaint text.
 * - Banglish (romanized Bangla) is treated as 'en' for reply language
 *   because users expect English back, but the Banglish keywords are still
 *   normalized during extraction via the BANGLISH_KEYWORDS map.
 */
import { banglaRatio } from './bangla.js';

export type ReplyLanguage = 'en' | 'bn';
export type RequestLanguage = 'en' | 'bn' | 'mixed' | undefined;

export function detectReplyLanguage(
  languageField: RequestLanguage,
  complaintText: string,
): ReplyLanguage {
  if (languageField === 'bn') return 'bn';
  if (languageField === 'en') return 'en';
  // 'mixed' or undefined → script-based detection.
  // Threshold lowered to 0.2 because complaints often mix Bangla with English
  // punctuation, ASCII digits, and spaces — pure Bangla ratio is rarely > 0.3.
  return banglaRatio(complaintText) > 0.2 ? 'bn' : 'en';
}
