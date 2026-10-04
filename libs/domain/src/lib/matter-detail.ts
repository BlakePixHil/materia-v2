import { z } from 'zod';

import { DocIdSchema } from './schemas/common';
import { PartyRoleSchema, type EventKind, type MatterType, type PartyRole } from './schemas/enums';

/**
 * The matter screen (CORE-06): key facts, the stage stepper and party management. Key facts are
 * edited by the client (whitelisted matter fields); stages and parties go through callables.
 */

// ---------- key facts ----------

export const KeyFactIdSchema = z.enum(['dateOfDeath', 'willDate', 'grantDate', 'grantNo', 'grossValue', 'courtFileNo']);
export type KeyFactId = z.infer<typeof KeyFactIdSchema>;
export type KeyFactKind = 'date' | 'money' | 'text';

export interface KeyFactDefinition {
  id: KeyFactId;
  label: string;
  kind: KeyFactKind;
  /** The matter types that show this fact, in display order per type. */
  types: readonly MatterType[];
}

const ESTATE: readonly MatterType[] = ['probate', 'loa', 'admin'];
const DISPUTE: readonly MatterType[] = ['fp', 'contest'];

export const KEY_FACTS: readonly KeyFactDefinition[] = [
  { id: 'dateOfDeath', label: 'Date of death', kind: 'date', types: [...ESTATE, ...DISPUTE, 'trust'] },
  { id: 'willDate', label: 'Will date', kind: 'date', types: ['will', ...ESTATE, ...DISPUTE] },
  { id: 'grantDate', label: 'Grant date', kind: 'date', types: ESTATE },
  { id: 'grantNo', label: 'Grant number', kind: 'text', types: ESTATE },
  { id: 'grossValue', label: 'Estate gross value', kind: 'money', types: [...ESTATE, ...DISPUTE] },
  { id: 'courtFileNo', label: 'Court file number', kind: 'text', types: DISPUTE },
];

/** The key facts a matter of this type shows. */
export function keyFactsFor(type: MatterType): KeyFactDefinition[] {
  return KEY_FACTS.filter((fact) => fact.types.includes(type));
}

/**
 * The matter fields key facts live in, typed loosely (plain strings for dates and numbers for
 * cents) so plain objects and parsed matters both fit. Patches go through `Matter.update`.
 */
export interface FactMatter {
  deceased?: { contactId: string; dateOfDeath: string; domicile: string; lastAddress: string } | undefined;
  estate?:
    | {
        grantDate?: string | undefined;
        grantNo?: string | undefined;
        grossValueCents?: number | undefined;
        [key: string]: unknown;
      }
    | undefined;
  facts?: { willDate?: string | undefined; courtFileNo?: string | undefined } | undefined;
}

/** A key fact's value: an ISO date, cents, or text; undefined when not recorded. */
export function keyFactValue(matter: FactMatter, id: KeyFactId): string | number | undefined {
  switch (id) {
    case 'dateOfDeath':
      return matter.deceased?.dateOfDeath;
    case 'willDate':
      return matter.facts?.willDate;
    case 'grantDate':
      return matter.estate?.grantDate;
    case 'grantNo':
      return matter.estate?.grantNo;
    case 'grossValue':
      return matter.estate?.grossValueCents;
    case 'courtFileNo':
      return matter.facts?.courtFileNo;
  }
}

/**
 * Whether a fact can be edited: the date of death lives on `deceased`, which needs the deceased
 * contact first (added on the Parties tab or at intake).
 */
export function keyFactEditable(matter: FactMatter, id: KeyFactId): boolean {
  return id !== 'dateOfDeath' || !!matter.deceased;
}

/**
 * The matter update that sets (or, with `undefined`, clears) a fact. Nested objects are replaced
 * whole, so the patch carries their other fields. Throws for the date of death without a deceased.
 */
export function keyFactPatch(
  matter: FactMatter,
  id: KeyFactId,
  value: string | number | undefined,
): Pick<FactMatter, 'deceased' | 'estate' | 'facts'> {
  const set = <T extends object>(base: T | undefined, key: string): T => {
    const rest = Object.entries(base ?? {}).filter(([k]) => k !== key);
    const next = value === undefined || value === '' ? rest : [...rest, [key, value]];
    return Object.fromEntries(next) as T;
  };
  switch (id) {
    case 'dateOfDeath':
      if (!matter.deceased) throw new Error('The date of death needs the deceased on the matter first');
      if (value === undefined || value === '') throw new Error('The date of death cannot be cleared');
      return { deceased: { ...matter.deceased, dateOfDeath: String(value) } };
    case 'willDate':
      return { facts: set(matter.facts, 'willDate') };
    case 'courtFileNo':
      return { facts: set(matter.facts, 'courtFileNo') };
    case 'grantDate':
      return { estate: set(matter.estate, 'grantDate') };
    case 'grantNo':
      return { estate: set(matter.estate, 'grantNo') };
    case 'grossValue':
      return { estate: set(matter.estate, 'grossValueCents') };
  }
}

// ---------- stages ----------

export interface MatterStage {
  id: string;
  title: string;
  /** What finishes the stage, shown in the stepper's tooltip. */
  criteria: string;
  /** Key facts that must be recorded to move into this stage (forward moves only). */
  requires?: readonly KeyFactId[];
  /** Matter events that must be known to move into this stage (template stages, CORE-07). */
  events?: readonly EventKind[];
  /** Template task keys that must be done to move into this stage (template stages, CORE-07). */
  tasksDone?: readonly string[];
  /** The matter's work is finished once it is here (a template's last stage, CORE-07). */
  terminal?: boolean;
}

/**
 * A template's stage as `matterStages` reads it: a CORE-07 template stage (`name`, `criteria`,
 * `entryRequires`) or a CORE-06 one (`title`). Read leniently so older documents keep working.
 */
export interface TemplateStageLike {
  id: string;
  name?: string | undefined;
  title?: string | undefined;
  criteria?: string | undefined;
  entryRequires?:
    | {
        facts?: readonly KeyFactId[] | undefined;
        events?: readonly EventKind[] | undefined;
        tasksDone?: readonly string[] | undefined;
      }
    | undefined;
  terminal?: boolean | undefined;
}

const ESTATE_STAGES: readonly MatterStage[] = [
  { id: 'intake', title: 'Intake', criteria: 'Client, deceased and costs disclosure recorded' },
  {
    id: 'grant_application',
    title: 'Grant application',
    criteria: 'Will, death certificate and inventory filed with the court',
    requires: ['dateOfDeath'],
  },
  { id: 'grant_issued', title: 'Grant issued', criteria: 'Grant received from the court', requires: ['grantDate'] },
  { id: 'collection', title: 'Collection', criteria: 'Assets collected and liabilities paid' },
  { id: 'distribution', title: 'Distribution', criteria: 'Beneficiaries paid and receipts held' },
  { id: 'finalisation', title: 'Finalisation', criteria: 'Accounts approved and file ready to close' },
];

/** The default stages per matter type; a template's stages replace these (CORE-07). */
export const DEFAULT_MATTER_STAGES: Readonly<Record<MatterType, readonly MatterStage[]>> = {
  will: [
    { id: 'instructions', title: 'Instructions', criteria: 'Instructions taken and confirmed' },
    { id: 'drafting', title: 'Drafting', criteria: 'Draft sent to the client for review' },
    { id: 'signing', title: 'Signing', criteria: 'Will signed and witnessed', requires: ['willDate'] },
    { id: 'storage', title: 'Storage', criteria: 'Original stored in safe custody' },
  ],
  poa: [
    { id: 'instructions', title: 'Instructions', criteria: 'Instructions taken and confirmed' },
    { id: 'drafting', title: 'Drafting', criteria: 'Draft sent to the client for review' },
    { id: 'signing', title: 'Signing', criteria: 'Signed, witnessed and accepted by the attorney' },
    { id: 'storage', title: 'Storage', criteria: 'Original stored and copies sent' },
  ],
  probate: ESTATE_STAGES,
  loa: ESTATE_STAGES,
  admin: [
    { id: 'intake', title: 'Intake', criteria: 'Client, deceased and grant details recorded' },
    {
      id: 'collection',
      title: 'Collection',
      criteria: 'Assets collected and liabilities paid',
      requires: ['grantDate'],
    },
    { id: 'distribution', title: 'Distribution', criteria: 'Beneficiaries paid and receipts held' },
    { id: 'finalisation', title: 'Finalisation', criteria: 'Accounts approved and file ready to close' },
  ],
  fp: [
    { id: 'intake', title: 'Intake', criteria: 'Client, deceased and limitation date recorded' },
    { id: 'pleadings', title: 'Pleadings', criteria: 'Originating process filed', requires: ['courtFileNo'] },
    { id: 'mediation', title: 'Mediation', criteria: 'Mediation held' },
    { id: 'hearing', title: 'Hearing', criteria: 'Matter heard' },
    { id: 'resolution', title: 'Resolution', criteria: 'Orders made or settlement signed' },
  ],
  contest: [
    { id: 'intake', title: 'Intake', criteria: 'Client, deceased and grounds recorded' },
    { id: 'pleadings', title: 'Pleadings', criteria: 'Caveat or proceedings filed', requires: ['courtFileNo'] },
    { id: 'mediation', title: 'Mediation', criteria: 'Mediation held' },
    { id: 'hearing', title: 'Hearing', criteria: 'Matter heard' },
    { id: 'resolution', title: 'Resolution', criteria: 'Orders made or settlement signed' },
  ],
  trust: [
    { id: 'intake', title: 'Intake', criteria: 'Trust deed and trustees recorded' },
    { id: 'establishment', title: 'Establishment', criteria: 'Trust established and registered' },
    { id: 'administration', title: 'Administration', criteria: 'Ongoing administration' },
    { id: 'wind_up', title: 'Wind up', criteria: 'Trust property distributed' },
  ],
};

/**
 * A matter's stages: the template's, in order (`name` becomes the title), each requiring its own
 * `entryRequires` plus the key facts the default stage of the same id requires (CORE-06), with the
 * default's criteria when the template gives none; otherwise the type's defaults.
 */
export function matterStages(type: MatterType, templateStages?: readonly TemplateStageLike[]): MatterStage[] {
  const defaults = DEFAULT_MATTER_STAGES[type];
  if (!templateStages?.length) return [...defaults];
  return templateStages.map((stage) => {
    const known = defaults.find((d) => d.id === stage.id);
    const requires = [...new Set([...(stage.entryRequires?.facts ?? []), ...(known?.requires ?? [])])];
    const events = stage.entryRequires?.events ?? [];
    const tasksDone = stage.entryRequires?.tasksDone ?? [];
    return {
      id: stage.id,
      title: stage.name ?? stage.title ?? stage.id,
      criteria: stage.criteria ?? known?.criteria ?? '',
      ...(requires.length ? { requires } : {}),
      ...(events.length ? { events: [...events] } : {}),
      ...(tasksDone.length ? { tasksDone: [...tasksDone] } : {}),
      ...(stage.terminal ? { terminal: true } : {}),
    };
  });
}

/** The current stage's index; the first stage when none is set or the id is unknown. */
export function stageIndex(stages: readonly MatterStage[], stageId: string | undefined): number {
  const index = stages.findIndex((stage) => stage.id === stageId);
  return index < 0 ? 0 : index;
}

/**
 * The key facts missing to move from `fromId` to `toId`: the requirements of every stage passed
 * into on the way (a forward move). Moving back has none.
 */
export function unmetStageRequirements(
  matter: FactMatter,
  stages: readonly MatterStage[],
  fromId: string | undefined,
  toId: string,
): KeyFactId[] {
  const from = stageIndex(stages, fromId);
  const to = stages.findIndex((stage) => stage.id === toId);
  if (to <= from) return [];
  const required = stages.slice(from + 1, to + 1).flatMap((stage) => stage.requires ?? []);
  return [...new Set(required)].filter((id) => {
    const value = keyFactValue(matter, id);
    return value === undefined || value === '';
  });
}

// ---------- parties ----------

/** The id of a party row: one row per role and contact. */
export function partyDocId(role: PartyRole, contactId: string): string {
  return `${role}-${contactId}`;
}

/** Roles in the order the Parties tab groups them. */
export const PARTY_ROLE_ORDER: readonly PartyRole[] = PartyRoleSchema.options;

/** The matter's clients from its live party rows (CORE-06: `clientContactIds` follows the parties). */
export function clientContactIdsFrom(parties: readonly { contactId: string; role: PartyRole }[]): string[] {
  return [...new Set(parties.filter((party) => party.role === 'client').map((party) => party.contactId))];
}

// ---------- callable inputs ----------

const RequestId = z.uuid();

/**
 * `matters-changeStage` (matter.edit). Forward moves check the stages' requirements. With
 * `templates.system` on (CORE-07), moving back needs `matter.status` and a `reason`.
 */
export const ChangeMatterStageInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  stageId: z.string().trim().min(1).max(60),
  reason: z.string().trim().max(500).optional(),
});
export type ChangeMatterStageInput = z.infer<typeof ChangeMatterStageInput>;

export interface ChangeMatterStageResult {
  matterId: string;
  stageId: string;
  /** Template task ids created on entering the stage (CORE-07; absent with templates off). */
  createdTaskIds?: string[];
}

/**
 * `matters-upsertParty` (matter.edit): adds a contact in a role, or edits a row (`partyId`). A
 * changed role moves the row to its new id. `share` is for beneficiaries.
 */
export const UpsertPartyInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  partyId: DocIdSchema.optional(),
  contactId: DocIdSchema,
  role: PartyRoleSchema,
  share: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type UpsertPartyInput = z.infer<typeof UpsertPartyInput>;

/** `matters-removeParty` (matter.edit): soft-deletes the row. The last client can't be removed. */
export const RemovePartyInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  partyId: DocIdSchema,
});
export type RemovePartyInput = z.infer<typeof RemovePartyInput>;

export interface PartyResult {
  matterId: string;
  partyId: string;
  clientContactIds: string[];
}
