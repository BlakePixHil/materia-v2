import { computed, effect, signal, untracked, type Signal } from '@angular/core';

import { matterDetailRepository } from '@materia/data-access/repository';
import type { MtMentionMatter, MtMentionMatterResolver, MtMentionMemberResolver } from '@materia/ui/markdown';

import type { NoteMember } from './note-view';

/**
 * How notes name what they mention (CORE-13): members from the matter screen's list (a removed
 * member reads "Former member", as plain text), and matters read once each by id. A matter the
 * reader can't open (privileged, or not found) resolves to `null`, shown as "Restricted matter".
 */

/** A member resolver over the screen's members; recreated when the list changes. */
export function memberResolver(members: () => readonly NoteMember[]): Signal<MtMentionMemberResolver> {
  return computed(() => {
    const byUid = new Map(members().map((member) => [member.uid, member]));
    return (uid: string) => {
      const member = byUid.get(uid);
      if (!member) return { name: 'Former member', former: true };
      return { name: member.name, former: member.status !== 'active' };
    };
  });
}

/**
 * Matters mentioned in some notes, each read once (number and title, for the chip). Create it in an
 * injection context; `ids` is watched. The resolver is `undefined` for a matter still loading.
 */
export function matterResolver(ids: () => readonly string[]): Signal<MtMentionMatterResolver> {
  const repo = matterDetailRepository();
  const found = signal<ReadonlyMap<string, MtMentionMatter | null>>(new Map());
  const requested = new Set<string>();
  const load = async (missing: string[]) => {
    const matters = await Promise.all(missing.map((id) => repo.get(id).catch(() => null)));
    found.update((map) => {
      const next = new Map(map);
      matters.forEach((matter, i) => {
        const id = missing[i] as string;
        next.set(id, matter ? { number: matter.number, title: matter.title, link: `/matters/${id}/overview` } : null);
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
  return computed(() => {
    const map = found();
    return (id: string) => map.get(id);
  });
}
