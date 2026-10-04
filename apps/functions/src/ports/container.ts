import { DomainError } from '@materia/domain';

import { fakePorts } from './fakes';
import type { Ports } from './index';
import { anthropicModel } from '../clerk/providers/anthropic';
import { useFakes } from '../core/env';
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

/** Fakes in the emulator or with MATERIA_FAKES=1, real adapters otherwise. */
export function ports(): Ports {
  current ??= useFakes() ? { ...fakePorts(), clock: systemClock } : realPorts();
  return current;
}

/** Tests: replace the container (call with no argument to reset). */
export function setPorts(next?: Ports): void {
  current = next;
}
