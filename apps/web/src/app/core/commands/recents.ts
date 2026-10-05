import { inject } from '@angular/core';

import { DATA_CLOCK, OrgContext } from '@materia/data-access';
import { recentMattersRepository, recordRecent } from '@materia/data-access/repository';
import { recentEntryId, type RecentRef } from '@materia/domain';

/**
 * Records what I open (CORE-15: ⌘K's Recent group; CORE-14: Today's Recent matters) in
 * `users/{uid}/recent`, once per entity in a row. Not awaited: offline, it's saved when back
 * online; a refused write only means it isn't listed. Create it in an injection context.
 */
export function recentRecorder(): (ref: RecentRef) => void {
  const context = inject(OrgContext);
  const clock = inject(DATA_CLOCK);
  const recents = recentMattersRepository();
  let last: string | null = null;
  return (ref) => {
    const orgId = context.orgId();
    if (!orgId) return;
    const id = recentEntryId(orgId, ref);
    if (id === last) return;
    last = id;
    recordRecent(recents, orgId, ref, new Date(clock())).catch(() => undefined);
  };
}
