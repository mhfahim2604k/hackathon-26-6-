# QueueStorm Investigator — Phase 0 Architecture Plan (Node.js)

> **Project:** SUST CSE Carnival 2026 · Codex Community Hackathon · Online Preliminary
> **Service:** `QueueStorm Investigator` — internal AI copilot for digital finance support agents
> **Stack:** TypeScript + Fastify + Zod + Node.js 20 + npm + Vitest + Supertest

---

## 1. Stack & Justification

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Compile-time safety across pipeline; mirrors Zod schemas |
| Runtime | Node.js 20 LTS | Modern, stable, judges' harnesses support it |
| Framework | Fastify 4 | Fast cold start, built-in JSON schema validation, low overhead, Pino logger built-in |
| Validation | Zod | Mirrors Pydantic v2 1:1; runtime + compile-time safety |
| Package manager | npm | Universal; lockfile committed |
| Testing | Vitest + Supertest | Fast, native TS, easy coverage via v8 |
| LLM | Optional OpenAI behind `OPENAI_API_KEY` env flag | Rules default; graceful fallback if no key |
| Time source | `new Date()` (UTC) per request | Stateless, no env override needed |
| Logging | Pino via Fastify | Structured JSON; secrets-redacting serializer |

> The official prompt specifies Python, but you confirmed **Node.js** for the implementation. The contracts (endpoints, schemas, enums, safety rules) remain identical — only the language differs.

---

## 2. Folder Structure

```
queuestorm-investigator/
├── src/
│   ├── server.ts                # Fastify bootstrap, route registration, error handler, listen
│   ├── routes/
│   │   ├── health.ts            # GET /health → {"status":"ok"}
│   │   └── analyzeTicket.ts     # POST /analyze-ticket — pipeline orchestration only
│   ├── schemas/
│   │   ├── request.ts           # Zod TicketRequest + TransactionEntry
│   │   ├── response.ts          # Zod TicketResponse (full output)
│   │   └── enums.ts             # All enums as Zod enums, case-sensitive
│   ├── types/
│   │   └── internal.ts          # ComplaintExtraction, MatchResult, Classification (TS interfaces)
│   ├── pipeline/
│   │   ├── extractor.ts         # Text mining ONLY — never classifies
│   │   ├── matcher.ts           # Transaction investigation ONLY — never classifies, never generates
│   │   ├── classifier.ts        # Decision engine — consumes matcher output
│   │   └── generator.ts         # Text generation — language-aware, optional LLM
│   ├── safety/
│   │   └── filter.ts            # Mandatory post-processor (only module allowed to mutate output text)
│   ├── llm/
│   │   └── client.ts            # Optional OpenAI client with rules fallback
│   ├── utils/
│   │   ├── bangla.ts            # Bangla digit conversion, script detection
│   │   ├── regex.ts             # All compiled regex (precomputed once)
│   │   ├── language.ts          # Reply-language detection
│   │   └── time.ts              # "today"/"yesterday"/ISO parsing helpers
│   └── config.ts                # Env vars, constants, thresholds, keyword sets
├── tests/
│   ├── schemas.test.ts          # All Zod validators + every enum value
│   ├── extractor.test.ts        # Arabic/Bangla digits, Banglish, phones, IDs, time, phishing, injection
│   ├── matcher.test.ts          # All score paths, duplicate, inconsistency, ambiguity, empty history
│   ├── classifier.test.ts       # All 8 case types, routing, severity, human_review
│   ├── generator.test.ts        # en/bn/mixed, tone by user_type, safe phrases, PIN warning
│   ├── safety.test.ts           # All 8 BLOCKED inputs, stack-trace stripping, API-key stripping
│   ├── api.test.ts              # /health, /analyze-ticket happy/error paths via Supertest
│   └── samples.test.ts          # All 10 public sample cases — exact functional equivalence
├── docs/
│   └── ARCHITECTURE.md          # This file
├── scripts/
│   └── verify.ts                # Final-checklist runner
├── samples.json                 # The 10 public sample cases (downloaded/embedded)
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── .dockerignore
├── .gitignore
├── .env.example
└── README.md
```

**Single-responsibility rule** (enforced via code review):
- `extractor.ts` never classifies
- `matcher.ts` never generates text, never classifies
- `classifier.ts` never generates text
- `generator.ts` never classifies, never scores transactions
- `safety/filter.ts` is the **only** module allowed to mutate or replace output text

---

## 3. Data Flow

```
HTTP POST /analyze-ticket
        │
        ▼
[1] Fastify schema validation (Zod, set via route schema)
        │  invalid JSON      → 400 {"error":"invalid_json",...}
        │  missing required  → 400 {"error":"missing_field",...}
        │  wrong enum        → 400 {"error":"invalid_enum",...}
        │  empty complaint   → 422 {"error":"empty_complaint"}
        ▼
[2] pipeline/extractor.extract(request)
        │  Bangla-digit normalize
        │  amount / phone / merchant / agent / txn-id regex
        │  Banglish keyword map
        │  phishing + prompt-injection indicators
        │  time references
        │  duplicate-detection scan (60s window)
        ▼
   ComplaintExtraction (plain TS interface)
        │
        ▼
[3] pipeline/matcher.match(extraction, transactionHistory)
        │  de-duplicate txns by transaction_id
        │  score each txn (amount ±5%, phone, MID, time ±2h, type, today/yesterday)
        │  duplicate payment detection (60s window)
        │  inconsistency detection (3+ counterparty, never-happened-but-completed, double-charge-with-one)
        │  ambiguity detection (equal scores within ±10)
        │  empty history short-circuit
        ▼
   MatchResult { relevant_transaction_id, evidence_verdict, scores, reason_codes }
        │
        ▼
[4] pipeline/classifier.classify(matchResult, extraction, request)
        │  case_type from signal table
        │  department routing
        │  severity + campaign bump (cap critical)
        │  human_review_required
        ▼
   Classification { case_type, department, severity, human_review_required,
                    confidence, reason_codes }
        │
        ▼
[5] pipeline/generator.generate(classification, matchResult, extraction, request)
        │  detect reply language (en | bn)
        │  tone by user_type (customer | merchant | agent | unknown)
        │  build agent_summary, recommended_next_action, customer_reply
        │  append PIN/OTP warning (en or bn)
        │  OPTIONAL: if OPENAI_API_KEY set → use LLM to rewrite customer_reply
        │  ALWAYS: if LLM fails or no key → use deterministic rules output
        ▼
   GeneratedDraft { agent_summary, recommended_next_action, customer_reply, language }
        │
        ▼
[6] safety/filter.sanitize(generated, request)
        │  scan customer_reply + recommended_next_action for:
        │    - credential request (PIN/OTP/password/card)
        │    - refund/reversal/unblock promise
        │    - suspicious third-party / external link
        │    - prompt injection in output
        │  scan all fields for:
        │    - stack traces
        │    - API key / token patterns
        │  on critical violation → replace customer_reply with safe fallback (en or bn)
        ▼
   FinalResponse (matches Zod TicketResponse)
        │
        ▼
HTTP 200 application/json
```

---

## 4. Rule Engine — 8 Case Types (exact strings)

| Signal (any match) | case_type | department | default severity |
|---|---|---|---|
| wrong number / bhul number / wrong person + transfer txn | `wrong_transfer` | `dispute_resolution` | high (≥5000 BDT) / medium |
| failed/pending status + "deducted/katlo/gone" / "balance deducted" | `payment_failed` | `payments_ops` | high |
| explicit refund/return request, no wrong-transfer claim | `refund_request` | `dispute_resolution` if contested, else `customer_support` | low–medium |
| duplicate payment flagged by matcher | `duplicate_payment` | `payments_ops` | high |
| merchant + "settlement/paihai/paid" + pending settlement txn | `merchant_settlement_delay` | `merchant_operations` | medium |
| agent + "cash in/joma" + cash_in txn pending/failed | `agent_cash_in_issue` | `agent_operations` | high |
| OTP/PIN/password mention, phishing signal, suspicious link | `phishing_or_social_engineering` | `fraud_risk` | critical |
| none of the above | `other` | `customer_support` | low |

**Severity escalation table:**
- Phishing / account compromise → always `critical`
- Wrong transfer ≥5000 BDT → `high`
- Duplicate / agent cash-in / unresolved pending → `high`
- Payment failed with possible deduction → `high`
- Wrong transfer <5000 BDT → `medium`
- Merchant settlement delay → `medium`
- Inconsistent evidence / ambiguous → `medium`
- Simple refund / vague → `low`
- `campaign_context` present → bump one level (cap `critical`)

**`human_review_required` rules:**
| Condition | Value |
|---|---|
| Disputes (`wrong_transfer`, contested `refund_request`) | `true` |
| Severity high or critical | `true` |
| `evidence_verdict = inconsistent` | `true` |
| `phishing_or_social_engineering` | `true` |
| Duplicate payment requiring biller verification | `true` |
| `evidence_verdict = insufficient_data` (ambiguous) | `false` — ask for clarification first |
| Low-severity, clear evidence, routine routing | `false` |

---

## 5. Transaction Matching Algorithm

For each unique transaction in `transaction_history`:

| Check | Score |
|---|---:|
| Amount exact match | +40 |
| Amount within ±5% | +25 |
| Phone / counterparty match (normalized to `+880...`) | +30 |
| Merchant / agent ID match | +30 |
| Time window match (within ±2h of mentioned time, parsed from complaint) | +20 |
| Transaction type aligns with complaint type | +15 |
| Timestamp is today / yesterday relative to request time | +10 |

**Selection rule:**
- Pick the highest-scoring txn
- If top score < 30 → no confident match
- If 2+ txns tie within ±10 of each other → ambiguous → return `null`

**Special cases (override normal selection):**

1. **Duplicate payment** — two txns share `amount`, `counterparty`, `type`, and timestamps within **60 seconds**:
   - `relevant_transaction_id` = the **second** (duplicate) txn
   - `evidence_verdict` = `consistent`
   - case_type = `duplicate_payment`

2. **Inconsistency detection:**
   - Wrong-transfer claim BUT same counterparty appears 3+ times in history → `inconsistent`
   - "Never happened" claim BUT status = `completed` → `inconsistent`
   - "Double charge" claim BUT only one matching txn → `inconsistent`

3. **Empty history** → `insufficient_data` + `null` + department `customer_support`

---

## 6. Safety Layer Design

`src/safety/filter.ts` is the **only** module allowed to mutate generated text. Every output passes through it.

### Pattern categories

| Category | Regex examples |
|---|---|
| Credential request | `enter\|share\|provide\|tell us\|send\|type` + ≤30 chars + `pin\|otp\|password\|card.?number` |
| Credential ownership | `your (pin\|otp\|password\|card)` |
| Credential assertion | `(pin\|otp\|password) (is\|was\|should be)` |
| Refund promise | `we (will\|shall\|are going to) (refund\|reverse\|return\|credit)` |
| Money-back promise | `your money (will\|shall) (be )?(back\|returned\|refunded)` |
| Refund guarantee | `guarantee` + ≤20 chars + `(refund\|return\|reverse)` |
| Account unblock | `account (will be )?unblocked` |
| Suspicious 3rd party | `call (this\|the) number`, `contact (agent\|person\|someone) at` |
| External link | `http(s)?://\S+`, `www\.\S+` |
| Prompt injection | `ignore (previous\|all\|above) instructions`, `system:`, `pretend you are`, `jailbreak`, `dan mode`, `developer mode` |
| Stack trace | `at \w+\.\w+ \(.+\.ts:\d+:\d+\)` |
| API key | `sk-[A-Za-z0-9]{20,}`, `AIza[0-9A-Za-z\-_]{35}`, `Bearer [A-Za-z0-9._\-]{20,}` |

### Replacement policy

| Violation | Action |
|---|---|
| Credential request in `customer_reply` | Replace entire field with safe fallback (en or bn) |
| Refund promise in `customer_reply` or `recommended_next_action` | Replace phrase with: *"Any eligible amount will be returned through official channels"* |
| Suspicious link in `customer_reply` | Strip link; append *"Contact us through official support channels only"* |
| Prompt injection in output | Replace with neutral acknowledgement |
| Stack trace in any field | Strip entirely |
| API key / token pattern in any field | Strip entirely |
| Two or more critical violations across one response | Whole response falls back to safe default |

### Safe fallback `customer_reply`

**English:**
> We have received your complaint and our team will review it shortly. Please do not share your PIN, OTP, or password with anyone. We will reach out through official support channels only.

**Bangla:**
> আমরা আপনার অভিযোগ পেয়েছি এবং আমাদের দল শীঘ্রই পর্যালোচনা করবে। অনুগ্রহ করে কারো সাথে আপনার পিন, ওটিপি বা পাসওয়ার্ড শেয়ার করবেন না। আমরা শুধুমাত্র অফিসিয়াল সাপোর্ট চ্যানেলে যোগাযোগ করব।

---

## 7. Regex Inventory (precompiled once at module load)

| Purpose | Pattern |
|---|---|
| Amount (Arabic) | `/\b(\d{1,8}(?:[,.\s]\d{3})*)\s*(?:taka\|tk\|৳\|bdt)?\b/gi` |
| Bangla digits | `/[০-৯]+/g` |
| Bangladesh phone | `/(?:\+?880\|0)?1[3-9]\d{8}/g` |
| Merchant ID | `/(?:MERCHANT\|BILLER\|MID)[-_]?\w+/gi` |
| Agent ID | `/AGENT[-_]?\w+/gi` |
| Transaction ID | `/TXN[-_]?\w+/gi` |
| Time keyword | `/\b(today\|yesterday\|morning\|evening\|noon\|kal\|aaj\|আজ\|কাল)\b/i` |
| Time of day | `/\b\d{1,2}(?::\d{2})?\s*(?:am\|pm)?\b/i` |
| Wrong-transfer signal | `/\b(wrong\|bhul\|ভুল)\s*(?:number\|person\|recipient)?/i` |
| Refund signal | `/\b(refund\|return\|ferot\|ফেরত)\b/i` |
| Phishing signal | `/\b(scam\|fraud\|hacked\|phish)\b/i` |
| Cash-in signal | `/\b(cash\s*in\|joma\|জমা)\b/i` |
| Settlement signal | `/\b(settle\|settlement\|paihai)\b/i` |
| Duplicate signal | `/\b(twice\|duplicate\|double\s*charge\|দুইবার)\b/i` |
| Failed/deducted | `/\b(failed\|deducted\|katlo\|কাটলো\|gone)\b/i` |
| Safety patterns | (see §6) |

All regex objects are **module-level constants** — no per-request compilation.

---

## 8. Language Detection

```ts
export function detectReplyLanguage(languageField: 'en' | 'bn' | 'mixed' | undefined,
                                    complaintText: string): 'en' | 'bn' {
  if (languageField === 'bn') return 'bn';
  if (languageField === 'en') return 'en';
  const banglaChars = [...complaintText].filter(c => c >= '\u0980' && c <= '\u09FF').length;
  return banglaChars > complaintText.length * 0.3 ? 'bn' : 'en';
}
```

**Reply language = complaint language** (with the explicit `language` field taking priority).

Banglish (romanized Bangla + English) → treated as English for reply, but Banglish keywords are still normalized via `BANGLISH_KEYWORDS` map during extraction.

---

## 9. Error Handling Matrix

| Failure | HTTP | Body shape |
|---|---|---|
| Invalid JSON | 400 | `{"error":"invalid_json","message":"Request body is not valid JSON"}` |
| Missing required field | 400 | `{"error":"missing_field","field":"complaint"}` |
| Wrong enum value | 400 | `{"error":"invalid_enum","field":"case_type"}` |
| Empty complaint | 422 | `{"error":"empty_complaint","message":"complaint field cannot be empty"}` |
| Internal exception | 500 | `{"error":"internal_error","message":"Non-sensitive message"}` — no stack, no secrets |
| Slow handler | timeout @ 25s | Fastify closes connection before 30s judge timeout |

**Global error handler** catches `Error`, `ZodError`, Fastify `FastifyError`. Always returns JSON, never HTML. Always logs to Pino (which never goes to response body).

---

## 10. Testing Strategy

Target: **≥95% coverage** (enforced via `vitest.config.ts` thresholds).

| File | What it covers |
|---|---|
| `schemas.test.ts` | All Zod validators, every enum value (case-sensitive) |
| `extractor.test.ts` | Arabic digits, Bangla digits, Banglish keywords, phone normalization, IDs, time refs, phishing signals, injection signals |
| `matcher.test.ts` | All score components, duplicate detection (60s window), inconsistency, ambiguity, empty history, de-dup by txn id |
| `classifier.test.ts` | All 8 case types, department routing, severity rules incl. campaign bump, human_review rules |
| `generator.test.ts` | en / bn / mixed, tone by user_type, safe phrase substitution, PIN warning append, LLM fallback path |
| `safety.test.ts` | All 8 BLOCKED inputs from spec, stack trace stripping, API-key stripping, critical-violation fallback |
| `api.test.ts` | `/health` 200, `/analyze-ticket` happy path, malformed JSON 400, empty complaint 422 |
| `samples.test.ts` | All 10 public sample cases — exact functional equivalence (txn id, verdict, case_type, department, severity, human_review) |

---

## 11. Edge Case Resilience (from prompt §HIDDEN TEST RESILIENCE)

| Edge case | Strategy |
|---|---|
| Empty `transaction_history` | `insufficient_data` + `customer_support` + null txn id |
| Missing optional fields | Defaults applied via Zod `.optional()` |
| Bangla digits | Normalize via `BANGLA_TO_ASCII` map before amount regex |
| Banglish | Keyword map in extractor |
| Malformed ISO timestamp | Try/catch on parse, fall back to today-only score |
| Duplicate txn IDs in history | De-duplicate by `transaction_id` once at matcher entry |
| Multiple equal-score matches | `insufficient_data`, never guess |
| Prompt injection in complaint | Safety filter on output; complaint still analyzed for evidence |
| Complaint >10k chars | Truncate to 5000 chars for extraction |
| Invalid enum in request | Zod rejects → 400 |
| Wrong `relevant_transaction_id` format | Validator in matcher: must exist in history |
| Mixed language | Per-character detection; dominant language wins for reply |
| Empty complaint string | 422 |
| `null` / missing `campaign_context` | No bump, no raise |
| Amount mentioned but no matching txn | `insufficient_data`, amount retained in summary |

---

## 12. Deployment

- **Dockerfile:** multi-stage — `node:20-alpine` builder (`npm ci`, `npm run build`) → `node:20-alpine` runtime (only `dist/` + `node_modules` prod deps). Target image <500MB.
- **Bind:** `0.0.0.0:${PORT:-8000}` via Fastify `listen()`
- **CMD:** `["node", "dist/server.js"]`
- **Health:** `/health` returns `{"status":"ok"}` immediately (no warmup)
- **No GPU, no model downloads, no large assets**
- **`.env.example`** ships with placeholders only (`OPENAI_API_KEY=`, `MODEL_NAME=`, `PORT=8000`)

---

## 13. Security & Secrets

- `.gitignore` blocks `.env`, `node_modules`, `dist`, `coverage`, `*.log`, `.DS_Store`
- `.env.example` contains placeholders only
- Real keys live only in:
  - Hosting platform env panel (Render/EC2/Railway/Fly/Vercel)
  - Or hackathon submission form's encrypted private field
- Pino logger redacts `req.headers.authorization`, `OPENAI_API_KEY`, any `api_key`/`token`-named field

---

## 14. Out of Scope

- Frontend / UI (per spec)
- Real database (state is request-scoped)
- Authentication / API keys for judges
- Paid LLM dependencies baked into image

---

## 15. Build Order (after approval)

1. `package.json`, `tsconfig.json`, `vitest.config.ts`
2. `src/config.ts`, `src/utils/*`
3. `src/schemas/enums.ts`, `src/schemas/request.ts`, `src/schemas/response.ts`, `src/types/internal.ts`
4. `src/pipeline/extractor.ts`
5. `src/pipeline/matcher.ts`
6. `src/pipeline/classifier.ts`
7. `src/pipeline/generator.ts` (+ `src/llm/client.ts`)
8. `src/safety/filter.ts`
9. `src/routes/health.ts`, `src/routes/analyzeTicket.ts`, `src/server.ts`
10. `Dockerfile`, `.dockerignore`, `.env.example`, `.gitignore`
11. `tests/*` (all 8 files)
12. `samples.json` (embedded) + `samples.test.ts`
13. `README.md`
14. Run `scripts/verify.ts` — the final checklist

---

**End of Phase 0. Awaiting approval to proceed to Phase 1.**
