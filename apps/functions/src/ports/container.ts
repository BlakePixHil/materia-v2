import { DomainError } from '@materia/domain';

import { fakePorts } from './fakes';
import type { Ports } from './index';
import { useFakes } from '../core/env';

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
    clerkModel: notConfigured('ClerkModelPort'), // AI-02 (Anthropic API)
    embedding: notConfigured('EmbeddingPort'), // AI-03
    calendar: notConfigured('CalendarPort'), // INT-01
    xero: notConfigured('XeroPort'), // BILL-08
    malwareScan: notConfigured('MalwareScanPort'), // CORE-12
    transcription: notConfigured('TranscriptionPort'), // MOB-03
    pdfRender: notConfigured('PdfRenderPort'), // FND-24
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
