import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

import { PERMISSIONS, ROLES, UPLOAD_EXTENSIONS, uploadContentType, uploadSettings, type Role } from '@materia/domain';
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
const SHA = 'c'.repeat(64);

let env: RulesTestEnvironment;

async function seedDocument(documentId: string, meta: { scan: string; privileged: boolean; deleted?: boolean }) {
  await seedAdmin(env, (f) =>
    setDoc(doc(f, `${MATTER}/documents/${documentId}`), {
      ...makeMatterDocument(),
      scan: { status: meta.scan },
      privileged: meta.privileged,
      ...(meta.deleted ? { deletedAt: new Date('2026-10-02T00:00:00Z'), deletedBy: uidFor('lawyer') } : {}),
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
  await seedDocument('removed', { scan: 'clean', privileged: false, deleted: true });
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

  it('a soft-deleted document’s files are not readable', async () => {
    await assertFails(getBytes(ref(ctx(env, 'owner').storage(), storagePath('removed'))));
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

describe('uploads to pending/ (CORE-12)', () => {
  let next = 0;
  /** A fresh upload id per call: each upload is a new object. */
  const uploadId = () => `upload-${String(++next).padStart(4, '0')}`;

  /** Uploads as `role` with the settings the web app uses (`uploadSettings`), plus overrides. */
  function upload(
    role: Role,
    options: {
      fileName?: string;
      size?: number;
      contentType?: string;
      metadata?: Record<string, string>;
      without?: string[];
      orgId?: string;
      uid?: string;
      path?: string;
    } = {},
  ) {
    const orgId = options.orgId ?? ORG;
    const uid = options.uid ?? uidFor(role, orgId);
    const fileName = options.fileName ?? 'Will (fictional).pdf';
    const customMetadata: Record<string, string> = { uploaderUid: uid, fileName, sha256: SHA, ...options.metadata };
    for (const key of options.without ?? []) delete customMetadata[key];
    const storage = ctx(env, role, orgId, uid).storage();
    const path = options.path ?? `orgs/${orgId}/matters/matter-1/pending/${uploadId()}`;
    return uploadBytes(ref(storage, path), bytes(options.size ?? 64), {
      contentType: options.contentType ?? uploadContentType(fileName) ?? 'application/octet-stream',
      customMetadata,
    });
  }

  it.each(ROLES)('upload as %s follows document.upload', async (role) => {
    await ((PERMISSIONS['document.upload'] as readonly string[]).includes(role)
      ? assertSucceeds(upload(role))
      : assertFails(upload(role)));
  });

  it('accepts what the web app’s uploadSettings produce, new documents and new versions alike', async () => {
    const storage = ctx(env, 'lawyer').storage();
    const settings = (extra: Partial<Parameters<typeof uploadSettings>[0]> = {}) =>
      uploadSettings({
        uid: uidFor('lawyer'),
        fileName: 'Letter to the executor (fictional).docx',
        sha256: SHA,
        ...extra,
      });
    await assertSucceeds(uploadBytes(ref(storage, `${MATTER}/pending/settings-1`), bytes(64), settings()));
    await assertSucceeds(
      uploadBytes(
        ref(storage, `${MATTER}/pending/settings-2`),
        bytes(64),
        settings({ documentId: 'clean', category: 'correspondence', privileged: true }),
      ),
    );
  });

  it.each(UPLOAD_EXTENSIONS)('accepts .%s with its exact content type', async (ext) => {
    await assertSucceeds(upload('paralegal', { fileName: `Fictional file.${ext.toUpperCase()}` }));
  });

  it('rejects other extensions, a wrong content type and names without an extension', async () => {
    await assertFails(upload('paralegal', { fileName: 'tool.exe', contentType: 'application/x-msdownload' }));
    await assertFails(upload('paralegal', { fileName: 'page.html', contentType: 'text/html' }));
    await assertFails(upload('paralegal', { fileName: 'photo.gif', contentType: 'image/gif' }));
    await assertFails(upload('paralegal', { fileName: 'letter.pdf', contentType: 'text/html' }));
    await assertFails(upload('paralegal', { fileName: 'letter.docx', contentType: 'application/octet-stream' }));
    await assertFails(upload('paralegal', { fileName: 'README', contentType: 'text/plain' }));
    await assertFails(upload('paralegal', { fileName: `${'x'.repeat(252)}.pdf` }));
  });

  it('requires the uploader, file name and hash, and no other keys', async () => {
    await assertFails(upload('lawyer', { without: ['uploaderUid'] }));
    await assertFails(upload('lawyer', { without: ['fileName'] }));
    await assertFails(upload('lawyer', { without: ['sha256'] }));
    await assertFails(upload('lawyer', { metadata: { uploaderUid: uidFor('owner') } }));
    await assertFails(upload('lawyer', { metadata: { sha256: 'NOT-A-HASH' } }));
    await assertFails(upload('lawyer', { metadata: { sha256: SHA.toUpperCase() } }));
    await assertFails(upload('lawyer', { metadata: { scan: 'clean' } }));
  });

  it('checks the category and lets only privileged.view roles mark an upload privileged', async () => {
    await assertSucceeds(upload('paralegal', { metadata: { category: 'will' } }));
    await assertFails(upload('paralegal', { metadata: { category: 'spreadsheet' } }));
    await assertSucceeds(upload('paralegal', { metadata: { privileged: 'false' } }));
    await assertFails(upload('paralegal', { metadata: { privileged: 'true' } }));
    await assertFails(upload('lawyer', { metadata: { privileged: 'yes' } }));
    await assertSucceeds(upload('lawyer', { metadata: { privileged: 'true' } }));
  });

  it('a new version targets a live, clean document the uploader can see', async () => {
    await assertSucceeds(upload('paralegal', { metadata: { documentId: 'clean' } }));
    await assertFails(upload('paralegal', { metadata: { documentId: 'privileged' } }));
    await assertSucceeds(upload('lawyer', { metadata: { documentId: 'privileged' } }));
    await assertFails(upload('lawyer', { metadata: { documentId: 'pending-scan' } }));
    await assertFails(upload('lawyer', { metadata: { documentId: 'infected' } }));
    await assertFails(upload('lawyer', { metadata: { documentId: 'removed' } }));
    await assertFails(upload('lawyer', { metadata: { documentId: 'no-such-document' } }));
  });

  it('accepts exactly 50 MB, and rejects empty files and anything larger', async () => {
    await assertSucceeds(upload('lawyer', { size: 50 * MB }));
    await assertFails(upload('lawyer', { size: 50 * MB + 1 }));
    await assertFails(upload('lawyer', { size: 0 }));
  });

  it('upload ids are 8 to 64 URL-safe characters, one object each (no sub-paths)', async () => {
    const at = (id: string) => `${MATTER}/pending/${id}`;
    await assertFails(upload('lawyer', { path: at('short') }));
    await assertFails(upload('lawyer', { path: at('x'.repeat(65)) }));
    await assertFails(upload('lawyer', { path: at('has.dot.inside') }));
    await assertFails(upload('lawyer', { path: `${at('upload-nested')}/Will.pdf` }));
    await assertSucceeds(upload('lawyer', { path: at('0f8fad5b-d9cb-469f-a165-70867728950e') }));
  });

  // Overwrites are `update`s in production (no rule allows them); the emulator treats them as creates.
  it('pending uploads cannot be read or deleted by clients, even the uploader', async () => {
    const path = `${MATTER}/pending/upload-read-1`;
    await assertSucceeds(upload('lawyer', { path }));
    for (const role of ROLES) {
      const storage = ctx(env, role).storage();
      await assertFails(getBytes(ref(storage, path)));
      await assertFails(deleteObject(ref(storage, path)));
    }
  });

  it('denies another org, a suspended member and anonymous users', async () => {
    await assertFails(upload('owner', { orgId: OTHER_ORG, path: `orgs/${ORG}/matters/matter-1/pending/upload-other` }));
    await assertFails(upload('lawyer', { uid: SUSPENDED_UID }));
    const anonymous = env.unauthenticatedContext().storage();
    await assertFails(
      uploadBytes(ref(anonymous, `${MATTER}/pending/upload-anon`), bytes(16), {
        contentType: 'application/pdf',
        customMetadata: { uploaderUid: 'nobody', fileName: 'x.pdf', sha256: SHA },
      }),
    );
  });
});

describe('renditions (CORE-12)', () => {
  it('are never readable directly (signed URLs only)', async () => {
    const path = `${MATTER}/documents/clean/renditions/v1/preview.pdf`;
    await env.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), path), bytes(16), PDF);
    });
    await assertFails(getBytes(ref(ctx(env, 'owner').storage(), path)));
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
