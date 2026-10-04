import { Component, signal } from '@angular/core';
import { provideRouter, RouterLink } from '@angular/router';
import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { expect, userEvent, within } from 'storybook/test';

import { MtBreadcrumb, MtNavItem, MtTabBar, type MtTabBarItem } from '../lib/nav/nav';
import { MT_TABS } from '../lib/tabs/tabs';

@Component({ template: '' })
class Blank {}

/** Tabs, router-linked tabs, sidebar nav, breadcrumb and the mobile tab bar. Fictional data only. */
@Component({
  selector: 'mt-navigation-demo',
  imports: [...MT_TABS, MtNavItem, MtBreadcrumb, MtTabBar, RouterLink],
  template: `
    <div class="mt-col" style="gap: 32px; max-width: 760px">
      <mt-breadcrumb
        [items]="[
          { label: 'Matters', link: '/matters' },
          { label: 'WE-142', link: '/matters', ref: true },
          { label: 'Deadlines' },
        ]"
      />

      <div mtTabset [(mtTabsetValue)]="tab">
        <div mtTabList aria-label="Matter sections">
          <button mtTab value="overview">Overview</button>
          <button mtTab value="deadlines" [count]="3">Deadlines</button>
          <button mtTab value="estate">Estate</button>
          <button mtTab value="documents" [count]="12">Documents</button>
          <button mtTab value="time" disabled>Time</button>
        </div>
        <div mtTabPanel value="overview" class="body t-2" style="padding-top: 12px">
          Key facts and the estate stepper.
        </div>
        <div mtTabPanel value="deadlines" class="body t-2" style="padding-top: 12px">
          Three deadlines due this month.
        </div>
        <div mtTabPanel value="estate" class="body t-2" style="padding-top: 12px">Assets and liabilities.</div>
        <div mtTabPanel value="documents" class="body t-2" style="padding-top: 12px">Twelve documents.</div>
      </div>

      <nav mtTabNav aria-label="Settings sections">
        <a mtTabLink routerLink="/today">Practice</a>
        <a mtTabLink routerLink="/matters">Team</a>
        <a mtTabLink routerLink="/inbox">Billing</a>
      </nav>

      <div class="mt-row" style="align-items: flex-start; gap: 32px">
        <nav class="mt-col" style="width: 240px; gap: 2px" aria-label="Workspace">
          <a mtNavItem routerLink="/today" icon="today" label="Today"></a>
          <a mtNavItem routerLink="/matters" icon="matters" label="Matters"></a>
          <a mtNavItem routerLink="/inbox" icon="inbox" label="Inbox" [count]="4"></a>
          <a mtNavItem routerLink="/clerk" dot="var(--bg-brand)" label="Estate of M. Whitfield"></a>
        </nav>
        <nav class="mt-col" style="width: 48px; gap: 2px" aria-label="Workspace, collapsed">
          <a mtNavItem routerLink="/today" icon="today" label="Today" collapsed></a>
          <a mtNavItem routerLink="/matters" icon="matters" label="Matters" collapsed></a>
          <a mtNavItem routerLink="/inbox" icon="inbox" label="Inbox" collapsed></a>
        </nav>
        <div style="width: 390px">
          <mt-tab-bar [items]="tabBar" />
        </div>
      </div>
    </div>
  `,
})
class NavigationDemo {
  protected readonly tab = signal('deadlines');
  protected readonly tabBar: MtTabBarItem[] = [
    { label: 'Today', icon: 'today', link: '/today' },
    { label: 'Matters', icon: 'matters', link: '/matters' },
    { label: 'Record', icon: 'mic', link: '/record', fab: true },
    { label: 'Clerk', icon: 'sparkle', link: '/clerk' },
    { label: 'Inbox', icon: 'inbox', link: '/inbox' },
  ];
}

const meta: Meta<NavigationDemo> = {
  title: 'Components/Navigation',
  component: NavigationDemo,
  decorators: [
    applicationConfig({
      providers: [
        provideRouter(
          ['today', 'matters', 'record', 'clerk', 'inbox']
            .map((path) => ({ path, component: Blank }))
            .concat([{ path: '**', component: Blank }]),
        ),
      ],
    }),
  ],
};
export default meta;
type Story = StoryObj<NavigationDemo>;

export const States: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const deadlines = canvas.getByRole('tab', { name: /Deadlines/ });
    await expect(deadlines).toHaveAttribute('aria-selected', 'true');
    deadlines.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('tab', { name: 'Estate' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(canvas.getByRole('tab', { name: /Documents/ })).toHaveFocus();
    // Navigate so the router-linked items show their active state.
    await userEvent.click(canvas.getAllByRole('link', { name: /Inbox/ })[0] as HTMLElement);
  },
};

export const StatesDark: Story = { ...States, globals: { theme: 'dark' } };
