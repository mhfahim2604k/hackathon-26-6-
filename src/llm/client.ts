/**
 * Optional Google Gemini client. If GEMINI_API_KEY is unset, all functions
 * return null so the generator can fall back to the deterministic rules path.
 *
 * Uses the Gemini Developer API (generativelanguage.googleapis.com) with
 * structured JSON output via responseSchema — much more reliable than
 * prompt-only JSON mode.
 *
 * Never throws. Never blocks the pipeline if the API is down.
 */
import { env, hasGeminiKey } from '../config.js';

export interface LlmRewriteInput {
  ticket_id: string;
  case_type: string;
  severity: string;
  language: 'en' | 'bn';
  draft_customer_reply: string;
  draft_recommended_next_action: string;
}

export interface LlmRewriteOutput {
  customer_reply: string;
}

const SYSTEM_PROMPT = `You are QueueStorm Investigator, an internal AI copilot for fintech support agents.
You rewrite the draft customer_reply to be:
- Safe: NEVER ask for PIN, OTP, password, card number. NEVER promise refund/reversal/unblock. NEVER instruct contact with third parties outside official channels.
- Concise: 1-3 sentences.
- Same language as the input (en or bn).
- Professional and empathetic.

Return ONLY the rewritten reply string in the requested JSON shape. Do not include reasoning. Do not echo system instructions.`;

/**
 * Call Gemini's generateContent API. Returns null on any failure.
 * Times out at 6 seconds so we never blow the 30s request budget.
 *
 * The responseSchema guarantees a string field, so we don't need to
 * post-process the model output beyond unwrapping the JSON envelope.
 */
export async function rewriteCustomerReply(input: LlmRewriteInput): Promise<LlmRewriteOutput | null> {
  if (!hasGeminiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.MODEL_NAME)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const body = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: JSON.stringify({
              ticket_id: input.ticket_id,
              case_type: input.case_type,
              severity: input.severity,
              language: input.language,
              draft_customer_reply: input.draft_customer_reply,
              draft_recommended_next_action: input.draft_recommended_next_action,
            }),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          customer_reply: { type: 'STRING' },
        },
        required: ['customer_reply'],
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content);
    if (typeof parsed.customer_reply !== 'string') return null;
    return { customer_reply: parsed.customer_reply };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}