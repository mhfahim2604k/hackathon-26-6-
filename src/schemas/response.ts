/**
 * Response schema for POST /analyze-ticket.
 * Field names, types, and enum values must match the spec EXACTLY.
 */
import { z } from 'zod';
import {
  CaseTypeSchema,
  DepartmentSchema,
  EvidenceVerdictSchema,
  SeveritySchema,
} from './enums.js';

export const TicketResponseSchema = z.object({
  ticket_id: z.string(),
  relevant_transaction_id: z.string().nullable(),
  evidence_verdict: EvidenceVerdictSchema,
  case_type: CaseTypeSchema,
  severity: SeveritySchema,
  department: DepartmentSchema,
  agent_summary: z.string(),
  recommended_next_action: z.string(),
  customer_reply: z.string(),
  human_review_required: z.boolean(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  reason_codes: z.array(z.string()).optional(),
});
export type TicketResponse = z.infer<typeof TicketResponseSchema>;
