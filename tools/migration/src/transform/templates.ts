import { domain } from '../domain.ts';
import { fit, migratedMeta, migId, type TransformContext, type TransformedRecord } from './context.ts';
import { createdAndUpdated } from './dates.ts';
import { cleanText } from './values.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { arr, docId, obj, str } from '../legacy/snapshot.ts';

const { CHECKLIST_TEMPLATE_ITEM_MAX, CHECKLIST_TEMPLATE_ITEMS_MAX, CHECKLIST_TEMPLATE_NAME_MAX } = domain;

/**
 * `workflows/{wf}/checklist-templates/{id}` → the org's checklist templates
 * (`orgs/{O}/checklistTemplates`, CORE-08d), which apply a list of items to a task: the legacy
 * ones were exactly that, a named list applied to a card. The document id is the template's id;
 * the legacy `id` field is sometimes wrong (`MIG_W_TEMPLATE_ID_MISMATCH`). Item due dates and
 * priorities were blank in legacy templates and don't carry over; `templateExists` is app state.
 * v2 holds up to 30 items of up to 200 characters, and a template with none isn't migrated.
 */

export const UNTITLED_TEMPLATE = 'Untitled checklist (imported)';

export function mapChecklistTemplates(ctx: TransformContext, templates: readonly ExportRecord[]): TransformedRecord[] {
  return templates.flatMap(({ path, data }) => {
    if (!data) return [];
    const legacyId = str(data['id']);
    if (legacyId && legacyId !== docId(path)) ctx.warnings.add('MIG_W_TEMPLATE_ID_MISMATCH', path);
    const items = arr(data['items'])
      .map((item) => cleanText(obj(item)?.['name']))
      .filter(Boolean)
      .map((name) => fit(ctx, name, CHECKLIST_TEMPLATE_ITEM_MAX, path));
    if (!items.length) {
      ctx.warnings.add('MIG_W_TEMPLATE_EMPTY', path);
      return [];
    }
    if (items.length > CHECKLIST_TEMPLATE_ITEMS_MAX) ctx.warnings.add('MIG_W_TEMPLATE_TRUNCATED', path);
    let name = cleanText(data['title']);
    if (!name) {
      ctx.warnings.add('MIG_W_UNTITLED', path);
      name = UNTITLED_TEMPLATE;
    }
    const { createdAt, updatedAt } = createdAndUpdated(ctx, data, path);
    return [
      {
        entity: 'checklist-templates',
        path: `orgs/${ctx.orgId}/checklistTemplates/${migId(path)}`,
        legacyPath: path,
        data: {
          name: fit(ctx, name, CHECKLIST_TEMPLATE_NAME_MAX, path),
          items: items.slice(0, CHECKLIST_TEMPLATE_ITEMS_MAX),
          ...migratedMeta(ctx, { legacyPath: path, createdAt, updatedAt, by: ctx.uid }),
        },
      } satisfies TransformedRecord,
    ];
  });
}
