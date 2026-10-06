import { readFile } from 'node:fs/promises';

import * as z from 'zod';

import type { MatterType } from '@materia/domain';

import { domain } from './domain.ts';

const { DateOnlySchema, JurisdictionSchema, MatterTypeSchema, systemTemplate } = domain;

/**
 * The mapping profile (MIG-01): the user's decisions the transform (MIG-03) consumes, one file
 * per migrated user in `tools/migration/profiles/`. It maps each legacy workflow to matters,
 * personal tasks or nothing, each swimlane to a v2 status and stage, and records the policies
 * the decision log (`docs/migration/decisions.md`) explains. Workflows and swimlanes match by
 * legacy id when the profile pins one, else by name (trimmed, case and spacing ignored).
 */

const Name = z.string().trim().min(1);

/** A swimlane's v2 place. `archived` never comes from a swimlane: archived cards archive. */
export const SwimlaneMappingSchema = z.object({
  id: z.string().min(1).optional(),
  title: Name,
  status: z.enum(['lead', 'open', 'on_hold', 'closed']),
  /** A stage of the matter type's system template; unset when the swimlane says nothing about progress. */
  stageId: z.string().min(1).optional(),
  /** Overrides the workflow's type, for boards whose columns are kinds of matter (Disputes). */
  matterType: MatterTypeSchema.optional(),
  note: z.string().optional(),
});
export type SwimlaneMapping = z.infer<typeof SwimlaneMappingSchema>;

const WorkflowBase = { id: z.string().min(1).optional(), name: Name, note: z.string().optional() };

export const WorkflowMappingSchema = z.discriminatedUnion('mode', [
  /** Cards become matters. */
  z.object({
    ...WorkflowBase,
    mode: z.literal('matters'),
    matterType: MatterTypeSchema,
    swimlanes: z.array(SwimlaneMappingSchema).min(1),
  }),
  /** Cards become the user's personal tasks, grouped by their column (Blake, 2026-10-04). */
  z.object({ ...WorkflowBase, mode: z.literal('personal_tasks') }),
  /** Not migrated. */
  z.object({ ...WorkflowBase, mode: z.literal('exclude'), reason: Name }),
]);
export type WorkflowMapping = z.infer<typeof WorkflowMappingSchema>;

const SignOffSchema = z.object({ name: Name, on: DateOnlySchema, note: z.string().optional() });

const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const MappingProfileSchema = z
  .object({
    version: z.literal(1),
    subject: z.object({
      /** Who this profile migrates (a label for people, not used to match data). */
      label: Name,
      legacyUid: z.string().min(1),
    }),
    org: z.object({
      /** The v2 org's name; unset means the legacy `companyName`, else "{name}'s practice". */
      name: Name.optional(),
      timezone: z
        .string()
        .refine(isTimeZone, 'Use an IANA time zone such as Australia/Melbourne')
        .default('Australia/Melbourne'),
      jurisdiction: JurisdictionSchema.default('VIC'),
    }),
    workflows: z.array(WorkflowMappingSchema).min(1),
    labels: z.object({
      /** What happens to a label `map` doesn't name. */
      default: z.enum(['keep', 'drop']).default('keep'),
      /** Legacy label name → v2 label; null drops it. */
      map: z.record(z.string(), z.string().trim().min(1).nullable()).default({}),
    }),
    fees: z.object({
      /** How legacy amounts (`fee.value`, `billedFees`, `billingTotal`, budgets) read. */
      unit: z.enum(['dollars', 'cents']),
      /** Legacy `fee.billingType` → v2 arrangement. `''` leaves the fee unset for review. */
      billingTypes: z.object({
        fixed: z.literal('fixed'),
        hourly: z.literal('hourly'),
        folio: z.enum(['hourly', 'fixed', 'capped']),
        nowin: z.literal('conditional'),
      }),
    }),
    /** A card assigned to someone else: who becomes responsible on the matter. */
    foreignAssignees: z.enum(['reassign_with_note', 'reassign_silently']),
    /** `allocate`: new v2 numbers, the legacy reference kept as `externalRef`. */
    matterNumbers: z.enum(['allocate', 'adopt_reference_when_unique']),
    matterDefaults: z.object({
      /** v2 matters need a client; legacy cards have none, only a title. */
      clientContact: z.enum(['from_title', 'placeholder']),
      /** Imported open and closed matters were opened before Materia; leads still need a check. */
      conflictCheck: z.enum(['clear_unless_lead', 'pending']),
      costsDisclosure: z.enum(['required_unless_closed', 'not_required']),
    }),
    signOff: z.object({ user: SignOffSchema.optional(), productOwner: SignOffSchema.optional() }).default({}),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    profile.workflows.forEach((workflow, w) => {
      const key = workflow.id ?? normaliseName(workflow.name);
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['workflows', w],
          message: `Workflow "${workflow.name}" is mapped twice`,
        });
      seen.add(key);
      if (workflow.mode !== 'matters') return;
      const lanes = new Set<string>();
      workflow.swimlanes.forEach((lane, s) => {
        const path = ['workflows', w, 'swimlanes', s];
        const laneKey = lane.id ?? normaliseName(lane.title);
        if (lanes.has(laneKey))
          ctx.addIssue({ code: 'custom', path, message: `Swimlane "${lane.title}" is mapped twice` });
        lanes.add(laneKey);
        if (lane.stageId && !stageIds(lane.matterType ?? workflow.matterType).includes(lane.stageId)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'stageId'],
            message: `"${lane.stageId}" is not a stage of the ${lane.matterType ?? workflow.matterType} template`,
          });
        }
      });
    });
  });
export type MappingProfile = z.infer<typeof MappingProfileSchema>;

/** The stage ids of a matter type's system template (CORE-07). */
export function stageIds(type: MatterType): string[] {
  return (systemTemplate(`system-${type}`)?.stages ?? []).map((stage) => stage.id);
}

/** How names match: trimmed, case-insensitive, runs of spaces as one. */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function loadProfile(path: string): Promise<MappingProfile> {
  return MappingProfileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

// ---------- matching and coverage ----------

/** A legacy workflow as the audit report lists it. */
export interface WorkflowOutline {
  id: string;
  name: string;
  swimlanes: { id: string; title: string }[];
}

export function findWorkflowMapping(profile: MappingProfile, workflow: { id: string; name: string }) {
  return (
    profile.workflows.find((m) => m.id === workflow.id) ??
    profile.workflows.find((m) => !m.id && normaliseName(m.name) === normaliseName(workflow.name))
  );
}

export function findSwimlaneMapping(
  mapping: Extract<WorkflowMapping, { mode: 'matters' }>,
  swimlane: { id: string; title: string },
): SwimlaneMapping | undefined {
  return (
    mapping.swimlanes.find((m) => m.id === swimlane.id) ??
    mapping.swimlanes.find((m) => !m.id && normaliseName(m.title) === normaliseName(swimlane.title))
  );
}

export interface ProfileCoverage {
  ok: boolean;
  /** Workflows in the data that no profile entry matches. */
  unmappedWorkflows: string[];
  /** Profile entries no workflow in the data matches. */
  unknownWorkflows: string[];
  /** Swimlanes of matter workflows that no mapping matches. */
  unmappedSwimlanes: { workflow: string; swimlane: string }[];
  /** Swimlane mappings no swimlane in the data matches. */
  unknownSwimlanes: { workflow: string; swimlane: string }[];
}

/**
 * Whether the profile maps the data completely: every workflow has an entry and every swimlane of
 * a matters workflow has a mapping. Entries that match nothing are listed too, since a renamed
 * board or column would otherwise slip through.
 */
export function checkProfileCoverage(profile: MappingProfile, workflows: readonly WorkflowOutline[]): ProfileCoverage {
  const coverage: ProfileCoverage = {
    ok: true,
    unmappedWorkflows: [],
    unknownWorkflows: [],
    unmappedSwimlanes: [],
    unknownSwimlanes: [],
  };
  const matched = new Set<WorkflowMapping>();
  for (const workflow of workflows) {
    const mapping = findWorkflowMapping(profile, workflow);
    if (!mapping) {
      coverage.unmappedWorkflows.push(workflow.name);
      continue;
    }
    matched.add(mapping);
    if (mapping.mode !== 'matters') continue;
    const used = new Set<SwimlaneMapping>();
    for (const swimlane of workflow.swimlanes) {
      const lane = findSwimlaneMapping(mapping, swimlane);
      if (lane) used.add(lane);
      else coverage.unmappedSwimlanes.push({ workflow: workflow.name, swimlane: swimlane.title });
    }
    for (const lane of mapping.swimlanes) {
      if (!used.has(lane)) coverage.unknownSwimlanes.push({ workflow: workflow.name, swimlane: lane.title });
    }
  }
  coverage.unknownWorkflows = profile.workflows.filter((m) => !matched.has(m)).map((m) => m.name);
  coverage.ok =
    !coverage.unmappedWorkflows.length &&
    !coverage.unknownWorkflows.length &&
    !coverage.unmappedSwimlanes.length &&
    !coverage.unknownSwimlanes.length;
  return coverage;
}
