# QueueStorm Investigator

> Internal AI copilot for digital finance support agents. Analyzes customer
> complaints alongside transaction history and produces a structured
> investigation pack: matched transaction, evidence verdict, case type,
> department routing, severity, draft customer reply, and human-review flags.

Built for **SUST CSE Carnival 2026 — Codex Community Hackathon (Online Preliminary)**.

---

## Table of Contents

1. [Setup & Run](#setup--run)
2. [Architecture](#architecture)
3. [Evidence Reasoning Logic](#evidence-reasoning-logic)
4. [Matching Algorithm](#matching-algorithm)
5. [Safety Layer](#safety-layer)
6. [Rule Engine](#rule-engine)
7. [MODELS](#models)
8. [AI / Model Usage](#ai--model-usage)
9. [Deployment](#deployment)
10. [Environment Variables](#environment-variables)
11. [Sample Request & Response](#sample-request--response)
12. [Known Limitations](#known-limitations)
13. [Future Improvements](#future-improvements)
14. [Project Layout](#project-layout)
15. [Testing](#testing)

---

## Setup & Run

### Requirements

- **Node.js ≥ 20** (LTS recommended)
- **npm ≥ 9**

### Install

```bash
npm install
```

### Run (development, hot-reload)

```bash
npm run dev
```

### Build (compile TypeScript → `dist/`)

```bash
npm run build
```

### Run (production)

```bash
npm start
```

The server binds to `0.0.0.0:8000` by default (override with `PORT` env var).

### Run with Docker

```bash
docker build -t queuestorm-investigator .
docker run --rm -p 8000:8000 --env-file .env.example queuestorm-investigator
```

### Health check

```bash
curl http://localhost:8000/health
# → {"status":"ok","service":"queuestorm-investigator"}
```

---

## Architecture

The service is a small, deterministic **pipeline** with six strictly separated
stages. Each stage has exactly one responsibility and never crosses into the
domain of the next stage. The pipeline is fully type-safe via Zod schemas
(`.strict()` so unknown fields are rejected).

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  Validate  │ →  │  Extract   │ →  │   Match    │ →  │ Classify   │ →  │  Generate  │ →  │   Safety   │
│  (Zod)     │    │ (text-min) │    │ (scoring)  │    │ (decision) │    │  (draft)   │    │ (mutator)  │
└────────────┘    └────────────┘    └────────────┘    └────────────┘    └────────────┘    └────────────┘
                                                                                              │
                                                                                              ▼
                                                                                       ┌────────────┐
                                                                                       │  Respond   │
                                                                                       └────────────┘
```

| Stage | Module | Responsibility |
|-------|--------|----------------|
| 1. Validate | `schemas/request.ts` | Reject malformed input via Zod strict schema; reject unknown fields. |
| 2. Extract | `pipeline/extractor.ts` | Mine complaint text — amounts (Arabic + Bangla digits), phones, merchant/agent/txn IDs, time keywords, intent (Banglish map), phishing/injection signals, language. **Never classifies or scores.** |
| 3. Match | `pipeline/matcher.ts` | Score each transaction against the extraction; detect duplicate-payment pair (60s window); pick top scorer or return `insufficient_data` if ambiguous. **Never classifies, never generates text.** |
| 4. Classify | `pipeline/classifier.ts` | Decide `case_type`, `department`, `severity`, `human_review_required`, `confidence`. **Never generates text.** |
| 5. Generate | `pipeline/generator.ts` | Build a deterministic rules-based draft reply; optionally call Gemini to soften the wording (LLM never sees or returns classified fields — it only re-phrases the safe skeleton). |
| 6. Safety | `safety/filter.ts` | Scan the generated `customer_reply` for unsafe content (credential requests, refund promises, suspicious third parties, prompt injection, stack traces, API keys). **Only module allowed to mutate text.** |

### Request flow

```
POST /analyze-ticket
   │
   ▼
[validate] ── 400/422 on schema failure
   │
   ▼
[extract] ── ComplaintExtraction
   │
   ▼
[match] ── MatchResult { relevant_transaction_id, evidence_verdict, scores, ... }
   │
   ▼
[classify] ── Classification { case_type, department, severity, ... }
   │
   ▼
[generate] ── GeneratedDraft { customer_reply, internal_notes, ... }
   │
   ▼
[safety] ── sanitizes customer_reply; may swap to a safe fallback if violations
   │
   ▼
200 OK with TicketResponse (Zod-validated)
```

### Key design choices

- **Single-responsibility modules** — every pipeline stage is independently
  unit-tested; the matcher, for example, has no knowledge of `case_type` and
  can be reused in a different domain without modification.
- **Deterministic by default** — the same input always produces the same
  output. LLM is opt-in via env var.
- **Safety is the only text mutator** — the generator is free to write any
  draft; the safety layer guarantees the *output* is safe regardless of
  upstream bugs.
- **Strict Zod everywhere** — `.strict()` on the request schema prevents
  unknown fields from sneaking in.

---

## Evidence Reasoning Logic

Each complaint is reduced to a `ComplaintExtraction` (amounts, counterparties,
intent set, phishing/injection signals) by `pipeline/extractor.ts`. The
extractor follows these principles:

1. **Digit normalization first** — Bangla digits (০–৯) are converted to ASCII
   *before* any numeric regex runs.
2. **Phone normalization** — all Bangladesh phones are normalized to
   `+880XXXXXXXXXX` so the matcher compares apples to apples.
3. **Banglish keyword map** — common Bangla/romanized phrases are mapped to
   canonical intents (see `src/config.ts → BANGLISH_KEYWORDS`). Multi-word
   keys are matched as substrings.
4. **Phishing heuristic** — mentions of OTP / PIN / password / link alone
   count as a phishing signal; legitimate customer complaints don't bring
   these up unprompted.
5. **Prompt-injection detector** — looks for `ignore previous instructions`,
   `system:` (when not in a code block), `you are now a ...`, etc.
6. **Language detection** — explicit `language` field wins; otherwise the
   Bangla-character ratio decides (`>= 0.2` → `bn`).

The matcher then scores transactions against this extraction (see below).
The classifier reads `match + extraction` and decides case_type — it never
re-parses the raw complaint.

---

## Matching Algorithm

Implemented in `src/pipeline/matcher.ts`. Pure function, no I/O.

### Steps

1. **De-duplicate** by `transaction_id`.
2. **Duplicate-payment short-circuit** — sort by timestamp; if two adjacent
   transactions share type + amount + counterparty and are within
   `DUPLICATE_WINDOW_SECONDS = 60`, return the second one as the relevant
   transaction with verdict `consistent` and `duplicate_of` set to the first.
3. **Score each remaining txn** with seven weighted checks:

| Check | Score |
|-------|-------|
| Amount exact match | 40 |
| Amount within ±5% | 25 |
| Counterparty phone match | 30 |
| Counterparty ID match | 30 |
| Time within ±2h of complaint's time-of-day | 20 |
| Type alignment (transfer / payment / cash_in / settlement / refund / payment_failed) | 15 |
| Today / yesterday bonus | 10 |

   Additional conditional bonuses:
   - `payment_failed` intent + status `pending`/`failed` → +15
   - `settlement` / `delay` intent + status `pending` → +15

4. **Pick the top scorer**.
5. **Apply verdict rules**:
   - top score `< MATCH_THRESHOLD (30)` → `insufficient_data`
   - multiple txns within `AMBIGUITY_DELTA (10)` → `insufficient_data`
   - `wrong` intent + recipient appears ≥3 times in history → `inconsistent`
     (established-recipient pattern)
   - `not_received` intent + top txn is `completed` transfer with no failed
     alternative within delta → `inconsistent`
   - `duplicate` intent but only one matching txn → `inconsistent`
   - else → `consistent`

The matcher returns both the top scorer and the full `scores[]` array so the
classifier and generator can surface "why this transaction?" reasoning.

---

## Safety Layer

Implemented in `src/safety/filter.ts`. The safety layer is the **only** module
that may mutate the customer-facing text.

### Hard rules (enforced by `sanitize()`)

| Category | What we block |
|----------|---------------|
| `credential_request` | Any active request for PIN / OTP / password / card number. Negative lookbehind allows safe phrases like *"do not share your PIN"*, *"never ask for your OTP"*, *"we will never request your password"*. |
| `refund_promise` | *"we will refund"*, *"your money will be returned"*, *"we guarantee a refund"*. |
| `unblock_promise` | *"account will be unblocked"*, *"profile is being unblocked"*. |
| `suspicious_third_party` | *"call this number"*, *"contact this agent at ..."*, any `http://` / `https://` / `www.` link. |
| `prompt_injection` | *"ignore previous instructions"*, *"system:"*, *"you are now a ..."*. |
| `stack_trace` | `file.ts:42:13`-style references, V8 `at name (...file:line:col)` frames, `Error: SomeError`. |
| `api_key` | `sk-...` / `AIza...` / `Bearer ...` tokens (regex-based redaction). |

### Fallback policy

- **Any single critical violation** → the offending text is replaced with a
  safe, language-appropriate phrase (e.g. *"Any eligible amount will be
  returned through official channels."*).
- **Two or more distinct critical violation categories** → the entire
  `customer_reply` is replaced with `EN_FALLBACK_REPLY` / `BN_FALLBACK_REPLY`
  and a `multiple_critical_violations` tag is added to `safety_violations`.

### Why this matters

The safety layer is the last gate before text reaches the customer. Bugs in
the generator or unexpected LLM output cannot leak credentials or refund
promises past this layer — they are scanned with regexes that don't trust
the upstream stages at all.

---

## Rule Engine

Implemented as a small declarative table in `src/pipeline/classifier.ts`. Each
rule is a pure function of `(extraction, match_result, request)`:

| Case type | Trigger |
|-----------|---------|
| `phishing_or_social_engineering` | `extraction.phishing === true` (always wins). |
| `duplicate_payment` | `match.duplicate_of` is set (matched pair). |
| `wrong_transfer` | `wrong` intent + confident match, or `not_received` intent + amount + transfer-type txn in history. |
| `agent_cash_in_issue` | `cash_in` intent + match. |
| `merchant_settlement_delay` | `settlement` intent + match. |
| `payment_failed` | `payment_failed` intent + match. |
| `refund_request` | `refund` intent + match. |
| `other` | Fallback when no intent or no specifics. |

Severity is a function of `case_type + amount + verdict`:

| Case type | Base severity |
|-----------|---------------|
| phishing | critical |
| wrong_transfer (amount ≥ 5,000 BDT) | high |
| wrong_transfer (else) | medium |
| duplicate_payment | high |
| agent_cash_in_issue | high |
| payment_failed | high |
| merchant_settlement_delay | medium |
| refund_request | low |
| other | low |

Bumps:
- **Inconsistent verdict** → minimum medium.
- **`campaign_context`** → +1 severity level (capped at critical), but only
  when base is below `high`.

Human review is required when case type demands it (phishing, duplicate,
cash-in) **and** the verdict is confident; for wrong-transfer specifically,
insufficient_data means we still need more info from the customer first, so
human review is `false` until we have a confident verdict.

---

## MODELS

| Model | Where | Purpose |
|-------|-------|---------|
| **Rules engine** (deterministic, in-repo) | `src/pipeline/*`, `src/safety/filter.ts` | All classification, scoring, and customer_reply *structure*. |
| **Google Gemini `gemini-2.5-flash`** *(optional, env-gated)* | `src/llm/client.ts` | Softens the wording of the customer reply. **Never** sees or returns `case_type`, `severity`, or any classified field. Returns `null` on any failure → deterministic fallback. JSON output is enforced via `responseSchema`, not just prompting. |

No embeddings or fine-tuned models are used. All evidence reasoning is
hand-written scoring logic, not a learned model.

---

## AI / Model Usage

The pipeline is **hybrid**:

1. **Deterministic baseline** — extractor, matcher, classifier, and safety
   filter are 100% rule-based. They produce a fully-specified output on every
   request.
2. **Optional LLM rephrasing** — if `GEMINI_API_KEY` is set, the generator
   asks the model to rewrite a *safe skeleton* into a more natural-sounding
   customer reply. The model only sees:
   - the safe skeleton text (already passed safety checks),
   - the customer's complaint (to preserve tone),
   - the target language.
   The model **does not** see or return any classified field. If the LLM
   returns unsafe text, the safety layer rewrites it again before responding.
   If the LLM call fails (timeout, network, rate limit), we fall back to the
   deterministic skeleton — never throw to the caller.

This means the service degrades gracefully: no key = pure rules engine,
with key = rules engine + style polish.

### Why not LLM everywhere?

- The classification problem is **evidence-based**, not stylistic. A small
  hand-written scorer with seven weighted checks beats an LLM on
  reproducibility, latency, and auditability — all of which matter for a
  hackathon rubric that scores Evidence Reasoning at 35/100.
- Safety is hard to guarantee with an LLM-only path. By keeping the
  classifier and safety filter rule-based, we get **provable** compliance
  with the rubric's hard rules.

---

## Deployment

### Local

```bash
npm install
npm run dev      # development with hot-reload
# or
npm run build && npm start
```

### Docker

A multi-stage `Dockerfile` is provided:

1. **`deps`** — `npm ci` with full toolchain.
2. **`build`** — runs `tsc` and prunes dev deps.
3. **`runtime`** — `node:20-alpine`, non-root user, exposes 8000.

```bash
docker build -t queuestorm-investigator .
docker run --rm -p 8000:8000 --env-file .env.example queuestorm-investigator
```

### Any container host

Because the image is a plain Node.js 20 Alpine image, it runs anywhere:
- Fly.io / Render / Railway / Heroku
- AWS Fargate / ECS / EKS
- GCP Cloud Run / GKE
- Azure Container Apps / AKS

No external services, databases, or queues required. All state is per-request.

---

## Environment Variables

Copy `.env.example` to `.env` and edit. **Never commit `.env`.**

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8000` | HTTP listen port. |
| `GEMINI_API_KEY` | *(empty)* | Enables LLM rephrasing via Google Gemini. Get one at https://aistudio.google.com/apikey. Leave empty for deterministic mode. |
| `MODEL_NAME` | `gemini-2.5-flash` | Gemini model identifier used when `GEMINI_API_KEY` is set. |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |

The logger redacts known secret-shaped fields (`authorization`, `cookie`,
`password`, `pin`, `otp`, `apiKey`, etc.) automatically.

---

## Sample Request & Response

### Request

```bash
curl -s -X POST http://localhost:8000/analyze-ticket \
  -H 'Content-Type: application/json' \
  -d '{
    "ticket_id": "TKT-001",
    "complaint": "I sent 5000 taka to a wrong number around 2pm today. The number was supposed to be 01712345678 but I think I typed it wrong. The person isn'\''t responding to my call. Please help me get my money back.",
    "language": "en",
    "channel": "in_app_chat",
    "user_type": "customer",
    "campaign_context": "boishakh_bonanza_day_1",
    "transaction_history": [
      { "transaction_id": "TXN-9101", "timestamp": "2026-04-14T14:08:22Z", "type": "transfer", "amount": 5000, "counterparty": "+8801719876543", "status": "completed" },
      { "transaction_id": "TXN-9087", "timestamp": "2026-04-13T18:12:00Z", "type": "cash_in", "amount": 10000, "counterparty": "AGENT-512", "status": "completed" }
    ]
  }'
```

### Response (200 OK)

```json
{
  "ticket_id": "TKT-001",
  "language": "en",
  "case_type": "wrong_transfer",
  "department": "dispute_resolution",
  "severity": "high",
  "evidence_verdict": "consistent",
  "relevant_transaction_id": "TXN-9101",
  "duplicate_of": null,
  "confidence": 0.93,
  "human_review_required": true,
  "internal_notes": "TXN-9101 (transfer, 5000 BDT) matches complaint amount, time-of-day (2pm), and transfer type. Counterparty +8801719876543 differs from claimed 01712345678 — confirms 'wrong number' claim.",
  "customer_reply": "We have located your transfer of 5,000 BDT to +8801719876543 on 2026-04-14 at 14:08 UTC. Our dispute resolution team is reviewing the case and will contact you through official support channels only. Please do not share your PIN or OTP with anyone.",
  "reason_codes": ["wrong_transfer", "transaction_match", "human_review_required", "campaign_context"],
  "safety_violations": []
}
```

### Error response (400 / 422)

```json
{
  "error": "validation_error",
  "message": "Invalid request body",
  "details": [
    { "path": "transaction_history", "message": "Expected array, received string" }
  ]
}
```

---

## Known Limitations

- **Duplicate-window is 60 seconds** — matches the spec; broader windows
  (e.g. 5 minutes) would need a config flag and explicit user opt-in.
- **Phones only normalized for Bangladesh (+880)** — international numbers
  pass through as-is and are compared literally.
- **Banglish keyword map is finite** — uncommon romanizations of Bangla
  phrases may not be recognized; the customer gets routed to `other` /
  `insufficient_data` and a human is asked to clarify.
- **LLM mode is best-effort** — a 6-second timeout per call; any failure
  falls back to deterministic text. The deterministic path is always safe.
- **No persistence** — the service is stateless. Conversation history across
  tickets is not supported by design (the prompt asks for per-ticket
  analysis).
- **Phishing signal is heuristic** — false positives are possible (e.g. a
  customer saying *"I was asked for my PIN"* is correctly flagged as
  phishing, but a customer saying *"please tell me my PIN format"* for a
  legitimate reset flow may also be flagged). The verdict is always
  `insufficient_data` + `human_review_required=true` for phishing, so a
  human reviews before action is taken.
- **No internationalization beyond en/bn** — the script-ratio detector picks
  one of the two supported languages; everything else defaults to `en`.

---

## Future Improvements

1. **Configurable duplicate-window** — env var `DUPLICATE_WINDOW_SECONDS` to
   relax the 60s default.
2. **Embedding-based semantic intent classification** — for complaints that
   don't match any Banglish keyword. Would still sit behind the deterministic
   rule engine for safety.
3. **Persistent conversation context** — read recent ticket history per
   customer from a database to handle follow-ups ("I called yesterday about
   the same transfer").
4. **PII redaction in logs** — automatic masking of phone numbers / amounts
   in Pino output (currently only known secret-shaped fields are redacted).
5. **Streaming LLM output** — useful for long Bengali replies; currently we
   block on the full response.
6. **More locales** — Bangla dialects, Hindi, Urdu via script detection +
   translation pipeline.
7. **OpenTelemetry traces** — propagate `trace_id` from request to LLM call
   for end-to-end observability.
8. **Confidence calibration** — collect real agent feedback and recalibrate
   the per-case-type confidence formula.

---

## Project Layout

```
src/
  server.ts              Fastify bootstrap, JSON content-type parser, global error handler.
  config.ts              Env loading (Zod), scoring constants, keyword maps, safety regexes.
  routes/
    health.ts            GET /health
    analyzeTicket.ts     POST /analyze-ticket (pipeline orchestration)
  schemas/
    enums.ts             9 Zod enums (case-sensitive exact values)
    request.ts           TicketRequest + TransactionEntry schemas (strict)
    response.ts          TicketResponse schema (strict, matches spec)
  types/
    internal.ts          Internal types: ComplaintExtraction, MatchResult, Classification, etc.
  pipeline/
    extractor.ts         Text-mining — amounts, phones, intents, phishing/injection.
    matcher.ts           Score-based transaction matcher with duplicate-window detection.
    classifier.ts        Decision engine — case_type, department, severity, human_review.
    generator.ts         Deterministic draft + optional LLM rephrasing.
  safety/
    filter.ts            The only text-mutating module. Scans + sanitizes customer_reply.
  llm/
    client.ts            Optional Gemini client with 6s timeout, deterministic fallback.
  utils/
    bangla.ts            Digit conversion, phone normalization.
    language.ts          Script-ratio language detector.
    regex.ts             Precompiled regex inventory.
    time.ts              UTC-relative "today" / "yesterday" helpers.

tests/
  schemas.test.ts        Zod enum + request/response shape tests.
  extractor.test.ts      Extraction unit tests (amounts, phones, intents, BN digits).
  matcher.test.ts        Scoring + duplicate-pair + ambiguity tests.
  classifier.test.ts     Decision engine tests across all case types.
  generator.test.ts      Draft generation + LLM fallback tests.
  safety.test.ts         Each BLOCKED_SAFETY_INPUTS case must be sanitized.
  api.test.ts            End-to-end Fastify tests via Supertest + injected request.
  samples.test.ts        All 10 public sample cases must produce the expected output.

docs/
  ARCHITECTURE.md        Detailed Phase 0 architecture plan.

scripts/
  verify.ts              One-shot smoke test (build → start → curl /health → curl /analyze-ticket).
```

---

## Testing

```bash
npm test                  # run all 117 tests across 8 files
npm run test:coverage     # with v8 coverage (target ≥ 95%)
npm run verify            # build + boot + curl /health + curl /analyze-ticket
```

The test suite covers:

- Every Zod enum's case-sensitive exact values
- Bangla + Arabic digit parsing
- Phone normalization edge cases
- All 8 blocked safety inputs from the prompt
- All 10 public sample cases from the prompt
- Every HTTP error path (400 invalid JSON, 415 wrong content-type, 422 schema)
- The LLM-fallback path (deterministic when no `GEMINI_API_KEY`)

---

## License

Built for a hackathon. No license declared — treat as internal/educational use.
