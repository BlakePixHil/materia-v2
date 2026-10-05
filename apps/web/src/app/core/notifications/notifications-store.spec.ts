import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { Connectivity, OrgContext } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { makeNotification } from '@materia/test-utils';
import { ToastService, type MtToastOptions } from '@materia/ui';

import { NOTIFICATIONS_START_DELAY_MS, NotificationsStore, URGENT_TOASTS_AT_ONCE } from './notifications-store';

/** The shell's unread count and urgent toasts (FND-20). Everyone is fictional. */

const ORG = 'org-harbour-vine';
const UID = 'user-jordan';
const N = `orgs/${ORG}/notifications`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(delay = 0) {
  const firestore = new InMemoryFirestore();
  const online = signal(true);
  const shown: MtToastOptions[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideInMemoryFirestore(firestore),
      NotificationsStore,
      { provide: NOTIFICATIONS_START_DELAY_MS, useValue: delay },
      { provide: Connectivity, useValue: { online } },
      { provide: ToastService, useValue: { show: (options: MtToastOptions) => void shown.push(options) } },
    ],
  });
  TestBed.inject(OrgContext).setSession({ uid: UID, orgId: ORG, role: 'lawyer' });
  const store = TestBed.inject(NotificationsStore);
  let at = Date.parse('2026-10-05T00:00:00.000Z');
  const add = (id: string, extra: Record<string, unknown> = {}) =>
    firestore.set(`${N}/${id}`, {
      ...makeNotification({ recipientUid: UID }),
      createdAt: new Date((at += 1000)),
      ...extra,
    });
  const tick = async () => {
    await settle();
    TestBed.tick();
    await settle();
    TestBed.tick();
  };
  return { firestore, online, shown, store, add, tick };
}

describe('NotificationsStore', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('counts my unread in-app notifications, leaving out read ones, bursts and other people’s', async () => {
    const { store, add, tick } = setup();
    add('n1');
    add('n2', { priority: 'high' });
    add('read', { readAt: new Date() });
    add('email-only', { channels: ['email'] });
    add('burst-member', { summaryId: 'burst-user-jordan-202610050000' });
    add('someone-else', { recipientUid: 'user-sam' });
    await tick();
    expect(store.count()).toBe(2);
  });

  it('says 99+ past the badge limit', async () => {
    const { store, add, tick } = setup();
    for (let i = 0; i < 120; i++) add(`n${String(i).padStart(3, '0')}`);
    await tick();
    expect(store.count()).toBe(100);
  });

  it('toasts a high-priority or critical arrival while online, never what was there before', async () => {
    const { store, add, tick, shown, online } = setup();
    add('already-urgent', { priority: 'critical' });
    await tick();
    expect(store.count()).toBe(1);
    expect(shown).toEqual([]);

    add('normal');
    add('urgent', {
      priority: 'high',
      title: 'Possible conflict on BL-2026-0042',
      body: 'Review the conflict check.',
      link: '/matters/m1',
    });
    await tick();
    expect(store.count()).toBe(3);
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Possible conflict on BL-2026-0042',
        description: 'Review the conflict check.',
        tone: 'neutral',
        duration: 8000,
      }),
    ]);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    shown[0]?.action?.run();
    expect(navigate).toHaveBeenCalledWith('/matters/m1');

    // A critical one stays until dismissed.
    add('critical', { priority: 'critical', title: 'A critical deadline is due tomorrow' });
    await tick();
    expect(shown.at(-1)).toMatchObject({ title: 'A critical deadline is due tomorrow', tone: 'danger', duration: 0 });

    // Offline: no toast (the badge still counts).
    online.set(false);
    add('offline', { priority: 'high' });
    await tick();
    expect(shown).toHaveLength(2);
    expect(store.count()).toBe(5);
  });

  it('sums up a flood of urgent arrivals in one extra toast', async () => {
    const { add, tick, shown } = setup();
    await tick();
    for (let i = 0; i < URGENT_TOASTS_AT_ONCE + 3; i++) add(`u${i}`, { priority: 'high', title: `Urgent ${i}` });
    await tick();
    expect(shown).toHaveLength(URGENT_TOASTS_AT_ONCE + 1);
    expect(shown.at(-1)).toMatchObject({ title: '3 more urgent notifications' });
  });

  it('starts again for another org, without toasting what is already there', async () => {
    const { add, tick, shown, firestore, store } = setup();
    add('n1');
    await tick();
    firestore.set(`orgs/org-other/notifications/x1`, {
      ...makeNotification({ recipientUid: UID }),
      priority: 'critical',
      createdAt: new Date(),
    });
    TestBed.inject(OrgContext).setSession({ uid: UID, orgId: 'org-other', role: 'lawyer' });
    await tick();
    expect(store.count()).toBe(1);
    expect(shown).toEqual([]);
  });

  it('starts listening after the page’s first reads', async () => {
    const { store, add, tick, firestore } = setup(30);
    add('n1');
    await tick();
    expect(firestore.listenerCount).toBe(0);
    expect(store.count()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await tick();
    expect(firestore.listenerCount).toBe(1);
    expect(store.count()).toBe(1);
  });

  it('shows no count when the read is refused', async () => {
    const { firestore, store, tick } = setup();
    firestore.breakListeners(N, { code: 'permission-denied' });
    await tick();
    expect(store.count()).toBe(0);
  });
});
