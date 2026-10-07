import {
  MIGRATION_REVIEW_CODES,
  type MigrationReviewCode,
  type MigrationReviewEntity,
  type MigrationReviewItem,
  type MigrationReviewResult,
} from '@materia/domain';

/** What each file of a migration run is, as Settings → Import lists it (MIG-06's counts, MIG-08). */
const FILE_LABELS: Record<string, string> = {
  matters: 'Matters',
  contacts: 'Contacts',
  parties: 'People on matters',
  documents: 'Documents',
  notes: 'Notes',
  tasks: 'Tasks',
  'personal-tasks': 'Personal tasks',
  activity: 'Matter history',
  'checklist-templates': 'Checklist templates',
  members: 'Team members',
};

/** The file each entity's review codes are counted against. */
const ENTITY_FILE: Partial<Record<MigrationReviewEntity, string>> = {
  matter: 'matters',
  contact: 'contacts',
  document: 'documents',
  member: 'members',
};

export interface ImportRow {
  file: string;
  label: string;
  count: number;
  /** Review codes open on these records. */
  open: number;
}

/** "What came across": each file the run brought, in the order above, with what is left to check. */
export function importRows(counts: Record<string, number>, review: MigrationReviewResult | null): ImportRow[] {
  const open = new Map<string, number>();
  for (const count of review?.codes ?? []) {
    const file = ENTITY_FILE[MIGRATION_REVIEW_CODES[count.code].entity];
    if (file) open.set(file, (open.get(file) ?? 0) + count.open);
  }
  return Object.entries(FILE_LABELS)
    .filter(([file]) => (counts[file] ?? 0) > 0)
    .map(([file, label]) => ({ file, label, count: counts[file] ?? 0, open: open.get(file) ?? 0 }));
}

/** What a run's own warnings mean (MIG-06's conflicts and failures). */
const RUN_WARNINGS: Record<string, string> = {
  MIG_C_USER_EDITED: 'Changed in Materia since an earlier load, so kept as you had them',
  MIG_C_NOT_MIGRATED: 'Made in Materia itself, so left alone',
  MIG_C_NUMBER_TAKEN: 'Matter number already used by another matter',
  MIG_E_WRITE_FAILED: 'Couldn’t be written',
};

export interface WarningGroup {
  code: string;
  label: string;
  count: number;
}

/** A run's warnings by kind, most first. */
export function warningGroups(warnings: readonly { code: string }[]): WarningGroup[] {
  const counts = new Map<string, number>();
  for (const warning of warnings) counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, label: RUN_WARNINGS[code] ?? code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export interface FixLink {
  link: string[];
  label: string;
}

const MATTER_TAB_LABEL = { overview: 'Open matter', parties: 'Open parties', time: 'Open time and disbursements' };

/** Where a code is put right, when that's another page. */
export function fixLink(item: MigrationReviewItem, code: MigrationReviewCode): FixLink | null {
  const info = MIGRATION_REVIEW_CODES[code];
  switch (info.fix) {
    case 'matter': {
      const tab = 'tab' in info ? info.tab : 'overview';
      return item.matterId ? { link: ['/matters', item.matterId, tab], label: MATTER_TAB_LABEL[tab] } : null;
    }
    case 'rename-matter':
      return item.matterId ? { link: ['/matters', item.matterId, 'overview'], label: 'Open matter' } : null;
    case 'rename-contact':
      return { link: ['/contacts', item.id], label: 'Open contact' };
    case 'document':
      return item.matterId ? { link: ['/matters', item.matterId, 'documents', item.id], label: 'Open document' } : null;
    case 'org-name':
      return { link: ['/settings', 'practice'], label: 'Change in Practice' };
    case 'team':
      return { link: ['/settings', 'team'], label: 'Open team' };
  }
}

/** "92% reviewed · 12 to check". */
export function progressText(review: Pick<MigrationReviewResult, 'percent' | 'open'>): string {
  if (!review.open) return 'All reviewed';
  return `${review.percent}% reviewed · ${review.open} to check`;
}

/** A count with its noun ("1 item", "12 items"). */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
