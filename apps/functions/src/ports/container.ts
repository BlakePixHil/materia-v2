import type { Firestore } from 'firebase-admin/firestore';

import { DomainError } from '@materia/domain';

import { fakePorts } from './fakes';
import type { MailPort, Ports } from './index';
import { anthropicModel } from '../clerk/providers/anthropic';
import { adminDb } from '../core/admin';
import { isEmulator, useFakes } from '../core/env';
import { ANTHROPIC_API_KEY } from '../core/secrets';
import { cloudRunJobs } from '../jobs/cloud-run';

export const systemClock = { now: () => new Date() };

/** A port whose real adapter has not been built yet: every call fails clearly. */
function notConfigured<T extends object>(port: string): T {
  return new Proxy({} as T, {
    get: () => () => Promise.reject(new DomainError('UNAVAILABLE', `${port} has no production adapter yet`)),
  });
}

/**
 * The real adapters. Each feature ticket replaces its `notConfigured` entry (lazy-loading heavy
 * SDKs inside the adapter, not here).
 */
function realPorts(): Ports {
  return {
    clock: systemClock,
    mail: notConfigured('MailPort'), // FND-20 (Postmark)
    // AI-02 (ADR-011a). The key is read on first use, so only functions that declare the secret can call it.
    clerkModel: anthropicModel({ apiKey: () => ANTHROPIC_API_KEY.value() }),
    embedding: notConfigured('EmbeddingPort'), // AI-03
    calendar: notConfigured('CalendarPort'), // INT-01
    xero: notConfigured('XeroPort'), // BILL-08
    malwareScan: notConfigured('MalwareScanPort'), // CORE-12
    transcription: notConfigured('TranscriptionPort'), // MOB-03
    jobs: cloudRunJobs(), // FND-24
  };
}

let current: Ports | undefined;

/**
 * The emulator's mail: each message is written to `emulatorOutbox/{id}` (server-only), so e2e tests
 * and developers can open the links an email would carry (FND-17 invites).
 */
export function emulatorOutboxMail(db: () => Firestore): MailPort {
  return {
    async send(message) {
      const ref = await db()
        .collection('emulatorOutbox')
        .add({ ...message, sentAt: new Date() });
      return { id: ref.id };
    },
  };
}

/** Fakes in the emulator or with MATERIA_FAKES=1, real adapters otherwise. */
export function ports(): Ports {
  current ??= useFakes()
    ? { ...fakePorts(), clock: systemClock, ...(isEmulator() ? { mail: emulatorOutboxMail(adminDb) } : {}) }
    : realPorts();
  return current;
}

/** Tests: replace the container (call with no argument to reset). */
export function setPorts(next?: Ports): void {
  current = next;
}
