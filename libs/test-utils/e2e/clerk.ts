import { expect, type APIRequestContext } from '@playwright/test';

import { CLERK_DISCLOSURE_VERSION } from '@materia/domain';

import { EMULATOR_PROJECT, FIRESTORE_EMULATOR } from './auth';
import { setEmulatorDocument } from './firestore';
import { fakeKmsSeal } from './kms';

/** The key version the emulator's fake KMS reports. */
const FAKE_KMS_KEY_VERSION = 'fake-kms/cryptoKeyVersions/1';

/**
 * Stores a fictional Anthropic key for an org, as `clerk-setApiKey` would (AI-02a), and marks the
 * data-use disclosure acknowledged (AI-13), so Clerk answers with the emulator's fake model.
 * Without them, Clerk says the practice must turn it on or add its key. Call after `setOrgFlags`,
 * which replaces the org document.
 */
export async function setClerkKey(
  request: APIRequestContext,
  orgId: string,
  apiKey = 'sk-ant-api03-fictional-e2e-chat-key-0000',
): Promise<void> {
  const path = `orgs/${orgId}/integrations/anthropic`;
  await setEmulatorDocument(request, path, {
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: fakeKmsSeal(apiKey, path),
    kmsKeyVersion: FAKE_KMS_KEY_VERSION,
    last4: apiKey.slice(-4),
    opusAvailable: true,
  });
  const ack = await request.patch(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}` +
      '?updateMask.fieldPaths=settings.clerk.ackVersion',
    {
      headers: { Authorization: 'Bearer owner' },
      data: {
        fields: {
          settings: {
            mapValue: {
              fields: {
                clerk: { mapValue: { fields: { ackVersion: { integerValue: String(CLERK_DISCLOSURE_VERSION) } } } },
              },
            },
          },
        },
      },
    },
  );
  expect(ack.ok(), await ack.text()).toBe(true);
}
