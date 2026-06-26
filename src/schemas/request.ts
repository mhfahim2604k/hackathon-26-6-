/**
 * Request schema for POST /analyze-ticket.
 * Mirrors the Pydantic v2 contract from the problem statement exactly.
 */
import { z } from 'zod';
import {
  ChannelSchema,
  LanguageSchema,
  TransactionStatusSchema,
  TransactionTypeSchema,
  UserTypeSchema,
} from './enums.js';

export const TransactionEntrySchema = z.object({
  transaction_id: z.string().min(1),
  timestamp: z.string().min(1), // ISO 8601 string — validated downstream (parseIso) to allow flexibility
  type: TransactionTypeSchema,
  amount: z.number().finite().nonnegative(),
  counterparty: z.string().min(1),
  status: TransactionStatusSchema,
});
export type TransactionEntry = z.infer<typeof TransactionEntrySchema>;

export const TicketRequestSchema = z
  .object({
    ticket_id: z.string().min(1, 'ticket_id is required'),
    complaint: z.string(), // empty check happens in route handler so we can return 422
    language: LanguageSchema.optional(),
    channel: ChannelSchema.optional(),
    user_type: UserTypeSchema.optional(),
    campaign_context: z.string().optional(),
    transaction_history: z.array(TransactionEntrySchema).optional().default([]),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict(); // reject unknown fields

export type TicketRequest = z.infer<typeof TicketRequestSchema>;
