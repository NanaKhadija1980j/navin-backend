import { z } from 'zod';
import { PaymentStatus } from './payments.model.js';

const TokenEnum = z.enum(['XLMN', 'USDC', 'Other']);

export const CreatePaymentBodySchema = z
  .object({
    shipmentId: z.string().min(1),
    amount: z.number().positive('Amount must be positive'),
    /** Preferred field name going forward. */
    token: TokenEnum.optional(),
    /** @deprecated Alias for token — accepted for backward compatibility. */
    tokenType: TokenEnum.optional(),
    payerAddress: z.string().optional(),
    payeeAddress: z.string().optional(),
    status: z.nativeEnum(PaymentStatus).optional().default(PaymentStatus.PENDING),
  })
  .transform(data => ({
    ...data,
    // Coalesce: prefer explicit `token`, fall back to `tokenType`
    token: (data.token ?? data.tokenType) as 'XLMN' | 'USDC' | 'Other',
  }))
  .superRefine((data, ctx) => {
    if (!data.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either token or tokenType is required',
        path: ['token'],
      });
    }
  });

export const UpdatePaymentStatusBodySchema = z.object({
  status: z.nativeEnum(PaymentStatus),
  stellarTxHash: z.string().optional(),
});

export const PaymentIdParamSchema = z.object({
  id: z.string().min(1),
});

export const GetPaymentsQuerySchema = z.object({
  status: z.nativeEnum(PaymentStatus).optional(),
  organizationId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const DisputeSettlementBodySchema = z.object({
  reason: z.string().min(1, 'Reason is required'),
  notes: z.string().optional(),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentBodySchema>;
export type UpdatePaymentStatusInput = z.infer<typeof UpdatePaymentStatusBodySchema>;
export type GetPaymentsQuery = z.infer<typeof GetPaymentsQuerySchema>;
export type DisputeSettlementInput = z.infer<typeof DisputeSettlementBodySchema>;
