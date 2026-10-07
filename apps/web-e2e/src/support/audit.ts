import { devices, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { addDays, contactSearchTokens, locationKey, packetSearchTokens, partyDocId, today } from '@materia/domain';
import {
  a11yViolationsInThemes,
  type A11yOptions,
  setClerkKey,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './matters';

/**
 * The accessibility audit's practice (SEC-06): one fictional org with every feature flag a page
 * sits behind turned on, and enough records that each page shows its content rather than its empty
 * state: matters of three types, parties, tasks and deadlines due around today, a note, a time
 * entry, a stored document, a will in safe custody and notifications. Fictional data only.
 */

export const ZONE = 'Australia/Melbourne';

/**
 * Playwright's iPhone 13 profile without its browser, so a describe block can use it in whichever
 * project runs (Chromium on PRs; the morning run's WebKit project uses the whole profile).
 */
export const PHONE = (({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }) => ({
  viewport,
  userAgent,
  deviceScaleFactor,
  isMobile,
  hasTouch,
}))(devices['iPhone 13']);
export const MATTER = 'm-audit';
export const MATTER_NUMBER = 'M-2026-0707';
export const MATTER_TITLE = 'Estate of Wilhelmina Audit';
/** A contested estate, for the Litigation tab. */
export const DISPUTE = 'm-audit-contest';
/** An original will in safe custody, for the packet page. */
export const PACKET = 'sc-audit';

/** Every flag a route, tab or panel sits behind (libs/domain flags), so the audit reaches them all. */
const FLAGS: Record<string, boolean> = {
  'clerk.enabled': true,
  'clerk.features.brief': true,
  'clerk.features.chat': true,
  'clerk.features.suggestions': true,
  'clerk.features.drafting': true,
  'conflicts.enforced': true,
  'templates.system': true,
  'matters.destruction': true,
  'estate.register': true,
  'litigation.enabled': true,
  'billing.invoicing': true,
  'billing.feeBudgets': true,
  'billing.costsDisclosure': true,
  'billing.disbursements': true,
  'billing.trustDisplay': true,
  'integrations.xero': true,
};

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

function contact(uid: string, givenNames: string, familyName: string) {
  return {
    kind: 'person',
    givenNames,
    familyName,
    sortName: `${familyName} ${givenNames}`.toLowerCase(),
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    search: contactSearchTokens({ givenNames, familyName }),
    deletedAt: null,
    ...meta(uid),
  };
}

/** Writes the audit practice for `uid` (an owner, lawyer, paralegal or read-only member of `orgId`). */
export async function seedAuditPractice(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  const day = today(ZONE);
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Audit Practice',
        timezone: ZONE,
        jurisdictions: ['VIC'],
        primaryJurisdiction: 'VIC',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
        flags: FLAGS,
      },
    },
  ]);
  // After the org document, which it patches (the data-use disclosure acknowledged, a key stored).
  await setClerkKey(request, orgId);
  await seedClient(request, orgId, uid);
  const probate = matterDoc(orgId, uid, {
    id: MATTER,
    number: MATTER_NUMBER,
    title: MATTER_TITLE,
    responsibleUid: uid,
    daysAgo: 1,
  });
  const will = matterDoc(orgId, uid, {
    id: 'm-audit-will',
    number: 'M-2026-0708',
    title: 'Will for Ottoline Fictional',
    type: 'will',
    responsibleUid: uid,
    daysAgo: 3,
  });
  const contest = matterDoc(orgId, uid, {
    id: DISPUTE,
    number: 'M-2026-0709',
    title: 'Fictional v Estate of Audit',
    type: 'contest',
    responsibleUid: uid,
    daysAgo: 5,
  });
  const M = `orgs/${orgId}/matters/${MATTER}`;
  const task = (id: string, title: string, dueDate: string, order: number) => ({
    path: `${M}/tasks/${id}`,
    data: {
      orgId,
      matterId: MATTER,
      title,
      dueDate,
      status: 'todo',
      priority: 'high',
      checklist: [],
      order,
      source: 'manual',
      countedOpen: true,
      assigneeUid: uid,
      deletedAt: null,
      ...meta(uid),
    },
  });
  const deadline = (id: string, title: string, dueDate: string) => ({
    path: `${M}/deadlines/${id}`,
    data: {
      orgId,
      matterId: MATTER,
      title,
      dueDate,
      kind: 'internal',
      critical: false,
      status: 'upcoming',
      assigneeUid: uid,
      reminders: [],
      pastOnCreation: false,
      deletedAt: null,
      ...meta(uid),
    },
  });
  const notification = (id: string, minutesAgo: number, extra: Record<string, unknown>) => {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    return {
      path: `orgs/${orgId}/notifications/${id}`,
      data: {
        kind: 'task_assigned',
        taskId: 't-audit-1',
        recipientUid: uid,
        title: 'Task assigned to you',
        body: 'Lodge the inventory of assets',
        link: '/tasks',
        channels: ['inapp'],
        priority: 'normal',
        readAt: null,
        summaryId: null,
        createdAt: at,
        createdBy: 'system',
        updatedAt: at,
        updatedBy: 'system',
        schemaVersion: 2,
        ...extra,
      },
    };
  };
  const vault = { site: 'Geelong office', cabinet: 'Safe A', slot: '12' };
  const sha256 = 'a1'.repeat(32);
  const storagePath = `${M}/documents/d-audit-letter/v1`;
  await setEmulatorDocuments(request, [
    { path: `orgs/${orgId}/contacts/c-audit-exec`, data: contact(uid, 'Tamsin', 'Larkwood') },
    { path: `orgs/${orgId}/contacts/c-audit-heir`, data: contact(uid, 'Rupert', 'Fictional') },
    {
      ...probate,
      data: { ...probate.data, stageId: 'intake', openTaskCount: 2, estate: { grantType: 'probate' } },
    },
    { ...will, data: { ...will.data, stageId: 'intake' } },
    { ...contest, data: { ...contest.data, stageId: 'intake' } },
    ...(
      [
        ['client', 'c-client'],
        ['executor', 'c-audit-exec'],
        ['beneficiary', 'c-audit-heir'],
      ] as const
    ).map(([role, contactId]) => ({
      path: `${M}/parties/${partyDocId(role, contactId)}`,
      data: { contactId, role, orgId, matterId: MATTER, addedFrom: 'manual', deletedAt: null, ...meta(uid) },
    })),
    task('t-audit-1', 'Lodge the inventory of assets', day, 1024),
    task('t-audit-2', 'Call the executor about the bank accounts', addDays(day, 2), 2048),
    deadline('d-audit-late', 'Advertise for creditors', addDays(day, -2)),
    deadline('d-audit-today', 'Send the costs disclosure update', day),
    deadline('d-audit-next', 'Apply for the grant of probate', addDays(day, 9)),
    {
      path: `${M}/notes/n-audit`,
      data: {
        orgId,
        matterId: MATTER,
        bodyMd: 'Spoke to the executor about the house (fictional).',
        mentions: { uids: [], matterIds: [] },
        privileged: false,
        pinned: false,
        source: 'manual',
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `${M}/timeEntries/te-audit`,
      data: {
        orgId,
        matterId: MATTER,
        uid,
        date: day,
        minutes: 30,
        units: 5,
        rateCents: 30000,
        amountCents: 15000,
        narrative: 'Attendance on executor at Geelong office',
        billable: true,
        status: 'draft',
        source: 'manual',
        wipCountedCents: 15000,
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `${M}/documents/d-audit-letter`,
      data: {
        orgId,
        matterId: MATTER,
        name: 'Letter to the executor (fictional).pdf',
        category: 'correspondence',
        privileged: false,
        accessRestricted: false,
        tags: [],
        storagePath,
        mime: 'application/pdf',
        sizeBytes: 1200,
        sha256,
        version: 1,
        versionSeq: 1,
        versions: [
          {
            version: 1,
            storagePath,
            fileName: 'Letter to the executor (fictional).pdf',
            mime: 'application/pdf',
            sizeBytes: 1200,
            sha256,
            uploadedAt: new Date(),
            uploadedBy: uid,
          },
        ],
        scan: { status: 'clean', at: new Date() },
        // Already read for Clerk: the stored record has no bytes for the ingest task to read.
        ingest: { status: 'done', version: 1, pages: 1 },
        source: 'upload',
        encrypted: false,
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `orgs/${orgId}/safeCustody/${PACKET}`,
      data: {
        packetNo: 'SC-000707',
        testatorContactId: 'c-audit-heir',
        testatorName: 'Rupert Fictional',
        responsibleUid: uid,
        matterId: 'm-audit-will',
        items: [{ kind: 'will', date: addDays(day, -30), description: 'Original will (fictional)' }],
        location: vault,
        receivedOn: addDays(day, -30),
        status: 'held',
        movements: [{ at: new Date(), by: uid, kind: 'in', reason: 'Received after signing', location: vault }],
        search: packetSearchTokens('SC-000707', 'Rupert Fictional', vault),
        locationKey: locationKey(vault),
        deletedAt: null,
        ...meta(uid),
      },
    },
    notification('n-audit-task', 10, { title: 'Lodge the inventory of assets', matterId: MATTER }),
    notification('n-audit-system', 30, { kind: 'system', taskId: undefined, title: 'Welcome to the inbox' }),
    notification('n-audit-read', 60 * 30, { title: 'Read yesterday', readAt: new Date() }),
  ]);
}

export type AuditRole = 'owner' | 'lawyer' | 'paralegal' | 'readonly';

/** A fresh member of a new audit practice, signed in and on Today. */
export async function signInToAuditPractice(
  page: Page,
  request: APIRequestContext,
  role: AuditRole = 'owner',
): Promise<{ orgId: string; uid: string }> {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role, orgName: 'Fictional Audit Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedAuditPractice(request, orgId, account.uid);
  return { orgId, uid: account.uid };
}

/**
 * Waits until the page has its content: a level-1 heading, and no loading skeleton or status left
 * (pages show `mt-skeleton` until their first answer). The emulators are shared with other workers,
 * so first reads can take a while.
 */
export async function settled(page: Page): Promise<void> {
  // An empty state can be the page's heading (`mt-empty-state [headingLevel]="1"`: an h3 with aria-level 1).
  await expect(page.locator('h1, [role="heading"][aria-level="1"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('mt-skeleton:visible')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Collects axe findings across a test's pages in both themes, so one run lists every violation
 * instead of stopping at the first page with one. `expectClean()` fails the test with them all.
 */
export class Audit {
  readonly found: string[] = [];
  readonly scanned: string[] = [];

  constructor(private readonly page: Page) {}

  /** Scans the page as it is now, in the light and the dark theme. */
  async scan(label: string, options: A11yOptions = {}): Promise<void> {
    this.scanned.push(label);
    for (const line of await a11yViolationsInThemes(this.page, options)) this.found.push(`${label} ${line}`);
  }

  /** Opens a route, waits for its content and scans it. */
  async visit(url: string, label = url, ready: (page: Page) => Promise<void> = settled): Promise<void> {
    await this.page.goto(url);
    await ready(this.page);
    await this.scan(label);
  }

  expectClean(): void {
    expect(this.found, `axe WCAG 2.2 AA violations on ${this.scanned.length} pages in both themes`).toEqual([]);
  }
}

/** Where keyboard focus is after a Tab: what it is, and whether a sighted keyboard user can see it. */
export interface FocusStop {
  /** Tag, classes and accessible name, for the failure message. */
  element: string;
  /** A focus indicator shows: a ring (box-shadow) or a visible outline, on it or its field wrapper. */
  indicated: boolean;
  /** Something the app drew (a sticky bar, a toast) entirely covers it (WCAG 2.4.11). */
  obscured: boolean;
  onBody: boolean;
}

/** Presses Tab (or Shift+Tab) and reports the focused element (WCAG 2.4.3, 2.4.7, 2.4.11). */
export async function tabTo(page: Page, back = false): Promise<FocusStop> {
  await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  return page.evaluate(async () => {
    // Let the focus styles (and anything focus scrolls into view) render before measuring.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { element: 'body', indicated: true, obscured: false, onBody: true };
    const ring = (node: Element | null | undefined) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const outline =
        style.outlineStyle !== 'none' &&
        parseFloat(style.outlineWidth) > 0 &&
        !/rgba\([^)]*,\s*0\)|transparent/.test(style.outlineColor);
      return style.boxShadow !== 'none' || outline;
    };
    // Fields show focus on their wrapper (`.mt-input:focus-within`); table rows on their cells.
    const indicated =
      ring(el) ||
      ring(el.closest('.mt-input, .mt-select, .mt-composer, .mt-cmdk-input')) ||
      (el.tagName === 'TR' && ring(el.querySelector('td')));
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = el.getBoundingClientRect();
    const points = [
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + 2, box.top + 2],
      [box.right - 2, box.bottom - 2],
    ];
    const obscured = points.every(([x, y]) => {
      const top = document.elementFromPoint(x as number, y as number);
      return !!top && !el.contains(top) && !top.contains(el);
    });
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const classes = [...el.classList].slice(0, 2).join('.');
    return {
      element: `${el.tagName.toLowerCase()}${classes ? '.' + classes : ''} "${name}"`,
      indicated,
      obscured,
      onBody: false,
    };
  });
}

/** The page's headings (level and text) and landmarks, as a screen reader's lists show them. */
export async function pageOutline(page: Page): Promise<{ headings: [number, string][]; mains: number }> {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !el.closest('[aria-hidden="true"], [hidden]');
    };
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
      .filter(shown)
      .map((el): [number, string] => [
        Number(el.getAttribute('aria-level') ?? el.tagName.slice(1)),
        (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      ]);
    const mains = [...document.querySelectorAll('main, [role="main"]')].filter(shown).length;
    return { headings, mains };
  });
}

/** How far the page scrolls sideways (WCAG 1.4.10 Reflow), with the elements that stick out. */
export async function sidewaysScroll(page: Page): Promise<{ overflow: number; culprits: string[] }> {
  return page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const culprits =
      overflow > 0
        ? [...document.querySelectorAll('body *')]
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`)
        : [];
    return { overflow, culprits };
  });
}

/**
 * The contrast ratio of an element's text on its own opaque background (WCAG 1.4.3), for text axe
 * doesn't measure: text hidden from screen readers but still seen (a calendar's day numbers), or a
 * badge drawn over an icon (axe leaves overlapping text for a person to review).
 */
export async function ownContrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = channels(color).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light = 0, dark = 0] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}
