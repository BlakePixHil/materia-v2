import type { Firestore } from 'firebase-admin/firestore';

import {
  assessDisclosure,
  COSTS_CALLABLES,
  disclosureBasisCents,
  disclosureFormName,
  disclosureNeed,
  DomainError,
  GenerateDisclosureInput,
  longDate,
  MarkDisclosureSentInput,
  PERMISSIONS,
  SetDisclosureWaiverInput,
  sentStatus,
  SENDABLE_DISCLOSURE_STATUSES,
  today as todayIn,
  withDisclosureEvent,
  type CostsDisclosure,
  type DisclosureResult,
  type GenerateDisclosureResult,
  type MatterType,
} from '@materia/domain';

import { cleanDisclosure, disclosureOf, feeOf, openDisclosureTask } from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { generateDocument } from '../docs/generate';
import { storageFiles, type FileStore } from '../documents/files';
import { documentPath } from '../documents/shared';
import { matterPath, writableMatter } from '../matters/shared';
import { orgTimeZone } from '../templates/shared';

const FLAG = 'billing.costsDisclosure' as const;

/**
 * The template a band's disclosure is generated from: the firm's own published template that
 * replaces the built-in one (for the matter's type), else the built-in one (INT-06).
 */
export async function disclosureTemplateId(
  db: Firestore,
  orgId: string,
  systemId: string,
  matterType: MatterType | undefined,
): Promise<string> {
  const snap = await db.collection(`orgs/${orgId}/docTemplates`).where('replaces', '==', systemId).get();
  const own = snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .filter(({ data }) => {
      if (data['published'] !== true || (data['deletedAt'] !== undefined && data['deletedAt'] !== null)) return false;
      const types = Array.isArray(data['matterTypes']) ? (data['matterTypes'] as string[]) : [];
      return types.length === 0 || (!!matterType && types.includes(matterType));
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return own[0]?.id ?? systemId;
}

/**
 * `costs-generateDisclosure` (BILL-06; `billing.view`; flag `billing.costsDisclosure`; idempotent):
 * the disclosure for the matter's band, merged from the firm's template (or the built-in placeholder)
 * with the matter, client, fee and estimate, saved to the matter's documents as correspondence
 * tagged `costs-disclosure` (INT-06 `generateDocument`). After a disclosure has been given it is an
 * updated one, quoting the estimate given before. The matter keeps the document's id; audited as
 * `matter.disclosure_generated`.
 */
export function generateDisclosureDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: COSTS_CALLABLES.generateDisclosure,
    input: GenerateDisclosureInput,
    roles: PERMISSIONS['billing.view'],
    idempotent: true,
    memory: '512MiB',
    handler: async (ctx): Promise<GenerateDisclosureResult> => {
      const { input, orgId, uid, role, db, clock, ports, log, requestId } = ctx;
      await requireFlag({ orgId, db, clock }, FLAG);
      const ref = db.doc(matterPath(orgId, input.matterId));
      const matter = writableMatter(await ref.get(), role, input.matterId);
      const disclosure = disclosureOf(matter);
      const basis = disclosureBasisCents(feeOf(matter));
      const assessment = assessDisclosure({
        jurisdiction: String(matter['jurisdiction'] ?? ''),
        estimateHighCents: basis,
      });
      const templateId = await disclosureTemplateId(
        db,
        orgId,
        assessment.formTemplateId,
        matter['type'] as MatterType | undefined,
      );
      const updated = !!disclosure.sentOn;
      const previous = disclosure.sentEstimateCents ?? (updated ? disclosure.estimateCents : undefined);
      const now = clock.now();
      const day = todayIn(await orgTimeZone(db, orgId), now);
      const generated = await generateDocument(
        { db, files: files(), ports, clock, log },
        {
          orgId,
          uid,
          role,
          requestId,
          templateId,
          matterId: input.matterId,
          name: `${updated ? 'Updated costs disclosure' : 'Costs disclosure'} ${longDate(day)}`,
          category: 'correspondence',
          tags: ['costs-disclosure'],
          data: {
            disclosure: {
              form: disclosureFormName(assessment.requirement),
              ...(basis !== undefined ? { estimate: basis } : {}),
              ...(assessment.citation ? { citation: assessment.citation } : {}),
              ...(updated ? { updated: 'Updated' } : {}),
              ...(updated && previous !== undefined ? { previousEstimate: previous } : {}),
            },
          },
        },
      );

      await db.runTransaction(async (tx) => {
        const current = disclosureOf(writableMatter(await tx.get(ref), role, input.matterId));
        // A retry of a request that already recorded it.
        if (current.documentId === generated.documentId) return;
        const next: CostsDisclosure = {
          ...current,
          documentId: generated.documentId,
          history: withDisclosureEvent(current.history, {
            at: now,
            by: uid,
            action: 'generated',
            status: current.status,
            requirement: assessment.requirement,
            estimateCents: basis,
            documentId: generated.documentId,
          }),
        };
        tx.update(ref, { costsDisclosure: cleanDisclosure(next), ...stamp(uid, now, requestId) });
      });
      await audit(ctx, {
        action: 'matter.disclosure_generated',
        entity: { path: ref.path },
        summary: `Costs disclosure generated on matter ${input.matterId} from template ${templateId}`,
        data: {
          documentId: generated.documentId,
          templateId,
          updated,
          ...(assessment.requirement ? { requirement: assessment.requirement } : {}),
          ...(assessment.rulesVersion ? { rulesVersion: assessment.rulesVersion } : {}),
          missing: generated.missing.length,
        },
      });
      log.info('disclosure generated', {
        matterId: input.matterId,
        documentId: generated.documentId,
        templateId,
        updated,
        missing: generated.missing.length,
      });
      return {
        matterId: input.matterId,
        documentId: generated.documentId,
        name: generated.name,
        templateId,
        missing: generated.missing,
      };
    },
  } satisfies CallableDefinition<typeof GenerateDisclosureInput, GenerateDisclosureResult>;
}

export const generateDisclosure = defineCallable(generateDisclosureDefinition());

/**
 * `costs-markDisclosureSent` (BILL-06; `billing.view`; flag; idempotent): records the disclosure as
 * given on `sentOn` (today or earlier) by email, post or hand; nothing is sent from Materia yet. The
 * status becomes `sent`, or `updated` when one was given before; the estimate and band it was given
 * on are kept (later revisions are compared with them), the reminder clock stops and the open
 * disclosure task is completed. A waived disclosure is FAILED_PRECONDITION (`disclosure_waived`):
 * remove the waiver first. Audited as `matter.disclosure_sent`.
 */
export const markDisclosureSentDefinition = {
  name: COSTS_CALLABLES.markDisclosureSent,
  input: MarkDisclosureSentInput,
  roles: PERMISSIONS['billing.view'],
  idempotent: true,
  handler: async (ctx): Promise<DisclosureResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, FLAG);
    const now = clock.now();
    const day = todayIn(await orgTimeZone(db, orgId), now);
    if (input.sentOn > day) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid disclosure', {
        fields: { sentOn: ['The date it was sent can’t be after today'] },
      });
    }
    const ref = db.doc(matterPath(orgId, input.matterId));
    const result = await db.runTransaction(async (tx) => {
      const current = disclosureOf(writableMatter(await tx.get(ref), role, input.matterId));
      if (!SENDABLE_DISCLOSURE_STATUSES.includes(current.status)) {
        throw new DomainError('FAILED_PRECONDITION', 'No disclosure is needed on this matter: remove that first', {
          reason: 'disclosure_waived',
        });
      }
      const documentId = input.documentId ?? current.documentId;
      if (input.documentId) {
        const doc = await tx.get(db.doc(documentPath(orgId, input.matterId, input.documentId)));
        const data = doc.data();
        if (!doc.exists || !data || (data['deletedAt'] !== undefined && data['deletedAt'] !== null)) {
          throw new DomainError('INVALID_ARGUMENT', 'Invalid disclosure', {
            fields: { documentId: ['That document isn’t on this matter'] },
          });
        }
      }
      const task = await openDisclosureTask(tx, ref, current.taskId);
      const status = sentStatus(current);
      const estimate = current.basisEstimateCents ?? current.estimateCents;
      const next: CostsDisclosure = {
        ...current,
        status,
        sentOn: input.sentOn,
        sentMethod: input.method,
        sentEstimateCents: estimate,
        sentBandId: current.bandId,
        documentId,
        requiredSince: undefined,
        remindedOn: undefined,
        updateReasons: undefined,
        taskId: undefined,
        history: withDisclosureEvent(current.history, {
          at: now,
          by: uid,
          action: 'sent',
          status,
          requirement: current.requirement,
          estimateCents: estimate,
          documentId,
          note: `${input.method} on ${input.sentOn}`,
        }),
      };
      tx.update(ref, { costsDisclosure: cleanDisclosure(next), ...stamp(uid, now, requestId) });
      if (task) tx.update(task, { status: 'done', ...stamp(uid, now, requestId) });
      return { status, taskCompleted: !!task };
    });
    await audit(ctx, {
      action: 'matter.disclosure_sent',
      entity: { path: ref.path },
      summary: `Costs disclosure on matter ${input.matterId} recorded as ${result.status}`,
      data: { status: result.status, method: input.method, sentOn: input.sentOn, taskCompleted: result.taskCompleted },
    });
    log.info('disclosure sent', { matterId: input.matterId, status: result.status });
    return { matterId: input.matterId, status: result.status };
  },
} satisfies CallableDefinition<typeof MarkDisclosureSentInput, DisclosureResult>;

export const markDisclosureSent = defineCallable(markDisclosureSentDefinition);

/**
 * `costs-setDisclosureWaiver` (BILL-06; `matter.fee`: lawyer and above; flag; idempotent): records
 * that no disclosure is needed, with the reason (a commercial or government client, a sophisticated
 * client, or another reason with a note), which stops the reminders and completes the open
 * disclosure task; or with `waiver: null` removes it, and the estimate is assessed again. Audited
 * as `matter.disclosure_waived` or `matter.disclosure_waiver_removed`.
 */
export const setDisclosureWaiverDefinition = {
  name: COSTS_CALLABLES.setDisclosureWaiver,
  input: SetDisclosureWaiverInput,
  roles: PERMISSIONS['matter.fee'],
  idempotent: true,
  handler: async (ctx): Promise<DisclosureResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, FLAG);
    const now = clock.now();
    const day = todayIn(await orgTimeZone(db, orgId), now);
    const ref = db.doc(matterPath(orgId, input.matterId));
    const result = await db.runTransaction(async (tx) => {
      const matter = writableMatter(await tx.get(ref), role, input.matterId);
      const current = disclosureOf(matter);
      const waiver = input.waiver;
      if (!waiver && current.status !== 'waived') return { status: current.status, changed: false };
      if (
        waiver &&
        current.status === 'waived' &&
        current.waiver?.reason === waiver.reason &&
        (current.waiver.note ?? '') === (waiver.note ?? '')
      ) {
        return { status: current.status, changed: false };
      }
      const task = waiver ? await openDisclosureTask(tx, ref, current.taskId) : undefined;
      let next: CostsDisclosure;
      if (waiver) {
        next = {
          ...current,
          status: 'waived',
          waiver: { reason: waiver.reason, ...(waiver.note ? { note: waiver.note } : {}), by: uid, at: now },
          requiredSince: undefined,
          remindedOn: undefined,
          updateReasons: undefined,
          taskId: undefined,
          history: withDisclosureEvent(current.history, {
            at: now,
            by: uid,
            action: 'waived',
            status: 'waived',
            note: waiver.note,
          }),
        };
      } else {
        // Assessed again: back to sent when one was given before, else what the estimate needs now.
        const fee = feeOf(matter);
        const basis = disclosureBasisCents(fee);
        const assessment = assessDisclosure({
          jurisdiction: String(matter['jurisdiction'] ?? ''),
          estimateHighCents: basis,
        });
        const need = disclosureNeed(assessment, fee);
        const status = current.sentOn ? 'sent' : need.status;
        next = {
          ...current,
          status,
          requirement: assessment.requirement,
          bandId: assessment.band?.id,
          rulesVersion: assessment.rulesVersion,
          basisEstimateCents: basis,
          notRequiredReason: status === 'not_required' ? need.notRequiredReason : undefined,
          requiredSince: status === 'required' ? day : undefined,
          waiver: undefined,
          history: withDisclosureEvent(current.history, {
            at: now,
            by: uid,
            action: 'waiver_removed',
            status,
            requirement: assessment.requirement,
            estimateCents: basis,
          }),
        };
      }
      tx.update(ref, { costsDisclosure: cleanDisclosure(next), ...stamp(uid, now, requestId) });
      if (task) tx.update(task, { status: 'done', ...stamp(uid, now, requestId) });
      return { status: next.status, changed: true };
    });
    if (result.changed) {
      await audit(ctx, {
        action: input.waiver ? 'matter.disclosure_waived' : 'matter.disclosure_waiver_removed',
        entity: { path: ref.path },
        summary: input.waiver
          ? `Costs disclosure on matter ${input.matterId} recorded as not needed (${input.waiver.reason})`
          : `Costs disclosure waiver removed on matter ${input.matterId}`,
        data: { status: result.status, ...(input.waiver ? { reason: input.waiver.reason } : {}) },
      });
    }
    log.info('disclosure waiver set', { matterId: input.matterId, status: result.status, changed: result.changed });
    return { matterId: input.matterId, status: result.status };
  },
} satisfies CallableDefinition<typeof SetDisclosureWaiverInput, DisclosureResult>;

export const setDisclosureWaiver = defineCallable(setDisclosureWaiverDefinition);
