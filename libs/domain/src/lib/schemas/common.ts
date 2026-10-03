import { z } from 'zod';

import { DateOnlySchema } from '../values/date-only';
import { CentsSchema } from '../values/money';

/** An instant. Firestore Timestamps become JS Dates in the converters (ADR-008). */
export const InstantSchema = z.date();

/** A user id, or the system actors that write on behalf of no user. */
export const ActorSchema = z.string().min(1);

/** Document ids and uids: non-empty, no path separators. */
export const DocIdSchema = z
  .string()
  .min(1)
  .max(1500)
  .regex(/^[^/]+$/, { message: 'Ids cannot contain "/"' });

export const NonEmptyString = z.string().trim().min(1);

/** Fields every document carries (Architecture & ADRs, cross-cutting conventions). */
export const MetaShape = {
  createdAt: InstantSchema,
  createdBy: ActorSchema,
  updatedAt: InstantSchema,
  updatedBy: ActorSchema,
  schemaVersion: z.number().int().min(1),
};

/** Soft-delete fields, for deletable entities. */
export const SoftDeleteShape = {
  deletedAt: InstantSchema.optional(),
  deletedBy: ActorSchema.optional(),
};

/** Present on documents loaded by the legacy migration (Legacy migration plan). */
export const MigrationMetaShape = {
  migration: z.object({ runId: NonEmptyString, legacyPath: NonEmptyString, loadedAt: InstantSchema }).optional(),
  needsReview: z.array(z.string()).optional(),
};

export const META_KEYS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'schemaVersion'] as const;
export const SERVER_KEYS = [...META_KEYS, 'deletedAt', 'deletedBy', 'migration'] as const;

/**
 * Builds the four exports for an entity from its field shape:
 * - schema: the Firestore shape, with common meta fields (and soft-delete fields when deletable);
 * - create: the input for create callables (no meta, no server-owned fields);
 * - update: a partial, whitelisted subset of the create fields.
 */
type CreateShape<T extends z.ZodRawShape, K extends PropertyKey> = Omit<T, K>;
type UpdateShape<T extends z.ZodRawShape, N extends PropertyKey, K extends PropertyKey> = {
  [P in Exclude<N, K> & keyof T]: z.ZodOptional<T[P]>;
};

export function withMeta<
  T extends z.ZodRawShape,
  K extends keyof T & string = never,
  N extends keyof T & string = keyof T & string,
>(
  shape: T,
  options: {
    path: string;
    version?: number;
    softDelete?: boolean;
    migratable?: boolean;
    /** Fields set by the server only (counters, denormalised fields): excluded from create/update. */
    serverOwned?: readonly K[];
    /** Fields that may be changed after creation. Defaults to every create field. */
    updatable?: readonly N[];
  },
) {
  const fullShape = {
    ...shape,
    ...MetaShape,
    ...(options.softDelete ? SoftDeleteShape : {}),
    ...(options.migratable === false ? {} : MigrationMetaShape),
  };
  const serverOwned = new Set<string>(options.serverOwned ?? []);
  const createKeys = Object.keys(shape).filter((key) => !serverOwned.has(key));
  const updateKeys = ((options.updatable as readonly string[] | undefined) ?? createKeys).filter(
    (key) => !serverOwned.has(key),
  );
  const pickShape = (keys: string[]): z.ZodRawShape =>
    Object.fromEntries(keys.map((key) => [key, shape[key]])) as z.ZodRawShape;

  const schema = z.object(fullShape as T & typeof MetaShape).strict();
  const create = z.object(pickShape(createKeys)).strict() as unknown as z.ZodObject<CreateShape<T, K>, z.core.$strict>;
  const update = z.object(pickShape(updateKeys)).partial().strict() as unknown as z.ZodObject<
    UpdateShape<T, N, K>,
    z.core.$strict
  >;
  return { schema, create, update, version: options.version ?? 1, path: options.path };
}

/** A [documentId, page, quote] citation (Clerk rule 2). */
export const CitationSchema = z.object({
  documentId: DocIdSchema,
  page: z.number().int().min(1).optional(),
  quote: z.string().max(2000),
});

export const AddressSchema = z.object({
  type: z.enum(['residential', 'postal', 'business', 'other']),
  line1: NonEmptyString,
  line2: z.string().optional(),
  suburb: NonEmptyString,
  state: z.string().min(2).max(3),
  postcode: z.string().regex(/^\d{4}$/),
  country: z.literal('AU'),
});

/** E.164 phone number (legacy `04…` becomes `+614…` during migration). */
export const PhoneSchema = z.object({
  type: z.enum(['mobile', 'home', 'work', 'other']),
  number: z.string().regex(/^\+[1-9]\d{6,14}$/, { message: 'Expected an E.164 number such as +61412345678' }),
});

export const EmailSchema = z.object({
  type: z.enum(['personal', 'work', 'other']),
  address: z.email().transform((value) => value.toLowerCase()),
});

export { CentsSchema, DateOnlySchema };
