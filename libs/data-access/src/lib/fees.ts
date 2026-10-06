import type * as z from 'zod';

import { FEE_CALLABLES, type UpdateFeeInput, type UpdateFeeResult } from '@materia/domain';

import type { CallableClient } from './callable-client';

type Input<T> = Omit<T, 'requestId'>;

/** The `fees-*` callables (BILL-05). */
export interface FeeCallables {
  /**
   * `fees-update` (matter.fee: lawyer and above; flag billing.feeBudgets; idempotent): revises the
   * matter's fee arrangement with a reason. A new revision re-arms the budget alerts.
   */
  update(input: Input<z.input<typeof UpdateFeeInput>>, options?: { requestId?: string }): Promise<UpdateFeeResult>;
}

export function feeCallables(client: Pick<CallableClient, 'call'>): FeeCallables {
  return {
    update: (input, options = {}) =>
      client.call<Input<z.input<typeof UpdateFeeInput>>, UpdateFeeResult>(FEE_CALLABLES.update, input, {
        idempotent: true,
        ...options,
      }),
  };
}
