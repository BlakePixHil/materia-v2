import { inject } from '@angular/core';
import { Router } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  contactHit,
  contactSearchQuery,
  contactSearchRepository,
  documentHit,
  documentSearchQuery,
  documentSearchRepository,
  liveContact,
  matterDocumentSearchRepository,
  matterHit,
  matterSearchQuery,
  matterSearchRepository,
  matterTaskSearchQuery,
  myTaskSearchQuery,
  rankRows,
  recentEntriesQuery,
  recentMattersRepository,
  recentTargets,
  taskHit,
  taskSearchRepository,
  type ContactSearchItem,
  type DocumentSearchItem,
  type MatterSearchItem,
  type RecentTarget,
  type TaskSearchItem,
} from '@materia/data-access/repository';
import { contactDisplayName, parseSearchQuery, type RecentRef } from '@materia/domain';

import type { CommandProvider, CommandResult, CommandResultPage } from '../commands/command-registry';
import { matterCommands } from '../commands/matter-commands';
import { recentRecorder } from '../commands/recents';
import { MatterRefs } from '../title-strategy';

/** At most this many results per group: the best few, then a "type more" hint. */
export const SEARCH_SHOWN = 5;

/** A provider's page: the best `SEARCH_SHOWN`, and whether there were more (or the token was hot). */
function shown<T>(page: { rows: T[]; more: boolean }): { rows: T[]; more: boolean } {
  return { rows: page.rows.slice(0, SEARCH_SHOWN), more: page.more || page.rows.length > SEARCH_SHOWN };
}

type Id = { id: string };

/** `/matters/m1/…` → `m1`: the open matter, whose documents roles without privileged.view may search. */
export function openMatterId(url: string): string | null {
  const id = /^\/matters\/([^/?#]+)/.exec(url)?.[1] ?? null;
  return id && id !== 'new' ? decodeURIComponent(id) : null;
}

/**
 * The ⌘K search providers (CORE-15): matters, people, tasks and documents, each one Firestore
 * `array-contains` read of at most 20 rows (ADR-013), filtered to every word typed and ranked
 * (exact number, title prefix, recency). The queries prove what the rules need (ADR-033), so a role
 * gets results it may read and nothing else; a refused or failed read is that group's empty answer.
 * Opening a result records it in my recents. Create it in an injection context: the reads are
 * lazily loaded with the palette.
 */
export class SearchResults {
  private readonly router = inject(Router);
  private readonly context = inject(OrgContext);
  private readonly refs = inject(MatterRefs);
  private readonly privileged = can('privileged.view');
  private readonly record = recentRecorder();

  private readonly matters = matterSearchRepository();
  private readonly contacts = contactSearchRepository();
  private readonly tasks = taskSearchRepository();
  private readonly documents = documentSearchRepository();
  private readonly matterDocuments = matterDocumentSearchRepository(() => openMatterId(this.router.url));
  private readonly recents = recentMattersRepository();
  private readonly targets = recentTargets();
  /** Matter numbers already read, for the meta line of tasks and documents. */
  private readonly numbers = new Map<string, Promise<string | null>>();

  readonly providers: readonly CommandProvider[] = [
    { id: 'search.matters', group: 'Matters', search: (query) => this.searchMatters(query) },
    { id: 'search.contacts', group: 'People', search: (query) => this.searchContacts(query) },
    { id: 'search.tasks', group: 'Tasks', search: (query) => this.searchTasks(query) },
    { id: 'search.documents', group: 'Documents', search: (query) => this.searchDocuments(query) },
  ];

  /** The last things I opened in this org, newest first (the palette's empty state). */
  async recent(): Promise<CommandResult[]> {
    const orgId = this.context.orgId();
    if (!orgId) return [];
    const entries = await this.recents.query(recentEntriesQuery(orgId)).catch(() => []);
    const refs = entries.map((entry): RecentRef => ({
      kind: entry.kind,
      ...(entry.matterId ? { matterId: entry.matterId } : {}),
      ...(entry.entityId ? { entityId: entry.entityId } : {}),
    }));
    return (await this.targets(refs)).map((target) => this.recentResult(target));
  }

  // ---------- providers ----------

  private async searchMatters(typed: string): Promise<CommandResultPage> {
    const query = parseSearchQuery(typed);
    if (!query.token || !this.context.orgId()) return { results: [] };
    const rows = await this.matters.query(matterSearchQuery(query.token, this.privileged()));
    const page = shown(rankRows(rows, query, matterHit));
    return { results: page.rows.map((row) => this.matterResult(row)), more: page.more };
  }

  private async searchContacts(typed: string): Promise<CommandResultPage> {
    const query = parseSearchQuery(typed);
    if (!query.token || !this.context.orgId()) return { results: [] };
    const rows = await this.contacts.query(contactSearchQuery(query.token));
    const page = shown(rankRows(rows.filter(liveContact), query, contactHit, rows.length));
    return { results: page.rows.map((row) => this.contactResult(row)), more: page.more };
  }

  /**
   * My tasks (matter and personal), and for roles with privileged.view every matter's tasks too. A
   * role without it reads only its own: the rules can't prove a group query stays out of
   * privileged matters.
   */
  private async searchTasks(typed: string): Promise<CommandResultPage> {
    const query = parseSearchQuery(typed);
    const uid = this.context.uid();
    if (!query.token || !uid || !this.context.orgId()) return { results: [] };
    const [mine, others] = await Promise.all([
      this.tasks.query(myTaskSearchQuery(uid, query.token)),
      this.privileged() ? this.tasks.query(matterTaskSearchQuery(query.token)).catch(() => []) : [],
    ]);
    const key = (row: TaskSearchItem & Id) => `${row.matterId ?? ''}/${row.id}`;
    const rows = [...new Map([...mine, ...others].map((row) => [key(row), row])).values()];
    const page = shown(rankRows(rows, query, taskHit, Math.max(mine.length, others.length)));
    const numbers = await Promise.all(page.rows.map((row) => this.matterNumber(row.matterId)));
    return { results: page.rows.map((row, i) => this.taskResult(row, numbers[i] ?? null)), more: page.more };
  }

  /** Every document for roles with privileged.view; otherwise the open matter's non-privileged ones. */
  private async searchDocuments(typed: string): Promise<CommandResultPage> {
    const query = parseSearchQuery(typed);
    if (!query.token || !this.context.orgId()) return { results: [] };
    let rows: (DocumentSearchItem & Id)[];
    if (this.privileged()) rows = await this.documents.query(documentSearchQuery(query.token));
    else if (openMatterId(this.router.url))
      rows = await this.matterDocuments.query(documentSearchQuery(query.token, false));
    else return { results: [] };
    const page = shown(rankRows(rows, query, documentHit));
    const numbers = await Promise.all(page.rows.map((row) => this.matterNumber(row.matterId)));
    return { results: page.rows.map((row, i) => this.documentResult(row, numbers[i] ?? null)), more: page.more };
  }

  // ---------- results ----------

  private matterResult(row: Pick<MatterSearchItem, 'number' | 'title'> & Id): CommandResult {
    this.refs.set(row.id, row.number);
    const target = { id: row.id, number: row.number };
    return this.result({
      key: `matter:${row.id}`,
      title: row.title,
      meta: row.number,
      mono: true,
      icon: 'matters',
      href: `/matters/${row.id}/overview`,
      ref: { kind: 'matter', matterId: row.id },
      children: () => matterCommands(target, this.context.role(), (url) => this.go(url)),
    });
  }

  private contactResult(row: ContactSearchItem & Id): CommandResult {
    return this.result({
      key: `contact:${row.id}`,
      title: contactDisplayName(row),
      meta: row.kind === 'organisation' ? 'Organisation' : undefined,
      icon: 'user',
      href: `/contacts?contact=${encodeURIComponent(row.id)}`,
      ref: { kind: 'contact', entityId: row.id },
    });
  }

  private taskResult(row: Pick<TaskSearchItem, 'title' | 'matterId'> & Id, number: string | null): CommandResult {
    const matterId = row.matterId ?? null;
    const task = encodeURIComponent(row.id);
    return this.result({
      key: `task:${matterId ?? ''}:${row.id}`,
      title: row.title,
      meta: number ?? (matterId ? undefined : 'Personal'),
      mono: !!number,
      icon: 'check-circle',
      href: matterId ? `/matters/${matterId}/tasks?task=${task}` : `/tasks?task=${task}`,
      ref: { kind: 'task', ...(matterId ? { matterId } : {}), entityId: row.id },
    });
  }

  private documentResult(
    row: Pick<DocumentSearchItem, 'name' | 'matterId'> & Id,
    number: string | null,
  ): CommandResult {
    const matterId = row.matterId ?? openMatterId(this.router.url) ?? '';
    return this.result({
      key: `document:${matterId}:${row.id}`,
      title: row.name,
      meta: number ?? undefined,
      mono: !!number,
      icon: 'document',
      href: `/matters/${matterId}/documents/${row.id}`,
      ref: { kind: 'document', matterId, entityId: row.id },
    });
  }

  private recentResult(target: RecentTarget): CommandResult {
    const { ref } = target;
    switch (ref.kind) {
      case 'matter':
        return this.matterResult({ id: ref.matterId ?? '', number: target.number ?? '', title: target.title });
      case 'contact':
        return this.result({
          key: `contact:${ref.entityId}`,
          title: target.title,
          icon: 'user',
          href: `/contacts?contact=${encodeURIComponent(ref.entityId ?? '')}`,
          ref,
        });
      case 'task':
        return this.taskResult(
          { id: ref.entityId ?? '', title: target.title, matterId: ref.matterId ?? null },
          target.number ?? null,
        );
      case 'document':
        return this.documentResult(
          { id: ref.entityId ?? '', name: target.title, matterId: ref.matterId ?? '' },
          target.number ?? null,
        );
    }
  }

  private result(spec: {
    key: string;
    title: string;
    meta?: string | undefined;
    mono?: boolean;
    icon: CommandResult['icon'];
    href: string;
    ref: RecentRef;
    children?: CommandResult['children'];
  }): CommandResult {
    return {
      id: spec.key,
      title: spec.title,
      ...(spec.meta ? { meta: spec.meta, mono: !!spec.mono } : {}),
      icon: spec.icon,
      href: spec.href,
      ...(spec.children ? { children: spec.children } : {}),
      run: () => {
        this.record(spec.ref);
        return this.go(spec.href);
      },
    };
  }

  private go(url: string): Promise<boolean> {
    return this.router.navigateByUrl(url);
  }

  /** A matter's number (cached for the palette's life); null when it can't be read. */
  private matterNumber(matterId: string | null | undefined): Promise<string | null> {
    if (!matterId) return Promise.resolve(null);
    const known = this.refs.all()[matterId];
    if (known) return Promise.resolve(known);
    let number = this.numbers.get(matterId);
    if (!number) {
      number = this.matters
        .get(matterId)
        .then((matter) => {
          if (matter) this.refs.set(matterId, matter.number);
          return matter?.number ?? null;
        })
        .catch(() => null);
      this.numbers.set(matterId, number);
    }
    return number;
  }
}
