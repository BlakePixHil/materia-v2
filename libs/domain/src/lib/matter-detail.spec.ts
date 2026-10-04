import { describe, expect, it } from 'vitest';

import {
  ChangeMatterStageInput,
  clientContactIdsFrom,
  DEFAULT_MATTER_STAGES,
  keyFactEditable,
  keyFactPatch,
  keyFactsFor,
  keyFactValue,
  matterStages,
  partyDocId,
  RemovePartyInput,
  stageIndex,
  unmetStageRequirements,
  UpsertPartyInput,
} from './matter-detail';
import { Matter } from './schemas/contacts-matters';
import { MatterTypeSchema } from './schemas/enums';

const deceased = { contactId: 'c-dec', dateOfDeath: '2026-03-02', domicile: 'VIC', lastAddress: '1 Quill St' };

describe('key facts', () => {
  it('lists the facts each matter type shows', () => {
    expect(keyFactsFor('probate').map((f) => f.id)).toEqual([
      'dateOfDeath',
      'willDate',
      'grantDate',
      'grantNo',
      'grossValue',
    ]);
    expect(keyFactsFor('fp').map((f) => f.id)).toEqual(['dateOfDeath', 'willDate', 'grossValue', 'courtFileNo']);
    expect(keyFactsFor('will').map((f) => f.id)).toEqual(['willDate']);
    // A power of attorney has no key facts.
    expect(keyFactsFor('poa')).toEqual([]);
  });

  it('reads values from where the matter keeps them', () => {
    const matter = {
      deceased,
      estate: { grantDate: '2026-05-01', grantNo: 'S PRB 2026 0412', grossValueCents: 125_000_00 },
      facts: { willDate: '2019-08-14', courtFileNo: 'S ECI 2026 01234' },
    };
    expect(keyFactValue(matter, 'dateOfDeath')).toBe('2026-03-02');
    expect(keyFactValue(matter, 'grantNo')).toBe('S PRB 2026 0412');
    expect(keyFactValue(matter, 'grossValue')).toBe(125_000_00);
    expect(keyFactValue(matter, 'courtFileNo')).toBe('S ECI 2026 01234');
    expect(keyFactValue({}, 'willDate')).toBeUndefined();
  });

  it('patches whole nested objects, keeping their other fields, and clears a fact', () => {
    const matter = { estate: { grantNo: 'S PRB 1', grossValueCents: 10 } };
    expect(keyFactPatch(matter, 'grantDate', '2026-05-01')).toEqual({
      estate: { grantNo: 'S PRB 1', grossValueCents: 10, grantDate: '2026-05-01' },
    });
    expect(keyFactPatch(matter, 'grossValue', undefined)).toEqual({ estate: { grantNo: 'S PRB 1' } });
    expect(keyFactPatch({}, 'willDate', '2019-08-14')).toEqual({ facts: { willDate: '2019-08-14' } });
    expect(keyFactPatch({ deceased }, 'dateOfDeath', '2026-03-03')).toEqual({
      deceased: { ...deceased, dateOfDeath: '2026-03-03' },
    });
  });

  it('needs the deceased before the date of death can be set, and never clears it', () => {
    expect(keyFactEditable({}, 'dateOfDeath')).toBe(false);
    expect(keyFactEditable({ deceased }, 'dateOfDeath')).toBe(true);
    expect(keyFactEditable({}, 'grantNo')).toBe(true);
    expect(() => keyFactPatch({}, 'dateOfDeath', '2026-03-03')).toThrow();
    expect(() => keyFactPatch({ deceased }, 'dateOfDeath', undefined)).toThrow();
  });

  it('accepts the patches as matter updates', () => {
    const update = Matter.update.parse({
      ...keyFactPatch({}, 'courtFileNo', 'S ECI 2026 01234'),
      ...keyFactPatch({}, 'grossValue', 500_00),
      privileged: true,
    });
    expect(update).toMatchObject({ facts: { courtFileNo: 'S ECI 2026 01234' }, privileged: true });
  });
});

describe('stages', () => {
  it('has unique stage ids per type, and requirements that are key facts of that type', () => {
    for (const type of MatterTypeSchema.options) {
      const stages = DEFAULT_MATTER_STAGES[type];
      expect(new Set(stages.map((s) => s.id)).size).toBe(stages.length);
      const facts = keyFactsFor(type).map((f) => f.id);
      for (const stage of stages) for (const id of stage.requires ?? []) expect(facts).toContain(id);
    }
  });

  it("uses a template's stages, with the default criteria for known ids", () => {
    const stages = matterStages('probate', [
      { id: 'intake', title: 'Getting started' },
      { id: 'grant_issued', title: 'Grant' },
      { id: 'custom', title: 'Something else' },
    ]);
    expect(stages.map((s) => s.title)).toEqual(['Getting started', 'Grant', 'Something else']);
    expect(stages[1]?.requires).toEqual(['grantDate']);
    expect(stages[2]?.criteria).toBe('');
    expect(matterStages('probate')).toHaveLength(DEFAULT_MATTER_STAGES.probate.length);
  });

  it('treats no stage, or an unknown one, as the first', () => {
    const stages = matterStages('probate');
    expect(stageIndex(stages, undefined)).toBe(0);
    expect(stageIndex(stages, 'nope')).toBe(0);
    expect(stageIndex(stages, 'collection')).toBe(3);
  });

  it('checks every stage passed on a forward move, and nothing going back', () => {
    const stages = matterStages('probate');
    expect(unmetStageRequirements({}, stages, 'intake', 'collection')).toEqual(['dateOfDeath', 'grantDate']);
    expect(unmetStageRequirements({ deceased }, stages, 'intake', 'grant_application')).toEqual([]);
    expect(unmetStageRequirements({ deceased }, stages, undefined, 'grant_issued')).toEqual(['grantDate']);
    expect(unmetStageRequirements({}, stages, 'distribution', 'intake')).toEqual([]);
    expect(unmetStageRequirements({}, stages, 'intake', 'intake')).toEqual([]);
  });
});

describe('parties', () => {
  it('ids a row by role and contact, and derives the clients from live rows', () => {
    expect(partyDocId('beneficiary', 'c1')).toBe('beneficiary-c1');
    expect(
      clientContactIdsFrom([
        { contactId: 'a', role: 'client' },
        { contactId: 'b', role: 'executor' },
        { contactId: 'a', role: 'client' },
        { contactId: 'c', role: 'client' },
      ]),
    ).toEqual(['a', 'c']);
  });

  it('validates the callable inputs', () => {
    const requestId = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    expect(
      UpsertPartyInput.safeParse({ requestId, matterId: 'm', contactId: 'c', role: 'beneficiary', share: '1/2' })
        .success,
    ).toBe(true);
    expect(UpsertPartyInput.safeParse({ requestId, matterId: 'm', contactId: 'c', role: 'nobody' }).success).toBe(
      false,
    );
    expect(RemovePartyInput.safeParse({ requestId, matterId: 'm', partyId: 'client-c' }).success).toBe(true);
    expect(ChangeMatterStageInput.safeParse({ requestId, matterId: 'm', stageId: '' }).success).toBe(false);
  });
});
