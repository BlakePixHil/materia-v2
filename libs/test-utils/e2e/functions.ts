import { expect, type APIRequestContext } from '@playwright/test';

/** The Emulator Suite's hub: `firebase emulators:exec` passes its address, firebase.json sets the port. */
const HUB = `http://${process.env['FIREBASE_EMULATOR_HUB'] ?? '127.0.0.1:4410'}`;

async function switchBackgroundTriggers(request: APIRequestContext, state: 'disable' | 'enable'): Promise<void> {
  const response = await request.put(`${HUB}/functions/${state}BackgroundTriggers`);
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Switches off the Functions emulator's background triggers (Firestore, Storage…) through the hub's
 * API for seeding, once the runs already started finish: the emulator drops the events of writes
 * made while they're off. It affects every test using the emulators, so only a test that runs on
 * its own may (the chromium-load project), and it switches them back on in an `afterEach` with
 * `enableBackgroundTriggers`, so a failure can't leave them off.
 */
export async function disableBackgroundTriggers(request: APIRequestContext): Promise<void> {
  await switchBackgroundTriggers(request, 'disable');
}

/** Switches the background triggers back on (the emulator reloads the functions to do it). */
export async function enableBackgroundTriggers(request: APIRequestContext): Promise<void> {
  await switchBackgroundTriggers(request, 'enable');
}
