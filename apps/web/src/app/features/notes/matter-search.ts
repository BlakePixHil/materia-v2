import { inject } from '@angular/core';

import { matterMatchesFilters, matterQueryPlan, mattersRepository } from '@materia/data-access/repository';
import { MT_TODAY } from '@materia/ui';

import { MATTER_QUERY_MIN, MENTION_SUGGESTIONS, type MatterOption } from './note-view';

/** Matters read per `#` search, before every typed word is checked here. */
const SEARCH_PAGE = 20;

/**
 * Matters for `#` mentions (CORE-13): the Matters list's search (CORE-03), so it uses the same
 * indexes: live matters whose search tokens hold the first word typed (number or title), most
 * recently active first, `privileged == false` for roles without privileged.view; then every word
 * is checked here. Create it in an injection context.
 */
export function matterSearch(privilegedVisible: () => boolean): (query: string) => Promise<MatterOption[]> {
  const repo = mattersRepository();
  const today = inject(MT_TODAY);
  return async (query) => {
    if (query.trim().length < MATTER_QUERY_MIN) return [];
    const plan = matterQueryPlan(
      { query },
      { field: 'lastActivity', dir: 'desc' },
      { privilegedVisible: privilegedVisible() },
    );
    const rows = await repo.query({ ...plan.spec, pageSize: SEARCH_PAGE });
    const context = { today: today(), now: new Date() };
    return rows
      .filter((row) => matterMatchesFilters(row, { query }, context))
      .slice(0, MENTION_SUGGESTIONS)
      .map((row) => ({ id: row.id, number: row.number, title: row.title }));
  };
}
