import type { Timestamp } from 'firebase-admin/firestore';
import * as z from 'zod';

import { clerkModelFor } from '@materia/clerk';
import {
  DEFAULT_CLERK_MODEL,
  DomainError,
  keyLast4,
  PERMISSIONS,
  RemoveClerkApiKeyInput,
  SetClerkApiKeyInput,
  SetClerkModelInput,
  type ClerkKeyStatus,
  type ClerkModelChoice,
  type SetClerkApiKeyResult,
} from '@materia/domain';

import { anthropicKeyPath } from './keyring';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireRecentLogin } from '../core/user-callable';
import { ClerkModelError } from '../ports';

/** The model id that needs Opus access on the key. */
const OPUS = 'claude-opus-5-5' satisfies ClerkModelChoice;

const iso = (value: unknown): string | undefined =>
  value && typeof (value as Timestamp).toDate === 'function' ? (value as Timestamp).toDate().toISOString() : undefined;

/**
 * `clerk-setApiKey` (AI-02a): an owner or admin saves the firm's own Anthropic API key. Needs a
 * sign-in within five minutes. The key is checked with one cheap call (list models) so a bad key
 * is never saved, encrypted with the `clerk-api-keys` KMS key (bound to the document path) and
 * stored in the server-only `integrations/anthropic` with its last four characters. Saving again
 * replaces it (last write wins; each save is audited). Neither the key nor its ciphertext is ever
 * logged, returned or audited. If the key can't see Opus 5.5 and the org was on Opus, the org
 * moves back to Sonnet 5.5.
 */
export const setApiKeyDefinition = {
  name: 'clerk-setApiKey',
  input: SetClerkApiKeyInput,
  roles: PERMISSIONS['clerk.configure'],
  idempotent: true,
  handler: async (ctx): Promise<SetClerkApiKeyResult> => {
    const { input, uid, orgId, db, clock, log, ports, token } = ctx;
    requireRecentLogin(token, clock.now().getTime(), 5);
    const last4 = keyLast4(input.apiKey);

    let models: string[];
    try {
      models = await ports.clerkModel.listModels(input.apiKey);
    } catch (error) {
      const kind = error instanceof ClerkModelError ? error.kind : 'unknown';
      log.warn('clerk key check failed', { kind, last4 });
      if (kind === 'auth') throw new DomainError('CLERK_KEY_INVALID', 'Anthropic rejected this API key');
      throw new DomainError('CLERK_UNAVAILABLE', 'Couldn’t reach Anthropic to check the key');
    }
    const opusAvailable = models.includes(OPUS);

    const path = anthropicKeyPath(orgId);
    const sealed = await ports.clerkKms.encrypt(input.apiKey, path);
    const at = clock.now();
    const orgRef = db.doc(`orgs/${orgId}`);
    const modelReset = await db.runTransaction(async (tx) => {
      const org = await tx.get(orgRef);
      const reset = !opusAvailable && org.get('settings.clerk.model') === OPUS;
      tx.set(db.doc(path), {
        provider: 'anthropic',
        uid: null,
        status: 'valid',
        scopes: [],
        encryptedApiKey: sealed.ciphertext,
        kmsKeyVersion: sealed.keyVersion,
        last4,
        setBy: uid,
        setAt: at,
        validatedAt: at,
        opusAvailable,
        createdAt: at,
        createdBy: uid,
        updatedAt: at,
        updatedBy: uid,
        schemaVersion: 1,
      });
      if (reset) tx.update(orgRef, { 'settings.clerk.model': DEFAULT_CLERK_MODEL, updatedAt: at, updatedBy: uid });
      return reset;
    });

    await audit(ctx, {
      action: 'clerk.api_key_set',
      entity: { path },
      summary: `Clerk Anthropic API key ending ${last4} saved`,
      data: { last4, opusAvailable, ...(modelReset ? { modelReset: true } : {}) },
    });
    log.info('clerk key saved', { last4, opusAvailable, modelReset });
    return { last4, validatedAt: at.toISOString(), opusAvailable, ...(modelReset ? { modelReset: true } : {}) };
  },
} satisfies CallableDefinition<typeof SetClerkApiKeyInput, SetClerkApiKeyResult>;

/** `clerk-removeApiKey` (AI-02a): deletes the org's key; Clerk is off for the org until a new one is saved. */
export const removeApiKeyDefinition = {
  name: 'clerk-removeApiKey',
  input: RemoveClerkApiKeyInput,
  roles: PERMISSIONS['clerk.configure'],
  idempotent: true,
  handler: async (ctx): Promise<{ removed: boolean }> => {
    const { orgId, db, log } = ctx;
    const path = anthropicKeyPath(orgId);
    const ref = db.doc(path);
    const last4 = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      tx.delete(ref);
      return (snapshot.get('last4') as string | undefined) ?? '';
    });
    if (last4 === null) return { removed: false };
    await audit(ctx, {
      action: 'clerk.api_key_removed',
      entity: { path },
      summary: `Clerk Anthropic API key ending ${last4} removed`,
      data: { last4 },
    });
    log.info('clerk key removed', { last4 });
    return { removed: true };
  },
} satisfies CallableDefinition<typeof RemoveClerkApiKeyInput, { removed: boolean }>;

/**
 * `clerk-setModel` (AI-02a): Sonnet 5.5 (the default) or Opus 5.5 for the whole org. Opus needs a
 * key that could see it when it was saved.
 */
export const setModelDefinition = {
  name: 'clerk-setModel',
  input: SetClerkModelInput,
  roles: PERMISSIONS['clerk.configure'],
  idempotent: true,
  handler: async (ctx): Promise<{ model: ClerkModelChoice }> => {
    const { input, uid, orgId, db, clock, log } = ctx;
    const orgRef = db.doc(`orgs/${orgId}`);
    const previous = await db.runTransaction(async (tx) => {
      const [org, key] = await Promise.all([tx.get(orgRef), tx.get(db.doc(anthropicKeyPath(orgId)))]);
      if (input.model === OPUS && key.exists && key.get('opusAvailable') === false) {
        throw new DomainError('FAILED_PRECONDITION', 'This API key can’t use Opus 5.5', { reason: 'opus_unavailable' });
      }
      const before = clerkModelFor(org.get('settings.clerk.model'));
      const at = clock.now();
      tx.update(orgRef, { 'settings.clerk.model': input.model, updatedAt: at, updatedBy: uid });
      return before;
    });
    if (previous !== input.model) {
      await audit(ctx, {
        action: 'clerk.model_changed',
        entity: { path: `orgs/${orgId}/settings/clerk` },
        summary: `Clerk model changed from ${previous} to ${input.model}`,
        data: { from: previous, to: input.model },
      });
    }
    log.info('clerk model set', { model: input.model });
    return { model: input.model };
  },
} satisfies CallableDefinition<typeof SetClerkModelInput, { model: ClerkModelChoice }>;

const StatusInput = z.object({});

/**
 * `clerk-getApiKeyStatus` (AI-02a): what Settings → Clerk shows owners and admins: whether a key is
 * saved, its last four characters, when it was checked, and the org's model. Never the key.
 */
export const getApiKeyStatusDefinition = {
  name: 'clerk-getApiKeyStatus',
  input: StatusInput,
  roles: PERMISSIONS['clerk.configure'],
  handler: async ({ orgId, db }): Promise<ClerkKeyStatus> => {
    const [org, key] = await Promise.all([db.doc(`orgs/${orgId}`).get(), db.doc(anthropicKeyPath(orgId)).get()]);
    const model = clerkModelFor(org.get('settings.clerk.model'));
    if (!key.exists) return { set: false, model };
    const setAt = iso(key.get('setAt'));
    const validatedAt = iso(key.get('validatedAt'));
    const opusAvailable = key.get('opusAvailable') as boolean | undefined;
    return {
      set: true,
      status: key.get('status') === 'invalid' ? 'invalid' : 'valid',
      last4: (key.get('last4') as string | undefined) ?? '',
      ...(setAt ? { setAt } : {}),
      ...(validatedAt ? { validatedAt } : {}),
      ...(opusAvailable !== undefined ? { opusAvailable } : {}),
      model,
    };
  },
} satisfies CallableDefinition<typeof StatusInput, ClerkKeyStatus>;

export const setApiKey = defineCallable(setApiKeyDefinition);
export const removeApiKey = defineCallable(removeApiKeyDefinition);
export const setModel = defineCallable(setModelDefinition);
export const getApiKeyStatus = defineCallable(getApiKeyStatusDefinition);
