import { expect, test, type Page } from '@playwright/test';

import { A11Y_THEMES, expectNoA11yViolationsInThemes, FIRST_LOAD, useTheme } from '@materia/test-utils/e2e';

import {
  DISPUTE,
  DISPUTE_TASK,
  MATTER,
  MATTER_NUMBER,
  MATTER_TITLE,
  ownContrast,
  pageOutline,
  PHONE,
  settled,
  sidewaysScroll,
  signInToAuditPractice,
  tabTo,
  ZONE,
} from './support/audit';

/**
 * The scripted parts of the WCAG 2.2 AA audit (SEC-06, docs/accessibility/audit-2026-10-07.md)
 * that run on every PR: the key screens in both themes, keyboard-only use with a visible focus and
 * no traps, landmarks and headings, reflow at 400% and 200% zoom, reduced motion, accessible
 * authentication, live regions, dragging alternatives, consistent help and target sizes. The
 * exhaustive every-route pass is a11y-audit.spec.ts (@audit, the morning run). Fictional data only.
 */

test.use({ timezoneId: ZONE });

const SERVER = { timeout: 45_000 };

/** Tabs through the page, expecting every stop to show focus, none hidden, and focus never stuck. */
async function expectKeyboardWalk(page: Page, stops: number): Promise<void> {
  const seen = new Set<string>();
  const problems: string[] = [];
  let previous = '';
  let stuck = 0;
  for (let i = 0; i < stops; i++) {
    const stop = await tabTo(page);
    if (stop.onBody) continue;
    if (!stop.indicated) problems.push(`no visible focus: ${stop.element}`);
    if (stop.obscured) problems.push(`covered: ${stop.element}`);
    stuck = stop.element === previous ? stuck + 1 : 0;
    if (stuck >= 2) problems.push(`focus stuck on ${stop.element}`);
    previous = stop.element;
    seen.add(stop.element);
  }
  expect(problems, 'keyboard focus problems').toEqual([]);
  // Focus moved through the page rather than circling a few controls.
  expect(seen.size).toBeGreaterThan(Math.min(8, stops / 3));
  // And Shift+Tab goes back the way it came.
  const back = await tabTo(page, true);
  expect(back.element).not.toBe(previous);
}

/** One main landmark, one level-1 heading, first; levels never skip on the way down (1.3.1, 2.4.6). */
async function expectStructure(page: Page, label: string): Promise<void> {
  const { headings, mains } = await pageOutline(page);
  expect(mains, `${label}: main landmarks`).toBe(1);
  expect(
    headings.filter(([level]) => level === 1),
    `${label}: level-1 headings`,
  ).toHaveLength(1);
  expect(headings[0]?.[0], `${label}: the first heading is the page's h1`).toBe(1);
  const skips = headings.flatMap(([level, text], i) => {
    const before = headings[i - 1]?.[0] ?? 1;
    return level > before + 1 ? [`h${before} → h${level} "${text}"`] : [];
  });
  expect(skips, `${label}: heading levels that skip`).toEqual([]);
}

test.describe('accessibility (WCAG 2.2 AA)', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop checks; the phone checks set their own viewport');

  test('the key screens have no violations in the light or the dark theme', async ({ page, request }) => {
    test.setTimeout(150_000);
    await page.goto('/auth/sign-in');
    await settled(page);
    await expectNoA11yViolationsInThemes(page);
    await signInToAuditPractice(page, request, 'owner');
    for (const url of ['/today', `/matters/${MATTER}/overview`, '/inbox', '/settings/profile']) {
      await page.goto(url);
      await settled(page);
      await expectNoA11yViolationsInThemes(page);
    }
  });

  test('sign-in, Today, a matter and Settings work by keyboard alone, with focus always visible', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    // Signed out: the skip link isn't there, the form is.
    await page.goto('/auth/sign-in');
    await settled(page);
    await expectKeyboardWalk(page, 6);

    await signInToAuditPractice(page, request, 'owner');
    // The first stop is "Skip to content", which moves focus to the page.
    await page.goto('/today');
    await settled(page);
    const skip = await tabTo(page);
    expect(skip.element).toContain('Skip to content');
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    await expectKeyboardWalk(page, 30);

    for (const url of [`/matters/${MATTER}/overview`, '/settings/profile']) {
      await page.goto(url);
      await settled(page);
      await expectKeyboardWalk(page, 30);
    }

    // Windows contrast themes (forced colours) drop box-shadows, so focus shows as an outline there.
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/today');
    await settled(page);
    await expectKeyboardWalk(page, 15);
    await page.emulateMedia({ forcedColors: 'none' });

    // A dialog keeps focus inside until Escape, then gives it back (no trap: Escape always leaves).
    await page.goto(`/matters/${MATTER}/deadlines`);
    await settled(page);
    const add = page.getByRole('button', { name: 'Add deadline' });
    await add.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
  });

  test('text axe can’t measure still meets 4.5:1 in both themes', async ({ page, request }) => {
    test.setTimeout(90_000);
    await signInToAuditPractice(page, request, 'owner');
    // Today's date in the deadline calendar: white on blue, hidden from screen readers (the cell
    // says the date), so axe skips it. White on brand-500 would be 4.47:1.
    await page.goto('/deadlines');
    await settled(page);
    await page.getByRole('group', { name: 'Deadlines view' }).getByText('Calendar').click();
    const today = page.locator('mt-deadline-calendar td[aria-current="date"] .num');
    for (const theme of A11Y_THEMES) {
      await useTheme(page, theme);
      expect(await ownContrast(today), `today's date, ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('pages have one main landmark, one h1 and headings in order', async ({ page, request }) => {
    test.setTimeout(150_000);
    for (const url of ['/auth/sign-in', '/auth/forgot-password']) {
      await page.goto(url);
      await settled(page);
      await expectStructure(page, url);
    }
    await signInToAuditPractice(page, request, 'owner');
    for (const url of [
      '/today',
      '/inbox',
      '/tasks',
      '/matters',
      '/deadlines',
      '/billing',
      `/matters/${MATTER}/overview`,
      `/matters/${MATTER}/tasks`,
      `/matters/${MATTER}/documents`,
      '/settings/profile',
      '/settings/team',
    ]) {
      await page.goto(url);
      await settled(page);
      await expectStructure(page, url);
    }
    // Landmarks are named: the sidebar's navigation and the page.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('content reflows at 400% zoom (320 px) and 200% zoom (640 px) without scrolling sideways', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const check = async (url: string) => {
      for (const width of [640, 320]) {
        // 1280 × 1024 at 200% and at 400%.
        await page.setViewportSize({ width, height: width * 0.8 });
        await page.goto(url);
        await settled(page);
        expect(await sidewaysScroll(page), `${url} at ${width} px`).toEqual({ overflow: 0, culprits: [] });
      }
    };
    await check('/auth/sign-in');
    await signInToAuditPractice(page, request, 'owner');
    // Data tables scroll inside their own container (allowed by 1.4.10); the page itself never does.
    for (const url of ['/today', '/matters', `/matters/${MATTER}/overview`, '/deadlines', '/settings/profile']) {
      await check(url);
    }
  });

  test('reduced motion stops the motion', async ({ page, request }) => {
    test.setTimeout(90_000);
    await signInToAuditPractice(page, request, 'owner');
    const arrival = () =>
      page.evaluate(() => {
        const routed = document.querySelector('.mt-page router-outlet + *');
        const style = routed ? getComputedStyle(routed) : null;
        return style ? { name: style.animationName, seconds: parseFloat(style.animationDuration) } : null;
      });
    // With motion allowed, a page rises in (the brand book's motion-slow, 200 ms).
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/inbox');
    await settled(page);
    expect(await arrival()).toEqual({ name: 'mt-rise-in', seconds: 0.2 });
    // With reduced motion, the same animation is instant, and so are transitions (dialogs, menus).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/today');
    await settled(page);
    expect((await arrival())?.seconds).toBeLessThan(0.001);
    await page.getByRole('button', { name: /Account menu/ }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const longest = await menu.evaluate((el) => {
      const style = getComputedStyle(el);
      return Math.max(
        ...[style.transitionDuration, style.animationDuration].flatMap((v) => v.split(',').map(parseFloat)),
      );
    });
    expect(longest).toBeLessThan(0.001);
  });

  test('sign-in and two-step codes allow paste and autofill, with no puzzle to solve', async ({ page }) => {
    const pasteAllowed = (selector: string) =>
      page.locator(selector).evaluate((input: HTMLInputElement) => {
        const data = new DataTransfer();
        data.setData('text/plain', '123 456');
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return !event.defaultPrevented && !input.readOnly && input.getAttribute('onpaste') === null;
      });
    await page.goto('/auth/sign-in');
    const email = page.getByLabel('Work email');
    await expect(email).toHaveAttribute('autocomplete', 'username');
    await expect(email).toHaveAttribute('type', 'email');
    await email.fill('someone@example.test');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const password = page.getByLabel('Password');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(await pasteAllowed('input[type="password"]')).toBe(true);
    // No CAPTCHA or other cognitive test anywhere in the sign-in.
    await expect(page.locator('iframe, [class*="captcha" i]')).toHaveCount(0);

    await page.goto('/auth/sign-up');
    await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'new-password');
    await expect(page.getByLabel('Full name')).toHaveAttribute('autocomplete', 'name');

    await page.goto('/auth/mfa');
    const code = page.getByLabel('6-digit code');
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(await code.getAttribute('maxlength')).toBeNull();
    expect(await pasteAllowed('input[autocomplete="one-time-code"]')).toBe(true);
    // A pasted code with a space in the middle is accepted as typed.
    await code.fill('123 456');
    await expect(code).toHaveValue('123 456');

    await page.goto('/auth/recover');
    const recovery = page.locator('mt-text-field input').nth(1);
    expect(await recovery.getAttribute('maxlength')).toBeNull();
    expect(await pasteAllowed('mt-text-field:nth-of-type(2) input')).toBe(true);
  });

  test('toasts and Clerk speak politely: a finished answer once, never token by token', async ({ page, request }) => {
    test.setTimeout(150_000);
    await signInToAuditPractice(page, request, 'owner');
    // A toast reaches screen readers through the polite region (danger ones through the assertive one).
    // The contested estate's task: the probate matter's tasks are another test's (the practice is shared).
    await page.goto(`/matters/${DISPUTE}/tasks`);
    await settled(page);
    // The toast outlet's own polite region (the shell has other live regions).
    const polite = page.locator('mt-toast-outlet > [aria-live="polite"]');
    await page.getByRole('checkbox', { name: `Done: ${DISPUTE_TASK}` }).click();
    await expect(page.locator('.mt-toaster')).toContainText('Task done', SERVER);
    await expect(polite).toContainText('Task done');
    await expect(page.locator('.mt-toaster')).not.toHaveAttribute('aria-live', /.+/);

    // Clerk: the conversation isn't a live region; the streaming answer is busy; the finished
    // answer is announced once by the panel's status line.
    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(MATTER_TITLE, FIRST_LOAD);
    await page.keyboard.press('Control+j');
    const panel = page.getByRole('complementary', { name: 'Clerk' });
    await expect(panel.getByText(`Asking about ${MATTER_NUMBER}`)).toBeVisible(SERVER);
    const log = panel.getByRole('log', { name: 'Conversation with Clerk' });
    await expect(log).toHaveAttribute('aria-live', 'off');
    const announcement = panel.locator('[data-clerk-announcement]');
    await expect(announcement).toHaveAttribute('role', 'status');
    const composer = panel.getByRole('textbox', { name: 'Ask Clerk' });
    await composer.fill('[fake:slow] Tell me everything.');
    await composer.press('Control+Enter');
    const answer = panel.getByRole('article', { name: 'Clerk' }).last();
    await expect(answer).toContainText('word1', SERVER);
    await expect(answer).toHaveAttribute('aria-busy', 'true');
    await expect(announcement).toHaveText('');
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(announcement).toHaveText('Clerk stopped. This answer is incomplete.', SERVER);
    await expect(answer).not.toHaveAttribute('aria-busy', 'true');

    await composer.fill('[fake:tools] Who is the executor?');
    await composer.press('Control+Enter');
    await expect(announcement).toHaveText(/^Clerk answered: .*Fake Clerk reply after checking the matter\.$/, SERVER);
  });

  test('moving a card or a task never needs a drag', async ({ page, request }) => {
    test.setTimeout(150_000);
    await signInToAuditPractice(page, request, 'owner');
    // The board: each card's "Move to…" button (a single click) offers the columns and Move up/down.
    await page.goto('/matters/board');
    await settled(page);
    const card = page.locator('.card', { hasText: MATTER_TITLE });
    await card.hover();
    await card.getByRole('button', { name: `Move ${MATTER_NUMBER} to… (M)` }).click();
    const menu = page.getByRole('menu', { name: `Move ${MATTER_NUMBER} to` });
    await expect(menu.getByRole('menuitem', { name: 'On hold' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Move (up|down)$/ })).toHaveCount(2);
    await menu.getByRole('menuitem', { name: 'On hold' }).click();
    await expect(page.getByText(`Moved ${MATTER_NUMBER} to On hold`, { exact: false })).toBeAttached(SERVER);

    // Tasks: their details have Move up and Move down, beside the drag handle and Alt+↑/↓.
    await page.goto(`/matters/${MATTER}/tasks`);
    await settled(page);
    const titles = () => page.locator('mt-task-list .mt-task-title').allTextContents();
    await expect
      .poll(async () => (await titles()).map((t) => t.trim()))
      .toEqual(['Lodge the inventory of assets', 'Call the executor about the bank accounts']);
    await page.getByRole('button', { name: 'Details: Lodge the inventory of assets' }).click();
    const down = page.getByRole('button', { name: 'Move down: Lodge the inventory of assets' });
    await down.click();
    await expect
      .poll(async () => (await titles()).map((t) => t.trim()), SERVER)
      .toEqual(['Call the executor about the bank accounts', 'Lodge the inventory of assets']);
    await expect(down).toBeFocused();
  });

  test('help is in the same place on every page', async ({ page, request }) => {
    test.setTimeout(120_000);
    await signInToAuditPractice(page, request, 'owner');
    const menus: string[][] = [];
    for (const url of ['/today', `/matters/${MATTER}/overview`, '/settings/team']) {
      await page.goto(url);
      await settled(page);
      await page.getByRole('button', { name: /Account menu/ }).click();
      const items = await page.getByRole('menu').getByRole('menuitem').allTextContents();
      menus.push(items.map((item) => item.replace(/\s+/g, ' ').trim()));
      await page.keyboard.press('Escape');
      // Clerk's guide is at the foot of its panel wherever it opens.
      await page.keyboard.press('Control+j');
      const panel = page.getByRole('complementary', { name: 'Clerk' });
      await expect(panel.locator('footer').getByRole('link', { name: 'How Clerk works' })).toBeVisible();
      await page.keyboard.press('Control+j');
      await expect(panel).toBeHidden();
    }
    expect(menus[0]?.some((item) => item.startsWith('Keyboard shortcuts'))).toBe(true);
    expect(menus[1]).toEqual(menus[0]);
    expect(menus[2]).toEqual(menus[0]);
  });
});

test.describe('accessibility at phone width (WCAG 2.2 AA)', () => {
  test.use(PHONE);

  test('Today and Record have no violations in either theme, and the TabBar is legible with 44 px targets', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await signInToAuditPractice(page, request, 'lawyer');
    await settled(page);
    await expectNoA11yViolationsInThemes(page);
    // The Inbox's unread count sits over its icon, where axe can't measure it: white on brand-600.
    expect(await ownContrast(page.locator('.mt-app-tabbar .mt-nav-count'))).toBeGreaterThanOrEqual(4.5);
    const tabs = page.locator('.mt-app-tabbar a');
    await expect(tabs).toHaveCount(5);
    for (const box of await tabs.evaluateAll((links) => links.map((a) => a.getBoundingClientRect().toJSON()))) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // Record (the TabBar's middle button) opens Time & billing until MOB-03 builds the Record screen.
    await page.locator('.mt-app-tabbar').getByRole('link', { name: 'Record' }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await settled(page);
    await expectNoA11yViolationsInThemes(page);
    expect(await sidewaysScroll(page)).toEqual({ overflow: 0, culprits: [] });
  });
});
