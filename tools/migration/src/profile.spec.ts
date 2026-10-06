import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FIXTURE_DIR } from './legacy/fixtures.ts';
import {
  checkProfileCoverage,
  loadProfile,
  MappingProfileSchema,
  normaliseName,
  stageIds,
  type MappingProfile,
} from './profile.ts';

const PROFILES_DIR = fileURLToPath(new URL('../profiles/', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('mapping profiles', () => {
  it("validates Tristan Burke's profile", async () => {
    const profile = await loadProfile(`${PROFILES_DIR}tristan-burke.json`);
    expect(profile.subject.legacyUid).toBe('fen5jJdhNHTkGBpgAdsLSKQRvXx2');
    expect(profile.org).toMatchObject({ timezone: 'Australia/Melbourne', jurisdiction: 'VIC' });
    expect(profile.workflows.map((w) => [w.name, w.mode])).toEqual([
      ['Estate planning', 'matters'],
      ['Estate admin', 'matters'],
      ['Disputes', 'matters'],
      ['FY BD & Non-Billable - Track for Promotion', 'personal_tasks'],
      ['Non-billable', 'personal_tasks'],
      ['Test Workflow', 'exclude'],
    ]);
  });

  it("maps every swimlane the first read-only profile found on Tristan's boards (2026-10-04)", async () => {
    const profile = await loadProfile(`${PROFILES_DIR}tristan-burke.json`);
    // Names from /mnt/project-files/mig-01/tristan-data-profile.md; the audit re-checks them by id.
    const boards = {
      'Estate planning': [
        'Upcoming initial appt / prospective clients',
        'New files / waiting for quote approved',
        'To draft',
        'Drafts sent to clients',
        'Waiting on SOAs',
        'Close file',
      ],
      'Estate admin': [
        'Waiting for client to approve quote / open file',
        'General estate advice (non-dispute)',
        'ASP only or probate not needed',
        'Stage 1 (pre-filing)',
        'Stage 2 (filed)',
        'Stage 3 & 4 (admin and property)',
        'File to be closed',
      ],
      Disputes: ['Part IV', 'VCAT', 'Superannuation', 'Other', 'Caveat', 'Close file'],
      'FY BD & Non-Billable - Track for Promotion': ['Precedents', 'Events', 'Referrals out', 'Relationships'],
      'Non-billable': ['Precedent review', 'Material review', 'Articles', 'BD'],
      'Test Workflow': ['Anything'],
    };
    const outline = Object.entries(boards).map(([name, lanes], i) => ({
      id: `wf-${i}`,
      name,
      swimlanes: lanes.map((title, j) => ({ id: `lane-${i}-${j}`, title })),
    }));
    expect(checkProfileCoverage(profile, outline)).toMatchObject({ ok: true });
  });

  it('validates the fixture profile', () => {
    expect(() => MappingProfileSchema.parse(read(`${FIXTURE_DIR}mapping-profile.json`))).not.toThrow();
  });

  it('rejects a stage the matter type does not have, checking per-swimlane type overrides', () => {
    const base = read(`${FIXTURE_DIR}mapping-profile.json`);
    const withLane = (lane: Record<string, unknown>) => ({
      ...base,
      workflows: [{ mode: 'matters', name: 'X', matterType: 'will', swimlanes: [lane] }],
    });
    expect(MappingProfileSchema.safeParse(withLane({ title: 'A', status: 'open', stageId: 'draft' })).success).toBe(
      true,
    );
    const wrong = MappingProfileSchema.safeParse(withLane({ title: 'A', status: 'open', stageId: 'grant_issued' }));
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.message).toBe('"grant_issued" is not a stage of the will template');
    expect(
      MappingProfileSchema.safeParse(
        withLane({ title: 'A', status: 'open', matterType: 'probate', stageId: 'grant_issued' }),
      ).success,
    ).toBe(true);
    expect(MappingProfileSchema.safeParse(withLane({ title: 'A', status: 'archived' })).success).toBe(false);
  });

  it('rejects duplicate workflows and swimlanes, and bad time zones', () => {
    const base = read(`${FIXTURE_DIR}mapping-profile.json`);
    const dupWorkflow = {
      ...base,
      workflows: [
        { mode: 'personal_tasks', name: 'A' },
        { mode: 'personal_tasks', name: ' a ' },
      ],
    };
    expect(MappingProfileSchema.safeParse(dupWorkflow).error?.issues[0]?.message).toBe('Workflow "a" is mapped twice');
    const dupLane = {
      ...base,
      workflows: [
        {
          mode: 'matters',
          name: 'A',
          matterType: 'will',
          swimlanes: [
            { title: 'X', status: 'open' },
            { title: 'x', status: 'lead' },
          ],
        },
      ],
    };
    expect(MappingProfileSchema.safeParse(dupLane).error?.issues[0]?.message).toBe('Swimlane "x" is mapped twice');
    expect(MappingProfileSchema.safeParse({ ...base, org: { timezone: 'Mars/Olympus' } }).success).toBe(false);
  });

  it('fills defaults', () => {
    const base = read(`${FIXTURE_DIR}mapping-profile.json`);
    const parsed = MappingProfileSchema.parse({ ...base, org: {}, labels: {}, signOff: undefined });
    expect(parsed.org).toEqual({ timezone: 'Australia/Melbourne', jurisdiction: 'VIC' });
    expect(parsed.labels).toEqual({ default: 'keep', map: {} });
    expect(parsed.signOff).toEqual({});
  });
});

describe('checkProfileCoverage', () => {
  const profile: MappingProfile = MappingProfileSchema.parse(read(`${FIXTURE_DIR}mapping-profile.json`));

  it('matches by pinned id first, then by name ignoring case and spacing', () => {
    const coverage = checkProfileCoverage(profile, [
      {
        id: '0b6f1c2e-5d4a-4c3b-9a8e-111111111111',
        name: 'Wills and powers (renamed)',
        swimlanes: [
          { id: 'a', title: ' enquiries ' },
          { id: 'b', title: 'Drafting' },
          { id: '5a1e0000-0000-4000-8000-000000000003', title: 'Signed, waiting to bill' },
          { id: 'd', title: 'Closed' },
        ],
      },
      {
        id: 'e',
        name: 'ESTATES',
        swimlanes: [
          { id: 'x', title: 'Probate application' },
          { id: 'y', title: 'Administration' },
          { id: 'z', title: 'Done' },
        ],
      },
      { id: 'f', name: 'Business development', swimlanes: [{ id: 'q', title: 'Anything' }] },
      { id: 'g', name: 'Shared board', swimlanes: [] },
    ]);
    expect(coverage.ok).toBe(true);
  });

  it('never matches a pinned id by name', () => {
    const coverage = checkProfileCoverage(profile, [{ id: 'another-board', name: 'Wills & powers', swimlanes: [] }]);
    expect(coverage.unmappedWorkflows).toEqual(['Wills & powers']);
  });

  it('lists unmapped and unknown workflows and swimlanes', () => {
    const coverage = checkProfileCoverage(profile, [
      {
        id: '0b6f1c2e-5d4a-4c3b-9a8e-111111111111',
        name: 'Wills & powers',
        swimlanes: [
          { id: 'a', title: 'Enquiries' },
          { id: 'n', title: 'New column' },
        ],
      },
      { id: 'z', name: 'A new board', swimlanes: [] },
    ]);
    expect(coverage).toEqual({
      ok: false,
      unmappedWorkflows: ['A new board'],
      unknownWorkflows: ['Estates', 'Business development', 'Shared board'],
      unmappedSwimlanes: [{ workflow: 'Wills & powers', swimlane: 'New column' }],
      unknownSwimlanes: [
        { workflow: 'Wills & powers', swimlane: 'drafting' },
        { workflow: 'Wills & powers', swimlane: 'Signed (renamed)' },
        { workflow: 'Wills & powers', swimlane: 'Closed' },
      ],
    });
  });
});

describe('profile helpers', () => {
  it('normalises names and lists template stages', () => {
    expect(normaliseName('  Stage 3  &  4 ')).toBe('stage 3 & 4');
    expect(stageIds('will')).toEqual(['instructions', 'draft', 'client_review', 'execution', 'safe_custody', 'closed']);
  });
});
