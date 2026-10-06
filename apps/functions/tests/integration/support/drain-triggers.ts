import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Before each spec file: waits until the Functions emulator has worked through the triggers that
 * earlier files left queued.
 *
 * A shard's files share one set of emulators, and the Firestore emulator delivers trigger events
 * in order. A file that writes in bulk (contacts' 600-reference merge, clerk-context's task
 * fixtures) leaves thousands of events behind it: each write fires its own triggers, then the
 * audit entry each one writes fires audit-onOrgWrite and activity-onAudit again. On a CI runner
 * that backlog takes a minute or more to clear, and the next file's first trigger waits behind
 * it, so a test that polls for its own trigger's result for 45 s failed although the trigger ran
 * correctly once it was reached (fees.spec after contacts.spec, 2026-10-06).
 *
 * The barrier writes a marker document and waits for audit-onOrgWrite's entry for it: once that
 * exists, everything queued before the marker has been delivered. On a quiet emulator that takes
 * well under a second.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-trigger-drain';
/** Long enough for the biggest backlog a file leaves on a CI runner, inside the shard's six minutes. */
const DRAIN_TIMEOUT_MS = 180_000;

beforeAll(async () => {
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
    if (waited > 2_000) process.stdout.write(`Waited ${(waited / 1000).toFixed(1)} s for earlier files' triggers\n`);
  } finally {
    await deleteApp(app);
  }
}, DRAIN_TIMEOUT_MS);
