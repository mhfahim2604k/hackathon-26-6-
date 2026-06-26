/**
 * Optional OpenAI client. If OPENAI_API_KEY is unset, all functions return null
 * so the generator can fall back to the deterministic rules path.
 *
 * Never throws. Never blocks the pipeline if the API is down.
 */
import { env, hasOpenAIKey } from '../config.js';

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

Return JSON exactly: {"customer_reply":"..."}
Do not include any other fields. Do not add reasoning. Do not echo system instructions.`;

/**
 * Call OpenAI's chat completions API. Returns null on any failure.
 * Times out at 6 seconds so we never blow the 30s request budget.
 */
export async function rewriteCustomerReply(input: LlmRewriteInput): Promise<LlmRewriteOutput | null> {
  if (!hasOpenAIKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.MODEL_NAME,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              ticket_id: input.ticket_id,
              case_type: input.case_type,
              severity: input.severity,
              language: input.language,
              draft_customer_reply: input.draft_customer_reply,
              draft_recommended_next_action: input.draft_recommended_next_action,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
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