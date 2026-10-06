import { inject, Injectable, Injector, runInInjectionContext } from '@angular/core';

import { OrgContext } from '@materia/data-access';
import {
  contactsRepository,
  insightsOrgRepository,
  membersRepository,
  metricsRepository,
  periodMetricsRepository,
  type InsightsOrg,
} from '@materia/data-access/repository';
import {
  contactDisplayName,
  METRIC_SHARD_MEMBER_THRESHOLD,
  METRIC_SHARDS,
  sumMetricShards,
  sumMetricValues,
  type MetricValues,
  type Role,
} from '@materia/domain';

import type { InsightsMember } from './insights-view';

/**
 * Reads what the Insights screen shows (INS-02), from the INS-01 metrics documents only: month
 * documents by id (with their counter shards in an org large enough to use them), members' figures
 * under `byMember/{uid}`, and the names behind members and referrers. Everything read is kept for
 * the life of the screen, so switching periods back and forth reads each document once.
 */
@Injectable()
export class InsightsData {
  private readonly context = inject(OrgContext);
  private readonly metrics = metricsRepository();
  private readonly membersRepo = membersRepository();
  private readonly contacts = contactsRepository();
  private readonly orgRepo = insightsOrgRepository();
  private readonly injector = inject(Injector);
  private readonly children = new Map<string, ReturnType<typeof periodMetricsRepository>>();

  private readonly docs = new Map<string, Promise<MetricValues | null>>();
  private readonly names = new Map<string, Promise<string | null>>();
  private org: Promise<InsightsOrg | null> | null = null;
  private members: Promise<InsightsMember[]> | null = null;

  /** The org's FY start, daily target, time zone and member visibility. */
  loadOrg(): Promise<InsightsOrg | null> {
    const orgId = this.context.orgId();
    if (!orgId) return Promise.resolve(null);
    this.org ??= this.orgRepo.get(orgId).catch((error: unknown) => {
      this.org = null;
      throw error;
    });
    return this.org;
  }

  /** Every member, those who left included (their figures stay, as "Former member"). */
  loadMembers(): Promise<InsightsMember[]> {
    this.members ??= this.membersRepo
      .query({
        where: [['status', 'in', ['active', 'suspended', 'removed']]],
        orderBy: [['displayName', 'asc']],
        pageSize: 500,
      })
      .then((rows) =>
        rows.map((row) => ({
          uid: row.id,
          name: row.displayName,
          role: row.role as Role,
          status: row.status,
          budgets: row.budgets ?? {},
        })),
      )
      .catch((error: unknown) => {
        this.members = null;
        throw error;
      });
    return this.members;
  }

  /**
   * Months' figures by `2026-10`: each `metrics/month-…` document with its shards added when the
   * org has more active members than the shard threshold. A month without a document is absent.
   */
  async loadMonths(months: readonly string[], sharded: boolean): Promise<Map<string, MetricValues>> {
    const found = await Promise.all(months.map((month) => this.period(`month-${month}`, sharded)));
    const out = new Map<string, MetricValues>();
    months.forEach((month, i) => {
      const values = found[i];
      if (values) out.set(month, values);
    });
    return out;
  }

  /**
   * Members' figures over some periods (`month-2026-10`, `fy-2026`), added up, by uid. A document
   * the rules don't let me read (another member's, under the org's visibility setting) counts as
   * none.
   */
  async loadMemberValues(periods: readonly string[], uids: readonly string[]): Promise<Map<string, MetricValues>> {
    const out = new Map<string, MetricValues>();
    await Promise.all(
      uids.map(async (uid) => {
        const list = await Promise.all(periods.map((period) => this.read(period, 'byMember', uid).catch(() => null)));
        out.set(uid, sumMetricValues(list));
      }),
    );
    return out;
  }

  /** Contacts' display names by id; one that can't be read is left out. */
  async loadContactNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        let name = this.names.get(id);
        if (!name) {
          name = this.contacts
            .get(id)
            .then((contact) => (contact ? contactDisplayName(contact) : null))
            .catch(() => null);
          this.names.set(id, name);
        }
        const found = await name;
        if (found) out.set(id, found);
      }),
    );
    return out;
  }

  /** Whether the org writes its counters to shards (ADR-048): more active members than the threshold. */
  static sharded(members: readonly InsightsMember[]): boolean {
    return members.filter((member) => member.status === 'active').length > METRIC_SHARD_MEMBER_THRESHOLD;
  }

  /** Forget everything read (Retry after an error). */
  reset(): void {
    this.docs.clear();
    this.names.clear();
    this.org = null;
    this.members = null;
  }

  private async period(id: string, sharded: boolean): Promise<MetricValues | null> {
    const main = await this.read(id);
    if (!sharded) return main;
    const shards = await Promise.all(
      Array.from({ length: METRIC_SHARDS }, (_, n) => this.read(id, 'shards', String(n)).catch(() => null)),
    );
    if (!main && shards.every((shard) => !shard)) return null;
    return sumMetricShards(
      main ?? undefined,
      shards.map((shard) => shard ?? undefined),
    );
  }

  /** The repository of a period's members' figures or shards (built once per period). */
  private child(period: string, kind: 'byMember' | 'shards') {
    const key = `${period}/${kind}`;
    let found = this.children.get(key);
    if (!found) {
      found = runInInjectionContext(this.injector, () => periodMetricsRepository(period, kind));
      this.children.set(key, found);
    }
    return found;
  }

  /**
   * One metrics document's `values`, or null when there is none: a period's (`month-2026-10`), or
   * one under it (`byMember/{uid}`, `shards/{n}`).
   */
  private read(period: string, kind?: 'byMember' | 'shards', id?: string): Promise<MetricValues | null> {
    const key = kind && id ? `${period}/${kind}/${id}` : period;
    let found = this.docs.get(key);
    if (!found) {
      const doc = kind && id ? this.child(period, kind).get(id) : this.metrics.get(period);
      found = doc.then((row) => (row ? row.values : null));
      // A failed read is tried again next time.
      found.catch(() => this.docs.delete(key));
      this.docs.set(key, found);
    }
    return found;
  }
}
