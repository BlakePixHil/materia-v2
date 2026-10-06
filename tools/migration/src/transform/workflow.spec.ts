import type { ExportRecord } from '../export/jsonl.ts';
import { loadLegacyFixtures } from '../legacy/fixtures.ts';
import type { MappingProfile } from '../profile.ts';
import { loadSpecProfile, specContext, warned } from './spec-helpers.ts';
import { mapWorkflow, placeCard, v2Label, type WorkflowPlan } from './workflow.ts';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadSpecProfile();
});

const WILLS_ID = '0b6f1c2e-5d4a-4c3b-9a8e-111111111111';
const LANE = (n: number) => `5a1e0000-0000-4000-8000-00000000000${n}`;
const LABEL = (n: number) => `1abe1000-0000-4000-8000-00000000000${n}`;

/** The fixture boards, as the export wrote them. */
const fixtureWorkflow = (id: string): ExportRecord => {
  const doc = loadLegacyFixtures().docs.find((d) => d.path === `workflows/${id}`);
  if (!doc) throw new Error(`No fixture workflow ${id}`);
  return doc;
};

const plan = (workflow: ExportRecord, over: Partial<MappingProfile> = {}): WorkflowPlan => {
  const result = mapWorkflow(specContext(profile, { profile: { ...profile, ...over } }), workflow);
  if (!result) throw new Error('Expected a plan');
  return result;
};

describe('mapWorkflow', () => {
  it('plans a matters board: its mapping, board label, lanes and labels', () => {
    const ctx = specContext(profile);
    const result = mapWorkflow(ctx, fixtureWorkflow(WILLS_ID));
    expect(result).toBeDefined();
    expect(result?.id).toBe(WILLS_ID);
    expect(result?.path).toBe(`workflows/${WILLS_ID}`);
    expect(result?.name).toBe('Wills & powers');
    expect(result?.boardLabel).toBe('board:Wills & powers');
    expect(result?.mapping).toMatchObject({ mode: 'matters', matterType: 'will' });
    expect([...(result?.lanes.keys() ?? [])]).toEqual([LANE(1), LANE(2), LANE(3), LANE(4)]);
    expect(result?.lanes.get(LANE(1))).toEqual({
      title: 'Enquiries',
      done: false,
      mapping: { title: 'Enquiries', status: 'lead' },
    });
    expect(result?.labels).toEqual(
      new Map([
        [LABEL(1), null],
        [LABEL(2), 'referral'],
      ]),
    );
    expect(warned(ctx)).toEqual({});
  });

  it('matches lanes by their pinned id, and by title ignoring case and spacing', () => {
    const result = plan(fixtureWorkflow(WILLS_ID));
    // "Drafting" matches the profile's "drafting"; lane 3 is pinned by id though its title changed.
    expect(result.lanes.get(LANE(2))?.mapping).toEqual({ title: 'drafting', status: 'open', stageId: 'draft' });
    expect(result.lanes.get(LANE(3))).toEqual({
      title: 'Signed, waiting to bill',
      done: false,
      mapping: { id: LANE(3), title: 'Signed (renamed)', status: 'open', stageId: 'safe_custody' },
    });
  });

  it("reads `done` from the board's isDoneSwimlane", () => {
    const result = plan(fixtureWorkflow(WILLS_ID));
    expect(result.lanes.get(LANE(4))).toMatchObject({ title: 'Closed', done: true, mapping: { status: 'closed' } });
    expect([...result.lanes.values()].filter((lane) => lane.done)).toHaveLength(1);
  });

  it('matches a board by its pinned id even when renamed', () => {
    const result = plan({ path: `workflows/${WILLS_ID}`, data: { name: '  Wills  (renamed) ', swimlanes: [] } });
    expect(result).toMatchObject({ name: 'Wills (renamed)', boardLabel: 'board:Wills (renamed)' });
    expect(result.mapping).toMatchObject({ mode: 'matters', matterType: 'will' });
  });

  it('matches a board by name, ignoring case and spacing', () => {
    const result = plan({
      path: 'workflows/wf-estates',
      data: { name: 'ESTATES', swimlanes: [{ id: 'l1', title: ' administration ', isDoneSwimlane: false }] },
    });
    expect(result.mapping).toMatchObject({ mode: 'matters', matterType: 'probate' });
    expect(result.lanes.get('l1')?.mapping).toMatchObject({ title: 'Administration', matterType: 'admin' });
  });

  it('is undefined for an excluded board', () => {
    expect(
      mapWorkflow(specContext(profile), { path: 'workflows/wf-shared', data: { name: 'Shared board' } }),
    ).toBeUndefined();
  });

  it('is undefined for a board the profile does not name', () => {
    expect(
      mapWorkflow(specContext(profile), { path: 'workflows/wf-x', data: { name: 'Conveyancing' } }),
    ).toBeUndefined();
    expect(mapWorkflow(specContext(profile), { path: 'workflows/wf-x', data: null })).toBeUndefined();
  });

  it('names a board without a name by its id, and matches that id', () => {
    const result = plan({ path: `workflows/${WILLS_ID}`, data: null });
    expect(result).toMatchObject({ name: WILLS_ID, boardLabel: `board:${WILLS_ID}` });
    expect(result.lanes.size).toBe(0);
    expect(result.labels.size).toBe(0);
  });

  it('reads a board missing labels and swimlanes as having none', () => {
    const result = plan({ path: 'workflows/wf-estates', data: { name: 'Estates' } });
    expect(result.lanes).toEqual(new Map());
    expect(result.labels).toEqual(new Map());
    const odd = plan({ path: 'workflows/wf-estates', data: { name: 'Estates', swimlanes: 'none', labels: { a: 1 } } });
    expect(odd.lanes.size + odd.labels.size).toBe(0);
  });

  it('keeps a lane the profile does not map without a mapping, and skips lanes without an id', () => {
    const result = plan({
      path: 'workflows/wf-estates',
      data: {
        name: 'Estates',
        swimlanes: [
          { id: 'l1', title: 'Waiting on SOAs', isDoneSwimlane: 'true' },
          { title: 'No id' },
          { id: '', title: 'Empty id' },
          'not a lane',
          { id: 'l2' },
        ],
      },
    });
    expect(result.lanes).toEqual(
      new Map([
        ['l1', { title: 'Waiting on SOAs', done: false }],
        ['l2', { title: '', done: false }],
      ]),
    );
  });

  it("maps labels through the profile's labels.map, keeping others by default", () => {
    const result = plan({
      path: 'workflows/wf-estates',
      data: {
        name: 'Estates',
        labels: [
          { id: 'a', name: 'Referral' },
          { id: 'b', name: 'Urgent' },
          { id: 'c', name: '  Follow  up ' },
          { id: 'd', name: '' },
          { id: 'e' },
          { name: 'No id' },
          null,
        ],
      },
    });
    expect(result.labels).toEqual(
      new Map<string, string | null>([
        ['a', 'referral'],
        ['b', null],
        ['c', 'Follow up'],
        ['d', null],
        ['e', null],
      ]),
    );
  });

  it('drops labels the map does not name when the default is drop', () => {
    const result = plan(
      {
        path: 'workflows/wf-estates',
        data: {
          name: 'Estates',
          labels: [
            { id: 'a', name: 'Referral' },
            { id: 'c', name: 'Follow up' },
          ],
        },
      },
      { labels: { default: 'drop', map: { Referral: 'referral' } } },
    );
    expect(result.labels).toEqual(
      new Map([
        ['a', 'referral'],
        ['c', null],
      ]),
    );
  });

  it('plans a personal tasks board with its lanes but no lane mappings', () => {
    const result = plan(fixtureWorkflow('0b6f1c2e-5d4a-4c3b-9a8e-333333333333'));
    expect(result.mapping).toEqual({ mode: 'personal_tasks', name: 'Business development' });
    expect(result.lanes).toEqual(
      new Map([
        [LANE(8), { title: 'Events', done: false }],
        [LANE(9), { title: 'Articles', done: false }],
      ]),
    );
    expect(result.labels.size).toBe(0);
  });
});

describe('v2Label', () => {
  it('renames, drops or keeps a label by the profile', () => {
    const ctx = specContext(profile);
    expect(v2Label(ctx, 'Referral')).toBe('referral');
    expect(v2Label(ctx, 'Urgent')).toBeNull();
    expect(v2Label(ctx, 'Follow up')).toBe('Follow up');
  });

  it('drops an unnamed label when the default is drop', () => {
    const ctx = specContext(profile, { profile: { ...profile, labels: { default: 'drop', map: { Keep: 'keep' } } } });
    expect(v2Label(ctx, 'Follow up')).toBeNull();
    expect(v2Label(ctx, 'Keep')).toBe('keep');
  });

  it('never reads names off the object prototype', () => {
    const ctx = specContext(profile);
    expect(v2Label(ctx, 'toString')).toBe('toString');
    expect(v2Label(ctx, 'constructor')).toBe('constructor');
    expect(v2Label(ctx, '__proto__')).toBe('__proto__');
  });
});

describe('placeCard', () => {
  it("places a card by its lane's mapping", () => {
    const wills = plan(fixtureWorkflow(WILLS_ID));
    expect(placeCard(wills, LANE(1))).toEqual({
      status: 'lead',
      type: 'will',
      unknownLane: false,
      laneTitle: 'Enquiries',
    });
    expect(placeCard(wills, LANE(2))).toEqual({
      status: 'open',
      stageId: 'draft',
      type: 'will',
      unknownLane: false,
      laneTitle: 'Drafting',
    });
    expect(placeCard(wills, LANE(4))).toEqual({
      status: 'closed',
      stageId: 'closed',
      type: 'will',
      unknownLane: false,
      laneTitle: 'Closed',
    });
  });

  it("takes a lane's matter type over the board's", () => {
    const estates = plan(fixtureWorkflow('0b6f1c2e-5d4a-4c3b-9a8e-222222222222'));
    expect(placeCard(estates, LANE(6))).toEqual({
      status: 'open',
      stageId: 'assets_collected',
      type: 'admin',
      unknownLane: false,
      laneTitle: 'Administration',
    });
    expect(placeCard(estates, LANE(5))).toMatchObject({ type: 'probate', stageId: 'application_filed' });
  });

  it('places a card in a lane the board no longer has as open, flagged', () => {
    const wills = plan(fixtureWorkflow(WILLS_ID));
    expect(placeCard(wills, 'gone')).toEqual({ status: 'open', type: 'will', unknownLane: true, laneTitle: '' });
    expect(placeCard(wills, undefined)).toEqual({ status: 'open', type: 'will', unknownLane: true, laneTitle: '' });
    expect(placeCard(wills, 7)).toEqual({ status: 'open', type: 'will', unknownLane: true, laneTitle: '' });
  });

  it('places a card in a lane the profile does not map as open, flagged, with the lane title', () => {
    const estates = plan({
      path: 'workflows/wf-estates',
      data: { name: 'Estates', swimlanes: [{ id: 'l1', title: 'Waiting on SOAs' }] },
    });
    expect(placeCard(estates, 'l1')).toEqual({
      status: 'open',
      type: 'probate',
      unknownLane: true,
      laneTitle: 'Waiting on SOAs',
    });
  });

  it("places a personal tasks board's card by its column title only", () => {
    const personal = plan(fixtureWorkflow('0b6f1c2e-5d4a-4c3b-9a8e-333333333333'));
    expect(placeCard(personal, LANE(8))).toEqual({
      status: 'open',
      type: 'will',
      unknownLane: true,
      laneTitle: 'Events',
    });
    expect(placeCard(personal, 'gone')).toMatchObject({ laneTitle: '', unknownLane: true });
  });
});
