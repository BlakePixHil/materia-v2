import { assertAuthReadable, assertReadOnly, checkReadOnly, NotReadOnlyError, REQUIRED_READS } from './iam.ts';
import type { IamTester } from '../legacy/rest.ts';

/** A fake IAM that grants `granted` out of whatever is asked (the testIamPermissions contract). */
function fakeIam({ project = [] as string[], bucket = [] as string[] } = {}): IamTester & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async project(permissions) {
      asked.push([...permissions]);
      return permissions.filter((p) => project.includes(p));
    },
    async bucket(permissions) {
      asked.push([...permissions]);
      return permissions.filter((p) => bucket.includes(p));
    },
  };
}

const VIEWER = [...REQUIRED_READS, 'firebaseauth.users.get'];

describe('the read-only guard', () => {
  it('passes the read-only migration account', async () => {
    const check = await assertReadOnly(fakeIam({ project: VIEWER }));
    expect(check).toMatchObject({ writes: [], missingReads: [], authReadable: true });
    expect(check.granted).toEqual([...VIEWER].sort());
  });

  it('refuses credentials that can write data', async () => {
    const iam = fakeIam({ project: [...VIEWER, 'datastore.entities.update'] });
    await expect(assertReadOnly(iam)).rejects.toThrow(NotReadOnlyError);
    await expect(assertReadOnly(iam)).rejects.toThrow(/can write \(datastore\.entities\.update\)/);
  });

  it('refuses credentials that could change IAM or mint keys, as an owner or editor could', async () => {
    for (const permission of [
      'resourcemanager.projects.setIamPolicy',
      'iam.serviceAccountKeys.create',
      'firebaserules.releases.update',
    ]) {
      await expect(assertReadOnly(fakeIam({ project: [...VIEWER, permission] }))).rejects.toThrow(permission);
    }
  });

  it('refuses a bucket-level write grant the project policy does not show', async () => {
    const error = await assertReadOnly(fakeIam({ project: VIEWER, bucket: ['storage.objects.create'] })).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(NotReadOnlyError);
    expect((error as NotReadOnlyError).check.writes).toEqual(['bucket:storage.objects.create']);
  });

  it('refuses credentials missing a read it needs', async () => {
    await expect(assertReadOnly(fakeIam({ project: ['datastore.entities.get'] }))).rejects.toThrow(/can't read/);
  });

  it('treats Auth as optional', async () => {
    expect(await checkReadOnly(fakeIam({ project: [...REQUIRED_READS] }))).toMatchObject({
      authReadable: false,
      missingReads: [],
    });
  });

  it('lets the auth import read Auth alone, but never with a write', async () => {
    expect(await assertAuthReadable(fakeIam({ project: ['firebaseauth.users.get'] }))).toMatchObject({
      authReadable: true,
    });
    await expect(assertAuthReadable(fakeIam({ project: [...REQUIRED_READS] }))).rejects.toThrow(
      /can't read \(firebaseauth\.users\.get\)/,
    );
    await expect(
      assertAuthReadable(fakeIam({ project: ['firebaseauth.users.get', 'firebaseauth.users.update'] })),
    ).rejects.toThrow(/can write \(firebaseauth\.users\.update\)/);
  });

  it('fails closed when IAM itself fails', async () => {
    const iam: IamTester = {
      project: async () => {
        throw new Error('403');
      },
      bucket: async () => [],
    };
    await expect(assertReadOnly(iam)).rejects.toThrow('403');
  });
});
