import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { addDays, contactSearchTokens, partyDocId, today } from '@materia/domain';
import { expectNoA11yViolations, FIRST_LOAD, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The phone screens (MOB-02) on an iPhone 12 and a Pixel 7, in both themes: Today, Matters, a
 * matter, Record and More, reached through the TabBar as a person would. On each: a screenshot
 * (attached to the report, to compare with the Mobile designs), axe, and every control at least
 * 44px each way. The TabBar must not move while the app loads. Fictional data only.
 */

const ZONE = 'Australia/Melbourne';
const TODAY = today(ZONE);
const PHONES = ['iPhone 12', 'Pixel 7'] as const;
const THEMES = ['light', 'dark'] as const;

/** A device's screen, without its browser: the project's browser runs it (a describe can't switch browsers). */
function phone(name: (typeof PHONES)[number] | 'iPhone 12 landscape') {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name];
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
}

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** My matter with a client who has a mobile number, a deadline this week and a task due today. */
async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-larch',
    number: 'M-2026-0721',
    title: 'Estate of Winifred Larch',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, stageId: 'intake', openTaskCount: 1, clientContactIds: ['c-orla'] } },
    {
      path: `orgs/${orgId}/contacts/c-orla`,
      data: {
        kind: 'person',
        givenNames: 'Orla',
        familyName: 'Fictional',
        sortName: 'fictional orla',
        emails: [{ type: 'work', address: 'orla@example.test' }],
        phones: [{ type: 'mobile', number: '+61400000123' }],
        addresses: [],
        tags: [],
        isReferrer: false,
        search: contactSearchTokens({ givenNames: 'Orla', familyName: 'Fictional' }),
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `orgs/${orgId}/matters/m-larch/parties/${partyDocId('executor', 'c-orla')}`,
      data: {
        contactId: 'c-orla',
        role: 'executor',
        orgId,
        matterId: 'm-larch',
        addedFrom: 'manual',
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `orgs/${orgId}/matters/m-larch/deadlines/d-inventory`,
      data: {
        orgId,
        matterId: 'm-larch',
        title: 'Lodge the inventory of assets',
        dueDate: addDays(TODAY, 3),
        kind: 'internal',
        critical: false,
        status: 'upcoming',
        assigneeUid: uid,
        reminders: [],
        pastOnCreation: false,
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `orgs/${orgId}/matters/m-larch/tasks/t-bank`,
      data: {
        orgId,
        matterId: 'm-larch',
        title: 'Call the bank about the estate account',
        dueDate: TODAY,
        status: 'todo',
        priority: 'high',
        checklist: [],
        order: 1024,
        source: 'manual',
        countedOpen: true,
        assigneeUid: uid,
        deletedAt: null,
        ...meta(uid),
      },
    },
  ]);
}

/**
 * Records, from the first frame, where the TabBar sits and any layout shift inside it, so a test can
 * check it never moved while the app loaded. WebKit has no layout-shift entries; its frames still count.
 */
function watchTabBar(page: Page) {
  return page.addInitScript(() => {
    const seen: { rects: string[]; shift: number } = { rects: [], shift: 0 };
    (window as unknown as { __tabbar: typeof seen }).__tabbar = seen;
    if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number;
          sources?: { node?: Node | null }[];
        })[]) {
          const moved = entry.sources?.some((source) => {
            const node = source.node;
            const element = node instanceof Element ? node : node?.parentElement;
            return !!element?.closest('.mt-tabbar');
          });
          if (moved) seen.shift += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    }
    const started = performance.now();
    const frame = () => {
      const bar = document.querySelector('.mt-tabbar');
      if (bar) {
        const rect = bar.getBoundingClientRect();
        const at = `${Math.round(rect.top)},${Math.round(rect.height)},${Math.round(rect.width)}`;
        if (seen.rects.at(-1) !== at) seen.rects.push(at);
      }
      if (performance.now() - started < 5_000) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * Visible controls smaller than 44 × 44px. A control counts its label's box when it sits in one (a
 * checkbox in a row), and links inside running text are left out (WCAG 2.5.8's inline exception).
 */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]';
    const small: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue; // Not shown, or visually hidden.
      if (element.closest('[inert], [aria-hidden="true"]')) continue;
      if (element.matches('a') && style.display === 'inline' && element.closest('p, li > span, .mt-md')) continue;
      const label = element.closest('label');
      if (label) rect = label.getBoundingClientRect();
      if (rect.width + 0.5 >= 44 && rect.height + 0.5 >= 44) continue;
      const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ');
      const where =
        element.className && typeof element.className === 'string' ? `.${element.className.split(' ')[0]}` : '';
      small.push(
        `${element.tagName.toLowerCase()}${where} “${name.slice(0, 40)}” ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      );
    }
    return small;
  });
}

/** The screen's checks: a screenshot for the report, axe, and touch targets. */
async function check(page: Page, screen: string): Promise<void> {
  const path = test.info().outputPath(`${screen}.png`);
  await page.screenshot({ path });
  await test.info().attach(screen, { path, contentType: 'image/png' });
  await expectNoA11yViolations(page);
  // Soft, so one run lists every screen's small controls.
  expect.soft(await smallTargets(page), `controls under 44px on ${screen}`).toEqual([]);
}

for (const device of PHONES) {
  for (const theme of THEMES) {
    test.describe(`${device}, ${theme}`, () => {
      test.use({ ...phone(device), timezoneId: ZONE, colorScheme: theme });

      test('Today, Matters, a matter, Record and More', async ({ page, request }) => {
        test.setTimeout(180_000);
        const orgId = uniqueOrg();
        const account = await signInAsTestUser(page, request, {
          claims: { orgId, role: 'lawyer', orgName: 'Fictional Phone Practice' },
          displayName: 'Jordan Fictional',
        });
        await seed(request, orgId, account.uid);
        await page.addInitScript((value) => localStorage.setItem('mt-theme', value), theme);
        await watchTabBar(page);

        const tabs = page.locator('.mt-tabbar');
        await page.goto('/today');
        await expect(page.getByRole('heading', { level: 1, name: /, Jordan$/ })).toBeVisible(FIRST_LOAD);
        await expect(page.getByRole('region', { name: 'My tasks' })).toContainText(
          'Call the bank about the estate account',
          FIRST_LOAD,
        );
        await expect(tabs).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
        await check(page, 'today');

        // The TabBar was where it is now from its first frame.
        const bar = await page.evaluate(
          () => (window as unknown as { __tabbar: { rects: string[]; shift: number } }).__tabbar,
        );
        expect(bar.rects.length, `TabBar positions: ${bar.rects.join(' → ')}`).toBe(1);
        expect(bar.shift).toBe(0);

        await tabs.getByRole('link', { name: 'Matters' }).click();
        const matter = page.locator('[data-matter]').filter({ hasText: 'Estate of Winifred Larch' });
        await expect(matter).toBeVisible(FIRST_LOAD);
        await check(page, 'matters');

        await matter.click();
        await expect(page).toHaveURL(/\/matters\/m-larch\/overview$/);
        await expect(page.locator('[data-act="call"]')).toHaveAttribute('href', 'tel:+61400000123', FIRST_LOAD);
        await expect(page.locator('[data-section="deadlines"]')).toContainText('Lodge the inventory of assets');
        await check(page, 'matter');

        await tabs.getByRole('link', { name: 'Record' }).click();
        await expect(page).toHaveURL(/\/record$/);
        await expect(page.getByRole('heading', { level: 1, name: 'Record' })).toBeVisible();
        // The matter just opened is a chip to record against.
        await expect(page.locator('.mt-record .chips .mt-chip')).toContainText(['M-2026-0721'], FIRST_LOAD);
        // The raised Record button is the current tab, and its icon still shows on it.
        const fab = tabs.locator('.fab');
        const [icon, ground] = await fab.evaluate((el) => [
          getComputedStyle(el.querySelector('.mt-i') as Element).color,
          getComputedStyle(el).backgroundColor,
        ]);
        expect(icon).not.toBe(ground);
        await check(page, 'record');

        await tabs.getByRole('link', { name: 'More' }).click();
        await expect(page).toHaveURL(/\/more$/);
        await expect(page.locator('[data-more="settings"]')).toBeVisible();
        await check(page, 'more');
      });
    });
  }
}

test.describe('a small phone on its side', () => {
  // 750 × 340 once Safari's bars and the notch are taken off: still the phone layout, with very little height.
  test.use({ ...phone('iPhone 12 landscape'), timezoneId: ZONE });

  test('Today and a matter fit the screen', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Phone Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);
    const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

    await page.goto('/today');
    await expect(page.getByRole('region', { name: 'My tasks' })).toContainText(
      'Call the bank about the estate account',
      FIRST_LOAD,
    );
    expect(await sideways(page)).toBe(0);
    await check(page, 'today-landscape');

    await page.goto('/matters/m-larch/overview');
    await expect(page.locator('main')).toContainText('Lodge the inventory of assets', FIRST_LOAD);
    expect(await sideways(page)).toBe(0);
    await check(page, 'matter-landscape');
  });
});
