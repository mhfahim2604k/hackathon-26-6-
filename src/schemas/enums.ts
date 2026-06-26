/**
 * All enum definitions. Values are case-sensitive and MUST match the spec exactly.
 * Any variant (wrong case, plural, alternate spelling) is a schema violation.
 */
import { z } from 'zod';

// ----- request enums -----

export const LanguageSchema = z.enum(['en', 'bn', 'mixed']);
export type Language = z.infer<typeof LanguageSchema>;

export const ChannelSchema = z.enum([
  'in_app_chat',
  'call_center',
  'email',
  'merchant_portal',
  'field_agent',
]);
export type Channel = z.infer<typeof ChannelSchema>;

export const UserTypeSchema = z.enum(['customer', 'merchant', 'agent', 'unknown']);
export type UserType = z.infer<typeof UserTypeSchema>;

export const TransactionTypeSchema = z.enum([
  'transfer',
  'payment',
  'cash_in',
  'cash_out',
  'settlement',
  'refund',
]);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const TransactionStatusSchema = z.enum([
  'completed',
  'failed',
  'pending',
  'reversed',
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

// ----- response enums -----

export const EvidenceVerdictSchema = z.enum(['consistent', 'inconsistent', 'insufficient_data']);
export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;

export const CaseTypeSchema = z.enum([
  'wrong_transfer',
  'payment_failed',
  'refund_request',
  'duplicate_payment',
  'merchant_settlement_delay',
  'agent_cash_in_issue',
  'phishing_or_social_engineering',
  'other',
]);
export type CaseType = z.infer<typeof CaseTypeSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const DepartmentSchema = z.enum([
  'customer_support',
  'dispute_resolution',
  'payments_ops',
  'merchant_operations',
  'agent_operations',
  'fraud_risk',
]);
export type Department = z.infer<typeof DepartmentSchema>;
