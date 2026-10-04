import type { MatterType } from './schemas/enums';
import { isSystemTemplateId, SystemTemplateSchema, type SystemTemplate, type Template } from './templates';
import admin from '../../templates/system/admin.json';
import contest from '../../templates/system/contest.json';
import fp from '../../templates/system/fp.json';
import loa from '../../templates/system/loa.json';
import poa from '../../templates/system/poa.json';
import probate from '../../templates/system/probate.json';
import trust from '../../templates/system/trust.json';
import will from '../../templates/system/will.json';

/**
 * The system matter templates (CORE-07), one per matter type, bundled with the code from
 * `libs/domain/templates/system/{matterType}.json` rather than seeded into Firestore. Matters on a
 * system template have `templateId: 'system-{type}'`. A unit test validates every file.
 */
export const SYSTEM_TEMPLATE_SOURCES: Readonly<Record<MatterType, unknown>> = {
  will,
  poa,
  probate,
  loa,
  admin,
  fp,
  contest,
  trust,
};

let parsed: Map<string, SystemTemplate> | undefined;

/** Every system template, parsed and validated (throws if a bundled file is invalid). */
export function systemTemplates(): SystemTemplate[] {
  parsed ??= new Map(
    Object.values(SYSTEM_TEMPLATE_SOURCES).map((source) => {
      const template = SystemTemplateSchema.parse(source);
      return [template.id, template] as const;
    }),
  );
  return [...parsed.values()];
}

/** A system template by id (`system-probate`) as matters use it; undefined for any other id. */
export function systemTemplate(id: string): Template | undefined {
  if (!isSystemTemplateId(id)) return undefined;
  const found = systemTemplates().find((template) => template.id === id);
  if (!found) return undefined;
  return {
    id: found.id,
    version: found.version,
    source: 'system',
    matterType: found.matterType,
    name: found.name,
    stages: found.stages,
    tasks: found.tasks,
    deadlineRuleIds: found.deadlineRuleIds,
  };
}
