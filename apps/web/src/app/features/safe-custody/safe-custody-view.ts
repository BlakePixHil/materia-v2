import { InjectionToken } from '@angular/core';

import {
  currentItemIndex,
  DomainError,
  SAFE_CUSTODY_ITEM_LABELS,
  type SafeCustodyItem,
  type SafeCustodyItemKind,
  type SafeCustodyStatus,
} from '@materia/domain';
import type { MtBadgeTone, MtOption } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

/** The register's badge tone for each status: held is the normal state; released and destroyed are closed. */
export const STATUS_TONES: Record<SafeCustodyStatus, MtBadgeTone> = {
  held: 'success',
  out: 'warning',
  released: 'neutral',
  destroyed: 'danger',
};

export const ITEM_KIND_OPTIONS: MtOption<SafeCustodyItemKind>[] = Object.entries(SAFE_CUSTODY_ITEM_LABELS).map(
  ([value, label]) => ({ value: value as SafeCustodyItemKind, label }),
);

/**
 * The item to flag "current", or -1. Only worth saying when the packet holds more than one will or
 * codicil: a lone will is simply the will.
 */
export function currentFlag(items: readonly Pick<SafeCustodyItem, 'kind' | 'date'>[]): number {
  const testamentary = items.filter((item) => item.kind === 'will' || item.kind === 'codicil').length;
  return testamentary > 1 ? currentItemIndex(items) : -1;
}

/** What a refused `safeCustody-*` call means for the person, in their words. */
export function safeCustodyErrorCopy(error: unknown): string {
  const details = error instanceof DomainError ? error.details : undefined;
  switch (details?.['reason']) {
    case 'packet_closed':
      return 'This packet has been released or destroyed, so it can’t change.';
    case 'destruction_pending':
      return 'A destruction is waiting for a second lawyer. Confirm or decline it first.';
    case 'invalid_movement':
      return 'That movement doesn’t fit where the packet is now. Reload to see its latest status.';
    case 'no_pending_destruction':
      return 'There’s no destruction waiting any more. Someone may have dealt with it already.';
    case 'same_person':
      return 'A second lawyer must confirm a destruction you asked for. You can withdraw it instead.';
    case 'not_ready':
      return 'The PDF isn’t ready yet. Try again in a moment.';
  }
  const fields = details?.['fields'];
  if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && fields && typeof fields === 'object') {
    const messages = Object.values(fields as Record<string, unknown>).flatMap((value) =>
      Array.isArray(value) ? value.map(String) : [],
    );
    if (messages.length) return `${messages.join('. ')}.`;
  }
  return errorCopy(error);
}

/**
 * Starts a PDF download: the browser goes to the signed URL, served as an attachment, so the page
 * stays where it is. Tests replace it.
 */
export const EXPORT_NAVIGATOR = new InjectionToken<(url: string) => void>('EXPORT_NAVIGATOR', {
  providedIn: 'root',
  factory: () => (url: string) => window.location.assign(url),
});
