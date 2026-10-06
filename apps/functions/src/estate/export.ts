import {
  DomainError,
  ExportInventoryInput,
  inventoryFileName,
  inventorySchedule,
  PERMISSIONS,
  SENSITIVE_REAUTH_MINUTES,
  today,
  type ExportInventoryResult,
  type InventoryAsset,
  type InventoryLiability,
} from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { createJob } from '../jobs/start-pdf';
import { contactNames, liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** The PDF template in the jobs image (`apps/jobs/templates/estate-inventory.html`). */
export const INVENTORY_TEMPLATE = 'estate-inventory';

/**
 * `estate-exportInventory` (CORE-16): renders the matter's inventory schedule ("Schedule of assets
 * and liabilities (working draft)") to PDF through the `pdf.render` job (FND-24) and saves it to the
 * matter's documents (category financial), privileged when the matter is (so only roles with
 * privileged.view can make or read it). The schedule is built here from the live register, never
 * from the caller's data, so the PDF matches the CSV the Estate tab downloads. An export, so it
 * needs a recent sign-in (SEC-04, REAUTH_REQUIRED).
 */
export const exportInventoryDefinition = {
  name: 'estate-exportInventory',
  input: ExportInventoryInput,
  roles: PERMISSIONS['document.upload'],
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  handler: async ({ input, ...ctx }) => {
    const { db, orgId, role, clock } = ctx;
    await requireFlag({ db, orgId, clock }, 'estate.register');
    const path = matterPath(orgId, input.matterId);
    const [orgSnap, matterSnap, assets, liabilities] = await Promise.all([
      db.doc(`orgs/${orgId}`).get(),
      db.doc(path).get(),
      db.collection(`${path}/assets`).get(),
      db.collection(`${path}/liabilities`).get(),
    ]);
    const matter = liveMatter(matterSnap, role, input.matterId);
    const deceased = matter['deceased'] as { contactId?: string; dateOfDeath?: string } | undefined;
    const names = deceased?.contactId ? await contactNames(db, orgId, [deceased.contactId]) : new Map<string, string>();
    const zone = orgSnap.get('timezone');
    const number = typeof matter['number'] === 'string' ? matter['number'] : input.matterId;
    const schedule = inventorySchedule({
      matterNumber: number,
      matterTitle: typeof matter['title'] === 'string' ? matter['title'] : '',
      deceasedName: deceased?.contactId ? names.get(deceased.contactId) : undefined,
      dateOfDeath: deceased?.dateOfDeath,
      preparedOn: today(typeof zone === 'string' && zone ? zone : undefined, clock.now()),
      assets: assets.docs.map((doc) => ({ ...(doc.data() as Data), id: doc.id }) as unknown as InventoryAsset),
      liabilities: liabilities.docs.map(
        (doc) => ({ ...(doc.data() as Data), id: doc.id }) as unknown as InventoryLiability,
      ),
    });
    if (!schedule.assetGroups.length && !schedule.outsideGroups.length && !schedule.liabilityGroups.length) {
      throw new DomainError('FAILED_PRECONDITION', 'The estate register is empty', { reason: 'estate_empty' });
    }
    const { jobId } = await createJob(ctx, {
      type: 'pdf.render',
      input: { templateId: INVENTORY_TEMPLATE, data: { ...schedule } },
      target: {
        kind: 'matter',
        matterId: input.matterId,
        name: inventoryFileName(number, 'pdf'),
        category: 'financial',
        privileged: matter['privileged'] === true,
      },
    });
    ctx.log.info('inventory export started', { matterId: input.matterId, jobId });
    return { jobId };
  },
} satisfies CallableDefinition<typeof ExportInventoryInput, ExportInventoryResult>;

export const exportInventory = defineCallable(exportInventoryDefinition);
