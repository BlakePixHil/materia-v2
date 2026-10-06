import { memorySink } from '../export/sink.ts';
import { runExport, type ExportManifest } from '../export.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { memoryReader } from '../legacy/reader.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';

/**
 * The synthetic legacy fixtures exported the way MIG-02 does it, into a run in memory, for the
 * transform's tests. Fictional data only.
 */

export const FIXTURE_RUN_ID = 'fixture-run';
export const FIXTURE_READ_TIME = '2026-10-06T21:00:00.123456Z';
export const FIXTURE_PROFILE = `${FIXTURE_DIR}mapping-profile.json`;

export async function exportFixtureRun(
  options: { runId?: string; since?: string; profile?: MappingProfile; profileHash?: string } = {},
): Promise<{ files: Map<string, string>; manifest: ExportManifest; profile: MappingProfile }> {
  const runId = options.runId ?? FIXTURE_RUN_ID;
  const profile = options.profile ?? (await loadProfile(FIXTURE_PROFILE));
  const { docs, objects } = loadLegacyFixtures();
  const sink = memorySink(runId);
  const manifest = await runExport(
    {
      uid: FIXTURE_UIDS.subject,
      profile,
      profileHash: options.profileHash ?? 'fixture-profile',
      source: { project: 'demo-legacy', bucket: 'demo-legacy.firebasestorage.app' },
      runId,
      ...(options.since ? { since: options.since } : {}),
      resume: false,
      toolVersion: '0.0.0+fixture',
    },
    {
      iam: null,
      serverReadTime: async () => FIXTURE_READ_TIME,
      reader: () => ({
        ...memoryReader(docs, objects),
        authRecord: async () => ({ email: 'alex.rivers@example.com', providers: ['google.com'] }),
      }),
      sink,
      now: () => new Date('2026-10-06T21:05:00Z'),
      log: () => undefined,
    },
  );
  return { files: sink.files, manifest, profile };
}
