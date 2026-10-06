import type { Firestore } from 'firebase-admin/firestore';

import { DomainError } from '@materia/domain';

import { fakePorts } from './fakes';
import type { MailPort, Ports } from './index';
import { anthropicModel } from '../clerk/providers/anthropic';
import { adminDb } from '../core/admin';
import { cloudTasks } from '../core/enqueue';
import { isEmulator, useFakes } from '../core/env';
import { cloudKms } from '../core/kms';
import { clamavScanUrl, previewServiceUrl } from '../core/params';
import { POSTMARK_TOKEN, secretValue } from '../core/secrets';
import { clamavScanner } from '../documents/clamav';
import { vertexEmbeddings } from '../documents/ingest/vertex';
import { previewService } from '../documents/preview';
import { emulatorSignedUrls, storageSignedUrls } from '../documents/signed-urls';
import { cloudRunJobs } from '../jobs/cloud-run';
import { mailFrom, postmarkMail } from '../mail/postmark';
import { emulatorPush, fcmPush } from '../notifications/push';

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
    // FND-20. The token is read on each send, so only functions that declare the secret can email;
    // without a value every send is `not_configured`.
    mail: postmarkMail({ token: () => secretValue(() => POSTMARK_TOKEN.value()), from: mailFrom }),
    push: fcmPush(), // FND-20
    tasks: cloudTasks,
    // AI-02a (ADR-011b): no platform key. Each call carries the org's own key, decrypted with KMS.
    clerkModel: anthropicModel(),
    clerkKms: cloudKms({ cryptoKey: 'clerk-api-keys' }),
    // AI-04 (ADR-012): Vertex AI text embeddings in australia-southeast1, as the runtime account.
    embedding: vertexEmbeddings({
      project: () => process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? '',
    }),
    calendar: notConfigured('CalendarPort'), // INT-01
    xero: notConfigured('XeroPort'), // BILL-08
    // CORE-12: ClamAV over HTTP. Until the scanner service is deployed (CLAMAV_SCAN_URL empty),
    // every upload stays quarantined as "Scanning delayed": fail closed.
    malwareScan: clamavScanner({ url: clamavScanUrl }),
    // CORE-12a: Office → PDF and HEIC → JPEG previews on Cloud Run.
    preview: previewService({ url: previewServiceUrl }),
    signedUrls: storageSignedUrls(), // CORE-12
    transcription: notConfigured('TranscriptionPort'), // MOB-03
    jobs: cloudRunJobs(), // FND-24
  };
}

let current: Ports | undefined;

/**
 * The emulator's mail: each message is written to `emulatorOutbox/{id}` (server-only), so e2e tests
 * and developers can open the links an email would carry (FND-17 invites) and preview it at the
 * dev mail page (FND-20).
 */
export function emulatorOutboxMail(db: () => Firestore): MailPort {
  return {
    async send(message) {
      // Attachments are listed by name and size: the bytes stay out of Firestore.
      const { attachments, ...rest } = message;
      const ref = await db()
        .collection('emulatorOutbox')
        .add({
          ...rest,
          ...(attachments?.length
            ? {
                attachments: attachments.map((file) => ({
                  name: file.name,
                  contentType: file.contentType,
                  sizeBytes: file.content.byteLength,
                })),
              }
            : {}),
          sentAt: new Date(),
        });
      return { id: ref.id };
    },
  };
}

/**
 * Fakes in the emulator or with MATERIA_FAKES=1, real adapters otherwise. The emulator keeps mail
 * and push in Firestore outboxes and runs Cloud Tasks for real (the emulator has them).
 */
export function ports(): Ports {
  current ??= useFakes()
    ? {
        ...fakePorts(),
        clock: systemClock,
        ...(isEmulator()
          ? {
              mail: emulatorOutboxMail(adminDb),
              push: emulatorPush(adminDb),
              tasks: cloudTasks,
              signedUrls: emulatorSignedUrls(),
            }
          : {}),
      }
    : realPorts();
  return current;
}

/** Tests: replace the container (call with no argument to reset). */
export function setPorts(next?: Ports): void {
  current = next;
}
