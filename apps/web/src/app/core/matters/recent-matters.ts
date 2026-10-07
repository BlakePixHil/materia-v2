import { effect, inject, signal, untracked, type Signal } from '@angular/core';

import { OrgContext } from '@materia/data-access';
import { recentMattersQuery, recentMattersRepository, todayMatterRepository } from '@materia/data-access/repository';
import type { MatterType } from '@materia/domain';

/** A matter I opened lately, named. */
export interface RecentMatter {
  id: string;
  number: string;
  title: string;
  type: MatterType;
}

export interface RecentMatters {
  /** Newest first. */
  items: Signal<readonly RecentMatter[]>;
  loading: Signal<boolean>;
}

/**
 * The matters I opened lately in the active org, newest first and named: the phone's Record chips
 * and the top of its Matters list (MOB-02). Read once per org; a matter deleted since, or one I can
 * no longer read, is left out, and offline it's whatever this device has. Call in an injection context.
 */
export function recentMatters(): RecentMatters {
  const context = inject(OrgContext);
  const recents = recentMattersRepository();
  const matters = todayMatterRepository();
  const items = signal<readonly RecentMatter[]>([]);
  const loading = signal(true);
  let latest = 0;

  const load = async (orgId: string, run: number): Promise<void> => {
    try {
      const rows = await recents.query(recentMattersQuery(orgId));
      const ids = [...new Set(rows.map((row) => row.matterId).filter((id): id is string => !!id))];
      const found = await Promise.all(ids.map((id) => matters.get(id).catch(() => null)));
      if (run !== latest) return;
      items.set(
        found.flatMap((matter, i) =>
          matter && !matter.deletedAt
            ? [{ id: ids[i] as string, number: matter.number, title: matter.title, type: matter.type }]
            : [],
        ),
      );
    } catch {
      // No recents (offline before they were ever read): the lists work without them.
      if (run === latest) items.set([]);
    } finally {
      if (run === latest) loading.set(false);
    }
  };

  effect(() => {
    const orgId = context.orgId();
    const run = ++latest;
    untracked(() => {
      if (!orgId) {
        items.set([]);
        loading.set(false);
        return;
      }
      loading.set(true);
      void load(orgId, run);
    });
  });

  return { items: items.asReadonly(), loading: loading.asReadonly() };
}
