import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

import { ROLES, PERMISSIONS } from '@materia/domain';
import { makeMatterDocument } from '@materia/test-utils';

import {
  createRulesEnv,
  ctx,
  MATTER,
  ORG,
  OTHER_ORG,
  seedAdmin,
  seedMembers,
  SUSPENDED_UID,
  uidFor,
} from './support/harness';

const MB = 1024 * 1024;
const PDF = { contentType: 'application/pdf' };
const bytes = (size: number) => new Uint8Array(size);

const storagePath = (documentId: string) => `${MATTER}/documents/${documentId}/v1`;
const pendingPath = (name = 'will.pdf') => `${MATTER}/pending/upload-1/${name}`;

let env: RulesTestEnvironment;

async function seedDocument(documentId: string, meta: { scan: string; privileged: boolean }) {
  await seedAdmin(env, (f) =>
    setDoc(doc(f, `${MATTER}/documents/${documentId}`), {
      ...makeMatterDocument(),
      scan: { status: meta.scan },
      privileged: meta.privileged,
    }),
  );
  await env.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(ref(context.storage(), storagePath(documentId)), bytes(16), PDF);
  });
}

beforeAll(async () => {
  env = await createRulesEnv();
  await env.clearFirestore();
  await env.clearStorage();
  await seedMembers(env);
  await seedDocument('clean', { scan: 'clean', privileged: false });
  await seedDocument('pending-scan', { scan: 'pending', privileged: false });
  await seedDocument('infected', { scan: 'infected', privileged: false });
  await seedDocument('privileged', { scan: 'clean', privileged: true });
});

afterAll(async () => {
  await env.cleanup();
});

describe('matter documents (stored versions)', () => {
  it.each(ROLES)('a clean, non-privileged file is readable by %s', async (role) => {
    await assertSucceeds(getBytes(ref(ctx(env, role).storage(), storagePath('clean'))));
  });

  it.each(ROLES)('a privileged file follows privileged.view for %s', async (role) => {
    const read = getBytes(ref(ctx(env, role).storage(), storagePath('privileged')));
    await ((PERMISSIONS['privileged.view'] as readonly string[]).includes(role)
      ? assertSucceeds(read)
      : assertFails(read));
  });

  it('files that are not scanned clean are not readable, even by the owner', async () => {
    const storage = ctx(env, 'owner').storage();
    await assertFails(getBytes(ref(storage, storagePath('pending-scan'))));
    await assertFails(getBytes(ref(storage, storagePath('infected'))));
  });

  it('denies another org, a suspended member and anonymous users', async () => {
    await assertFails(getBytes(ref(ctx(env, 'owner', OTHER_ORG).storage(), storagePath('clean'))));
    await assertFails(getBytes(ref(ctx(env, 'lawyer', ORG, SUSPENDED_UID).storage(), storagePath('clean'))));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), storagePath('clean'))));
  });

  it('clients never write or delete stored versions', async () => {
    const storage = ctx(env, 'owner').storage();
    await assertFails(uploadBytes(ref(storage, storagePath('clean')), bytes(16), PDF));
    await assertFails(uploadBytes(ref(storage, storagePath('new-doc')), bytes(16), PDF));
    await assertFails(deleteObject(ref(storage, storagePath('clean'))));
  });
});

describe('uploads to pending/', () => {
  it.each(ROLES)('upload as %s follows document.upload', async (role) => {
    const upload = uploadBytes(ref(ctx(env, role).storage(), pendingPath(`${role}.pdf`)), bytes(1024), PDF);
    await ((PERMISSIONS['document.upload'] as readonly string[]).includes(role)
      ? assertSucceeds(upload)
      : assertFails(upload));
  });

  it('accepts Office, image and email types; rejects executables and HTML', async () => {
    const storage = ctx(env, 'paralegal').storage();
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await assertSucceeds(uploadBytes(ref(storage, pendingPath('letter.docx')), bytes(64), { contentType: docx }));
    await assertSucceeds(uploadBytes(ref(storage, pendingPath('scan.jpg')), bytes(64), { contentType: 'image/jpeg' }));
    await assertSucceeds(
      uploadBytes(ref(storage, pendingPath('mail.eml')), bytes(64), { contentType: 'message/rfc822' }),
    );
    await assertFails(
      uploadBytes(ref(storage, pendingPath('tool.exe')), bytes(64), { contentType: 'application/x-msdownload' }),
    );
    await assertFails(uploadBytes(ref(storage, pendingPath('page.html')), bytes(64), { contentType: 'text/html' }));
  });

  it('accepts exactly 50 MB and rejects anything larger', async () => {
    const storage = ctx(env, 'lawyer').storage();
    await assertSucceeds(uploadBytes(ref(storage, pendingPath('max.pdf')), bytes(50 * MB), PDF));
    await assertFails(uploadBytes(ref(storage, pendingPath('too-big.pdf')), bytes(50 * MB + 1), PDF));
  });

  // Overwrites are `update`s in production (no rule allows them); the emulator treats them as creates.
  it('pending uploads cannot be read or deleted by clients', async () => {
    const storage = ctx(env, 'lawyer').storage();
    await assertSucceeds(uploadBytes(ref(storage, pendingPath('once.pdf')), bytes(16), PDF));
    await assertFails(getBytes(ref(storage, pendingPath('once.pdf'))));
    await assertFails(deleteObject(ref(storage, pendingPath('once.pdf'))));
  });

  it('denies another org, a suspended member and anonymous users', async () => {
    await assertFails(uploadBytes(ref(ctx(env, 'owner', OTHER_ORG).storage(), pendingPath('x.pdf')), bytes(16), PDF));
    await assertFails(
      uploadBytes(ref(ctx(env, 'lawyer', ORG, SUSPENDED_UID).storage(), pendingPath('y.pdf')), bytes(16), PDF),
    );
    await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), pendingPath('z.pdf')), bytes(16), PDF));
  });
});

describe('avatars', () => {
  const avatar = (uid: string) => `users/${uid}/avatar.png`;
  const PNG = { contentType: 'image/png' };

  it('the owner uploads an image up to 2 MB, replaces and deletes it', async () => {
    const storage = ctx(env, 'lawyer').storage();
    await assertSucceeds(uploadBytes(ref(storage, avatar(uidFor('lawyer'))), bytes(2 * MB), PNG));
    await assertSucceeds(uploadBytes(ref(storage, avatar(uidFor('lawyer'))), bytes(1024), PNG));
    await assertSucceeds(deleteObject(ref(storage, avatar(uidFor('lawyer')))));
  });

  it('rejects larger files, non-images and other users', async () => {
    const storage = ctx(env, 'lawyer').storage();
    await assertFails(uploadBytes(ref(storage, avatar(uidFor('lawyer'))), bytes(2 * MB + 1), PNG));
    await assertFails(uploadBytes(ref(storage, avatar(uidFor('lawyer'))), bytes(64), PDF));
    await assertFails(uploadBytes(ref(storage, avatar(uidFor('admin'))), bytes(64), PNG));
  });

  it('signed-in users read avatars; anonymous users do not', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), avatar(uidFor('admin'))), bytes(64), PNG);
    });
    await assertSucceeds(getBytes(ref(ctx(env, 'readonly').storage(), avatar(uidFor('admin')))));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), avatar(uidFor('admin')))));
  });
});

describe('everything else', () => {
  it('is denied', async () => {
    const storage = ctx(env, 'owner').storage();
    await assertFails(uploadBytes(ref(storage, `orgs/${ORG}/elsewhere/file.pdf`), bytes(16), PDF));
    await assertFails(getBytes(ref(storage, `orgs/${ORG}/elsewhere/file.pdf`)));
  });
});
