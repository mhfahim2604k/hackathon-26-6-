/**
 * POST /analyze-ticket route handler.
 * Pipeline orchestration only — no business logic here.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { TicketRequestSchema } from '../schemas/request.js';
import { TicketResponseSchema } from '../schemas/response.js';
import { extract } from '../pipeline/extractor.js';
import { match } from '../pipeline/matcher.js';
import { classify } from '../pipeline/classifier.js';
import { generate } from '../pipeline/generator.js';
import { sanitize } from '../safety/filter.js';

export async function registerAnalyzeTicketRoute(app: FastifyInstance): Promise<void> {
  app.post('/analyze-ticket', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Manual Zod validation (Fastify's built-in schema uses JSON schema, not Zod).
      const parseResult = TicketRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'invalid_schema',
          message: 'Request body did not match schema',
          issues: parseResult.error.issues,
        });
      }
      const req = parseResult.data;

      // Empty complaint → 422.
      if (typeof req.complaint === 'string' && req.complaint.trim().length === 0) {
        return reply
          .code(422)
          .send({ error: 'empty_complaint', message: 'complaint field cannot be empty' });
      }

      // 1) Extract
      const extraction = extract(req);

      // 2) Match
      const matchResult = match(extraction, req.transaction_history ?? []);

      // 3) Classify
      const classification = classify(matchResult, extraction, req);

      // 4) Generate (text)
      const draft = await generate(classification, matchResult, extraction, req);

      // 5) Safety filter
      const safe = sanitize(draft, req.ticket_id, matchResult.relevant_transaction_id);

      // 6) Compose final response
      const response = {
        ...safe.output,
        evidence_verdict: matchResult.evidence_verdict,
        case_type: classification.case_type,
        severity: classification.severity,
        department: classification.department,
        human_review_required: classification.human_review_required,
        confidence: classification.confidence,
        reason_codes: [
          ...classification.reason_codes,
          ...matchResult.reason_codes.map((c) => `matcher:${c}`),
        ],
      };

      // Validate final response shape (defensive — should always pass).
      const validated = TicketResponseSchema.parse(response);

      // Audit log only — never include in response body.
      request.log.info(
        {
          ticket_id: req.ticket_id,
          case_type: classification.case_type,
          verdict: matchResult.evidence_verdict,
          safety_violations: safe.violations,
        },
        'ticket analyzed',
      );

      return reply.code(200).send(validated);
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({
          error: 'invalid_schema',
          message: 'Request body did not match schema',
          issues: err.issues,
        });
      }
      request.log.error({ err: err?.message }, 'analyze-ticket failed');
      return reply
        .code(500)
        .send({ error: 'internal_error', message: 'An internal error occurred. Please try again.' });
    }
  });
}