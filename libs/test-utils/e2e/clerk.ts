import type { APIRequestContext } from '@playwright/test';

import { setEmulatorDocument } from './firestore';
import { fakeKmsSeal } from './kms';

/** The key version the emulator's fake KMS reports. */
const FAKE_KMS_KEY_VERSION = 'fake-kms/cryptoKeyVersions/1';

/**
 * Stores a fictional Anthropic key for an org, as `clerk-setApiKey` would (AI-02a), so Clerk
 * answers with the emulator's fake model. Without one, Clerk says the practice must add its key.
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
}
