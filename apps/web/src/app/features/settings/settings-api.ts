import { inject, Injectable } from '@angular/core';

import type { MemberSecurity, UpdateOrgSettingsInput, UpdateOrgSettingsResult } from '@materia/domain';

import { CALLABLES } from '../../core/data/callables';

/** One audit entry as `audit-query` returns it (FND-18). */
export interface AuditEntryView {
  id: string;
  at: string;
  actor: { uid: string } | 'system' | 'clerk';
  action: string;
  entity: { path: string; collection?: string; id?: string; matterId?: string };
  changedFields?: string[];
  summary?: string;
  source: string;
  requestId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** The audit log filters (CORE-21). Dates are ISO instants. */
export interface AuditFilters {
  actorUid?: string | undefined;
  collection?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The settings callables (CORE-21): `orgs-updateSettings`, `orgs-memberSecurity`, `audit-*`. */
@Injectable({ providedIn: 'root' })
export class SettingsApi {
  private readonly callables = inject(CALLABLES);

  updateSettings(input: Omit<UpdateOrgSettingsInput, 'requestId'>): Promise<UpdateOrgSettingsResult> {
    return this.callables.call('orgs-updateSettings', input, { idempotent: true });
  }

  async memberSecurity(uids: string[]): Promise<MemberSecurity[]> {
    if (!uids.length) return [];
    const result = await this.callables.call<{ uids: string[] }, { members: MemberSecurity[] }>('orgs-memberSecurity', {
      uids: uids.slice(0, 100),
    });
    return result.members;
  }

  auditQuery(
    filters: AuditFilters,
    cursor?: string,
  ): Promise<{ entries: AuditEntryView[]; nextCursor: string | null }> {
    return this.callables.call('audit-query', { ...clean(filters), ...(cursor ? { cursor } : {}), limit: 50 });
  }

  auditExport(filters: AuditFilters): Promise<{ csv: string; rows: number; truncated: boolean }> {
    return this.callables.call('audit-exportCsv', clean(filters));
  }
}

/** Drops empty filters: the callables reject empty strings. */
function clean(filters: AuditFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => !!value)) as Record<string, string>;
}
