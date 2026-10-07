import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'demo-materia';
const ORG = 'org-trigger-drain';
/** Long enough for the biggest backlog a file leaves on a CI runner, inside the shard's six minutes. */
export const DRAIN_TIMEOUT_MS = 180_000;

/**
 * Waits until the Functions emulator has worked through the triggers queued so far: writes a
 * marker document and waits for audit-onOrgWrite's entry for it. The Firestore emulator delivers
 * trigger events in order, so once that exists everything queued before the marker has been
 * delivered. Used before each spec file (drain-triggers.ts), and by specs that must know their
 * own writes' triggers have run.
 */
export async function drain(): Promise<void> {
  const app = initializeApp({ projectId: PROJECT_ID }, `drain-${randomUUID()}`);
  try {
    const db = getFirestore(app);
    const path = `orgs/${ORG}/drainMarks/${randomUUID()}`;
    await db.doc(path).set({ at: new Date() });
    const audited = db.collection(`orgs/${ORG}/audit`).where('entity.path', '==', path).limit(1);
    const started = Date.now();
    while ((await audited.get()).empty) {
      if (Date.now() - started > DRAIN_TIMEOUT_MS - 5_000)
        throw new Error(`Triggers still queued after ${DRAIN_TIMEOUT_MS / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const waited = Date.now() - started;
    if (waited > 2_000) process.stdout.write(`Waited ${(waited / 1000).toFixed(1)} s for queued triggers\n`);
  } finally {
    await deleteApp(app);
  }
}
