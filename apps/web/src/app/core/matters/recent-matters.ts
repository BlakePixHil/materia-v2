import { effect, inject, signal, untracked, type Signal } from '@angular/core';

import { can, OrgContext } from '@materia/data-access';
import {
  recentMattersQuery,
  recentMattersRepository,
  todayMatterRepository,
  type RecentMatterItem,
} from '@materia/data-access/repository';
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
 * no longer read, is left out, and offline it's whatever this device has. Each entry carries its
 * matter's name (SEC-07e); only an entry without one (from before) reads its matter. Call in an
 * injection context.
 */
export function recentMatters(): RecentMatters {
  const context = inject(OrgContext);
  const privilegedVisible = can('privileged.view');
  const recents = recentMattersRepository();
  const matters = todayMatterRepository();
  const items = signal<readonly RecentMatter[]>([]);
  const loading = signal(true);
  let latest = 0;

  const named = async (matterId: string, copy: RecentMatterItem['matter']): Promise<RecentMatter | null> => {
    if (copy?.deleted || (copy?.privileged && !privilegedVisible())) return null;
    if (copy?.type) return { id: matterId, number: copy.number, title: copy.title, type: copy.type };
    const matter = await matters.get(matterId).catch(() => null);
    return matter && !matter.deletedAt
      ? { id: matterId, number: matter.number, title: matter.title, type: matter.type }
      : null;
  };

  const load = async (orgId: string, run: number): Promise<void> => {
    try {
      const rows = await recents.query(recentMattersQuery(orgId));
      const seen = new Set<string>();
      const entries = rows.flatMap((row) =>
        row.matterId && !seen.has(row.matterId) && seen.add(row.matterId)
          ? [{ id: row.matterId, copy: row.matter }]
          : [],
      );
      const found = await Promise.all(entries.map((entry) => named(entry.id, entry.copy)));
      if (run !== latest) return;
      items.set(found.filter((matter): matter is RecentMatter => !!matter));
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
