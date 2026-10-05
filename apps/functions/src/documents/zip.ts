import type { DocumentSnapshot } from 'firebase-admin/firestore';

import {
  can,
  chunkWrites,
  DOCUMENT_CALLABLES,
  DOCUMENTS_ZIP_MAX_BYTES,
  DomainError,
  findVersion,
  PERMISSIONS,
  StartZipInput,
  zipDownloadNames,
  type StartZipResult,
} from '@materia/domain';

import { documentPath, isClean, versionsOf } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { createJob } from '../jobs/start-pdf';
import { liveMatter, matterPath } from '../matters/shared';

/**
 * `documents-startZip` (CORE-12b; `matter.view`, idempotent): starts a `documents.zip` export job
 * with the current version of each selected document of a live matter the caller can see.
 * Removed documents, documents not scanned clean and privileged documents the role can't see are
 * left out (counted, not an error), so readonly and paralegal zips never hold privileged
 * material; nothing left is FAILED_PRECONDITION (`nothing_to_zip`), and more than 1 GiB in all
 * `too_large`. Files are named as a single download would name them, made unique ("Will (2).pdf").
 * `createJob` checks every input again and starts the job; the member then downloads the zip
 * through `jobs-getExportUrl`.
 */
export const startZipDefinition = {
  name: DOCUMENT_CALLABLES.startZip,
  input: StartZipInput,
  roles: PERMISSIONS['matter.view'],
  idempotent: true,
  handler: async ({ input, ...ctx }): Promise<StartZipResult> => {
    const { db, orgId, role, log } = ctx;
    const matter = liveMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const refs = input.docIds.map((id) => db.doc(documentPath(orgId, input.matterId, id)));
    const snaps = (await Promise.all(chunkWrites(refs, 300).map((chunk) => db.getAll(...chunk)))).flat();
    const files: { storagePath: string; name: string; fileName: string; sizeBytes: number }[] = [];
    for (const snap of snaps as DocumentSnapshot[]) {
      const data = snap.data();
      if (!snap.exists || !data || isDeleted(data) || !isClean(data)) continue;
      if (!can(role, 'matter.view', { privileged: data['privileged'] === true })) continue;
      const version = findVersion({ version: data['version'], versions: versionsOf(data) });
      if (!version) continue;
      files.push({
        storagePath: version.storagePath,
        name: String(data['name'] ?? ''),
        fileName: version.fileName,
        sizeBytes: version.sizeBytes,
      });
    }
    if (!files.length) {
      throw new DomainError('FAILED_PRECONDITION', 'None of these documents can be downloaded', {
        reason: 'nothing_to_zip',
      });
    }
    if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > DOCUMENTS_ZIP_MAX_BYTES) {
      throw new DomainError('FAILED_PRECONDITION', 'These documents are too large for one zip', {
        reason: 'too_large',
      });
    }
    const names = zipDownloadNames(files);
    const { jobId, executionId } = await createJob(ctx, {
      type: 'documents.zip',
      input: { inputs: files.map((file, i) => ({ storagePath: file.storagePath, fileName: names[i] as string })) },
      target: { kind: 'export', name: `Documents ${String(matter['number'] ?? matter['title'] ?? input.matterId)}` },
    });
    const skipped = input.docIds.length - files.length;
    log.info('zip started', { matterId: input.matterId, jobId, included: files.length, skipped });
    return { jobId, executionId, included: files.length, skipped };
  },
} satisfies CallableDefinition<typeof StartZipInput, StartZipResult>;

export const startZip = defineCallable(startZipDefinition);
