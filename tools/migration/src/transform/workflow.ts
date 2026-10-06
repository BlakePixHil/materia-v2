import type { MatterType } from '@materia/domain';

import type { ExportRecord } from '../export/jsonl.ts';
import { arr, docId, obj, str } from '../legacy/snapshot.ts';
import { findSwimlaneMapping, findWorkflowMapping, type SwimlaneMapping, type WorkflowMapping } from '../profile.ts';
import type { TransformContext } from './context.ts';
import { cleanText } from './values.ts';

/**
 * A legacy workflow (board) as the card mappers need it: the profile's decision for it, its label
 * `board:{name}`, each swimlane's v2 status and stage, and each label id's v2 label. Boards may
 * lack `labels`, `swimlanes`, `users` or `order` (Hazards), which read as empty.
 */

export interface LanePlan {
  title: string;
  /** Legacy's `isDoneSwimlane`: the board's done column. */
  done: boolean;
  /** The profile's mapping, absent when the profile doesn't map this column. */
  mapping?: SwimlaneMapping;
}

export interface WorkflowPlan {
  id: string;
  path: string;
  name: string;
  mapping: Exclude<WorkflowMapping, { mode: 'exclude' }>;
  /** The label every matter from the board carries. */
  boardLabel: string;
  lanes: Map<string, LanePlan>;
  /** Label id → v2 label name, or null when the profile drops it. */
  labels: Map<string, string | null>;
}

/** The plan for one exported workflow; undefined when the profile excludes it or doesn't name it. */
export function mapWorkflow(ctx: TransformContext, workflow: ExportRecord): WorkflowPlan | undefined {
  const data = workflow.data ?? {};
  const id = docId(workflow.path);
  const name = cleanText(data['name']) || id;
  const mapping = findWorkflowMapping(ctx.profile, { id, name });
  if (!mapping || mapping.mode === 'exclude') return undefined;

  const lanes = new Map<string, LanePlan>();
  for (const lane of arr(data['swimlanes'])) {
    const laneId = str(obj(lane)?.['id']);
    if (!laneId) continue;
    const title = cleanText(obj(lane)?.['title']);
    const laneMapping = mapping.mode === 'matters' ? findSwimlaneMapping(mapping, { id: laneId, title }) : undefined;
    const done = obj(lane)?.['isDoneSwimlane'] === true;
    lanes.set(laneId, { title, done, ...(laneMapping ? { mapping: laneMapping } : {}) });
  }

  const labels = new Map<string, string | null>();
  for (const label of arr(data['labels'])) {
    const labelId = str(obj(label)?.['id']);
    const labelName = cleanText(obj(label)?.['name']);
    if (!labelId) continue;
    labels.set(labelId, labelName ? v2Label(ctx, labelName) : null);
  }

  return { id, path: workflow.path, name, mapping, boardLabel: `board:${name}`, lanes, labels };
}

/** A legacy label's v2 name under the profile: renamed, kept or dropped (D-05). */
export function v2Label(ctx: TransformContext, name: string): string | null {
  const { map, default: fallback } = ctx.profile.labels;
  if (Object.hasOwn(map, name)) return map[name] ?? null;
  return fallback === 'keep' ? name : null;
}

/** Where a card lands: its status, stage and matter type, and whether its column is unknown. */
export interface Placement {
  status: 'lead' | 'open' | 'on_hold' | 'closed';
  stageId?: string;
  type: MatterType;
  unknownLane: boolean;
  /** The column's title, for personal tasks' group. */
  laneTitle: string;
}

export function placeCard(plan: WorkflowPlan, swimlaneId: unknown): Placement {
  const type = plan.mapping.mode === 'matters' ? plan.mapping.matterType : 'will';
  const lane = typeof swimlaneId === 'string' ? plan.lanes.get(swimlaneId) : undefined;
  if (!lane?.mapping) {
    // A column the board no longer has (or the profile doesn't map): open, flagged (D-04).
    return { status: 'open', type, unknownLane: true, laneTitle: lane?.title ?? '' };
  }
  return {
    status: lane.mapping.status,
    ...(lane.mapping.stageId ? { stageId: lane.mapping.stageId } : {}),
    type: lane.mapping.matterType ?? type,
    unknownLane: false,
    laneTitle: lane.title,
  };
}
