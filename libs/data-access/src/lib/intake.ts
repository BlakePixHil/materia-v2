import { inject } from '@angular/core';
import type { z } from 'zod';

import {
  IntakeDraft,
  intakeDraftFields,
  intakeDraftId,
  type CreateMatterInput,
  type CreateMatterResult,
  type IntakeDraftState,
  type IntakeStepId,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { MATTER_CALLABLES } from './matters';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';
import type { WithId } from './resources';

export type IntakeDraftItem = z.infer<typeof IntakeDraft.schema>;

/** The signed-in person's intake drafts in an org (at most a handful; sorted here, no index needed). */
export const INTAKE_DRAFTS_QUERY = (orgId: string): QuerySpec<IntakeDraftItem> => ({
  where: [
    ['orgId', '==', orgId],
    ['kind', '==', 'intake'],
  ],
  pageSize: 20,
});

/**
 * The signed-in person's New matter drafts (`users/{uid}/drafts/intake-{id}`, CORE-05), written
 * client-direct: private to them, in their current org, with a 30-day TTL. Call it in an
 * injection context.
 */
export function intakeDraftsRepository(): Repository<IntakeDraftItem> {
  const context = inject(OrgContext);
  return repo(() => `users/${context.requireUid()}/drafts`, IntakeDraft);
}

/**
 * Saves, finds and deletes intake drafts. `save` creates `intake-{key}` the first time and updates
 * it after that; a save that finds the draft gone (deleted elsewhere) creates it again.
 */
export class IntakeDrafts {
  private readonly saved = new Set<string>();

  constructor(
    private readonly repository: Repository<IntakeDraftItem>,
    private readonly orgId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The most recently saved draft in the current org, or null. */
  async latest(): Promise<WithId<IntakeDraftItem> | null> {
    const rows = await this.repository.query(INTAKE_DRAFTS_QUERY(this.orgId()));
    const sorted = [...rows].sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    const first = sorted[0] ?? null;
    if (first) this.saved.add(first.id);
    return first;
  }

  /** Writes the form state of draft `key` at `step`. */
  async save(key: string, step: IntakeStepId, state: IntakeDraftState): Promise<void> {
    const id = intakeDraftId(key);
    const fields = intakeDraftFields(this.orgId(), step, state, this.now());
    if (this.saved.has(id)) {
      try {
        await this.repository.update(id, { step, stateJson: fields.stateJson, expireAt: fields.expireAt });
        return;
      } catch (error) {
        // Gone (deleted in another tab): the rules see an update of nothing, so either code.
        const code = (error as { code?: string }).code;
        if (code !== 'NOT_FOUND' && code !== 'PERMISSION_DENIED') throw error;
      }
    }
    await this.repository.create(fields, { id });
    this.saved.add(id);
  }

  /** Deletes draft `key` (a draft never saved is a no-op). */
  async remove(key: string): Promise<void> {
    const id = intakeDraftId(key);
    await this.repository.hardDelete(id);
    this.saved.delete(id);
  }
}

/** A draft document id (`intake-abc`) → its key (`abc`). */
export function intakeDraftKey(docId: string): string {
  return docId.replace(/^intake-/, '');
}

/** `matters-createMatter` with the intake input; the input's `requestId` is sent (and reused on retry). */
export function createMatterFromIntake(
  client: Pick<CallableClient, 'call'>,
  input: z.input<typeof CreateMatterInput>,
): Promise<CreateMatterResult> {
  const { requestId, ...rest } = input;
  return client.call<typeof rest, CreateMatterResult>(MATTER_CALLABLES.create, rest, {
    idempotent: true,
    requestId,
  });
}
