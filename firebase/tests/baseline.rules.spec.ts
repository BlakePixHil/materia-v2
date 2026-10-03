import { assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadString } from 'firebase/storage';

import { createRulesEnv } from './rules-env';

// Baseline until FND-14: everything is denied, for signed-in and anonymous users alike.
describe('baseline rules (deny all)', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await createRulesEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('denies Firestore reads and writes to anonymous users', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'orgs/org-test-1')));
    await assertFails(setDoc(doc(db, 'orgs/org-test-1'), { name: 'Example Legal' }));
  });

  it('denies Firestore access to signed-in users without a matching rule', async () => {
    const db = env.authenticatedContext('user-test-1', { orgId: 'org-test-1', role: 'owner' }).firestore();
    await assertFails(getDoc(doc(db, 'orgs/org-test-1/matters/matter-test-1')));
  });

  it('denies Storage reads and writes', async () => {
    const storage = env.authenticatedContext('user-test-1').storage();
    await assertFails(uploadString(ref(storage, 'orgs/org-test-1/probe.txt'), 'fictional'));
    await assertFails(getBytes(ref(storage, 'orgs/org-test-1/probe.txt')));
  });
});
