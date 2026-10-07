import { drain, DRAIN_TIMEOUT_MS } from './drain';

/**
 * Before each spec file, and again before its first test: waits until the Functions emulator has
 * worked through the triggers queued so far.
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
 *
 * It runs again before the file's first test, after the file's own `beforeAll`: the data a file
 * seeds there queues triggers of its own, and on fresh emulators each function's first event waits
 * about 2 s for its worker to start, one function after another. suggestions.spec, first in its
 * shard, seeds documents that start a dozen functions, and its first test's task trigger began 25 s
 * after the accept, so the test's 30 s poll for the matter's open task count ran out on a slow run
 * (2026-10-07). Once per file: the tests' own writes are theirs to wait for.
 */
beforeAll(drain, DRAIN_TIMEOUT_MS);

let seeded = false;
beforeEach(async () => {
  if (seeded) return;
  seeded = true;
  await drain();
}, DRAIN_TIMEOUT_MS);
