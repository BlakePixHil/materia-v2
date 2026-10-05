import { effect, signal, untracked, type Signal } from '@angular/core';

import { matterDetailRepository } from '@materia/data-access/repository';

import type { DeadlineMatterRef } from './deadline-view';

/**
 * The matters a cross-matter list's rows are on, each read once (number, title, jurisdiction and
 * people, for the filters). Rows on a matter the member can't read show as restricted. Create it in
 * an injection context; `ids` is watched.
 */
export function matterLookup(ids: () => readonly string[]): Signal<ReadonlyMap<string, DeadlineMatterRef>> {
  const repo = matterDetailRepository();
  const matters = signal<ReadonlyMap<string, DeadlineMatterRef>>(new Map());
  const requested = new Set<string>();
  const load = async (missing: string[]) => {
    const found = await Promise.all(missing.map((id) => repo.get(id).catch(() => null)));
    matters.update((map) => {
      const next = new Map(map);
      found.forEach((matter, i) => {
        const id = missing[i] as string;
        next.set(
          id,
          matter
            ? {
                id,
                number: matter.number,
                title: matter.title,
                jurisdiction: matter.jurisdiction,
                responsibleUid: matter.responsibleUid,
                teamUids: matter.teamUids,
              }
            : { id, number: 'Restricted', title: 'Restricted matter' },
        );
      });
      return next;
    });
  };
  effect(() => {
    const missing = [...new Set(ids())].filter((id) => !requested.has(id));
    if (!missing.length) return;
    missing.forEach((id) => requested.add(id));
    untracked(() => void load(missing));
  });
  return matters.asReadonly();
}
