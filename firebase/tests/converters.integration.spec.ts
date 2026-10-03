import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, type FirestoreDataConverter } from 'firebase/firestore';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

import { adminConverter, firestoreConverter } from '@materia/domain/firestore';
import { ENTITY_FACTORIES } from '@materia/test-utils';

/**
 * FND-13: every factory output round-trips through the Firestore emulator, via the web SDK
 * converter and the Admin SDK converter, and comes back equal (Timestamps become Dates again).
 */
const entries = Object.entries(ENTITY_FACTORIES).map(([name, [entity, make]]) => ({
  name,
  entity: entity as unknown as { schema: never; version: number },
  value: (make as () => Record<string, unknown>)(),
}));

describe('converters round-trip through the Firestore emulator', () => {
  let env: RulesTestEnvironment;
  let admin: App;

  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'demo-materia' });
    admin = initializeApp({ projectId: 'demo-materia' }, 'converters-admin');
  });

  afterAll(async () => {
    await env.cleanup();
    await deleteApp(admin);
  });

  it.each(entries)('web SDK: $name', async ({ name, entity, value }) => {
    await env.withSecurityRulesDisabled(async (context) => {
      const converter = firestoreConverter(entity) as unknown as FirestoreDataConverter<Record<string, unknown>>;
      const ref = doc(context.firestore(), `roundtrip-web/${name}`).withConverter(converter);
      await setDoc(ref, value);
      const read = await getDoc(ref);
      expect(read.data()).toEqual(value);
    });
  });

  it.each(entries)('Admin SDK: $name', async ({ name, entity, value }) => {
    const converter = adminConverter(entity) as unknown as FirebaseFirestore.FirestoreDataConverter<
      Record<string, unknown>
    >;
    const ref = getAdminFirestore(admin).doc(`roundtrip-admin/${name}`).withConverter(converter);
    await ref.set(value);
    const read = await ref.get();
    expect(read.data()).toEqual(value);
  });
});
