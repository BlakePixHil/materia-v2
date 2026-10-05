import * as z from 'zod';

/**
 * Structured-output schemas, by the name a prompt's `outputSchema` uses. The gateway sends the
 * JSON schema derived from each (`output_config.format`) and validates the reply with zod again on
 * receipt; a reply that fails is `invalid_output`, never retried blindly (Clerk doc).
 */
export const HelloOutput = z.object({
  greeting: z.string().min(1).max(500),
  promptRef: z.string(),
});

export const OUTPUT_SCHEMAS = {
  hello: HelloOutput,
} as const satisfies Record<string, z.ZodType>;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;
