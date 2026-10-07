import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { myDevicesRepository, orgSettingsReadRepository, type DeviceItem } from '@materia/data-access/repository';
import {
  DEFAULT_ORG_TIMEZONE,
  DEFAULT_QUIET_HOURS,
  DEFAULT_TASK_REMINDER_DAYS,
  TASK_REMINDER_DAYS_MAX,
  timeZoneOptions,
  today,
  toDisplay,
  WEEKLY_REPORT_ROLES,
  type DensityPref,
  type NotificationPrefs,
  type StartPage,
  type ThemePref,
  type UserPrefs,
} from '@materia/domain';
import {
  MtButton,
  MtKbd,
  MtNote,
  type MtOption,
  MtSegmentedControl,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSkeleton,
  MtSwitch,
  ToastService,
} from '@materia/ui';

import { NotificationMatrix } from './notification-matrix';
import { errorCopy } from '../../core/error-copy';
import { UserPrefsService } from '../../core/profile/user-prefs';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { TourService, WELCOME_TOUR_ID } from '../../core/tours/tour-service';

const THEMES: MtOption<ThemePref>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const DENSITIES: MtOption<DensityPref>[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];
const START_PAGES: MtOption<StartPage>[] = [
  { value: 'today', label: 'Today' },
  { value: 'matters', label: 'Matters' },
];

/** `7:00 am` for 7. */
function hourLabel(hour: number, minute = 0): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

const HOURS: MtOption<number>[] = Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: hourLabel(hour) }));
const HALF_HOURS: MtOption<string>[] = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = (i % 2) * 30;
  return { value: `${String(hour).padStart(2, '0')}:${minute ? '30' : '00'}`, label: hourLabel(hour, minute) };
});

/** How long before a task is due its reminder goes out: on the day, or 1 to 14 days before. */
const TASK_REMINDER_DAYS: MtOption<number>[] = Array.from({ length: TASK_REMINDER_DAYS_MAX + 1 }, (_, days) => ({
  value: days,
  label: days === 0 ? 'On the day they’re due' : `${days} ${days === 1 ? 'day' : 'days'} before they’re due`,
}));

const PLATFORMS: Record<DeviceItem['platform'], string> = {
  web: 'Web browser',
  ios: 'iPhone or iPad',
  android: 'Android',
};

/**
 * Settings → Preferences (`/settings/preferences`, CORE-20; everyone): appearance, the start page,
 * guided tours (CORE-24),
 * notifications (kinds × channels, how early task reminders come (CORE-11), quiet hours, the daily
 * digest and the time zone they follow),
 * the keyboard shortcuts and the devices that get push notifications. Every change saves at once
 * to `users/{uid}.prefs` (client-direct, so it queues offline) and applies in every open tab.
 */
@Component({
  selector: 'mt-preferences-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MtButton,
    MtKbd,
    MtNote,
    MtSegmentedControl,
    MtSelect,
    MtSettingsRow,
    MtSettingsSection,
    MtSkeleton,
    MtSwitch,
    NotificationMatrix,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Preferences</h1>
      <p style="margin: 0; color: var(--text-secondary)">Yours alone. Changes save as you make them.</p>
    </div>

    @if (userPrefs.profile.status() === 'error') {
      <mt-note tone="danger">Couldn’t load your preferences. Check your connection and reload.</mt-note>
    }

    <mt-settings-section title="Appearance" [headingLevel]="2">
      <mt-settings-row title="Theme" description="System follows your computer’s light or dark setting.">
        <mt-segmented-control
          name="theme"
          label="Theme"
          [options]="themes"
          [ngModel]="prefs().theme"
          (ngModelChange)="save({ theme: $event })"
        />
      </mt-settings-row>
      <mt-settings-row title="Density" description="Compact fits more rows in tables.">
        <mt-segmented-control
          name="density"
          label="Density"
          [options]="densities"
          [ngModel]="prefs().density"
          (ngModelChange)="save({ density: $event })"
        />
      </mt-settings-row>
      <mt-settings-row title="Start page" description="Where Materia opens.">
        <mt-segmented-control
          name="startPage"
          label="Start page"
          [options]="startPages"
          [ngModel]="prefs().startPage"
          (ngModelChange)="save({ startPage: $event })"
        />
      </mt-settings-row>
      <mt-settings-row title="Dates" description="Australian format, in the practice’s time zone.">
        <span data-date-preview style="color: var(--text-secondary)">{{ datePreview() }}</span>
      </mt-settings-row>
    </mt-settings-section>

    <!-- Guided tours (CORE-24). -->
    @if (tours.enabled()) {
      <mt-settings-section
        title="Guided tours"
        description="A spotlight on each feature with a short explanation. Start one any time with Shift+H, or “Tour this page” in search."
        [headingLevel]="2"
        data-tour="tours-settings"
      >
        <mt-settings-row title="Page tours" description="Play a page’s tour the first time you open it.">
          <mt-switch
            name="pageTours"
            label="Page tours"
            labelHidden
            [ngModel]="tours.prefs().auto"
            (ngModelChange)="setPageTours($event)"
          />
        </mt-settings-row>
        <mt-settings-row
          title="Welcome tour"
          description="Where things live: your pages, search, the timer, Clerk and Settings."
        >
          <button mtButton size="sm" variant="secondary" type="button" data-tour-welcome (click)="takeWelcomeTour()">
            Take it again
          </button>
        </mt-settings-row>
        <mt-settings-row title="Seen them already?" description="Play each page’s tour again as you next open it.">
          <button mtButton size="sm" variant="ghost" type="button" data-tour-replay (click)="replayPageTours()">
            Replay page tours
          </button>
        </mt-settings-row>
      </mt-settings-section>
    }

    <mt-settings-section
      title="Notifications"
      description="Email and push wait for quiet hours to end, except deadline escalations."
      [headingLevel]="2"
    >
      <mt-settings-row title="Email" description="Turn off to get only deadline escalations by email.">
        <mt-switch
          name="email"
          label="Email notifications"
          labelHidden
          [ngModel]="notifications().email"
          (ngModelChange)="saveNotifications({ email: $event })"
        />
      </mt-settings-row>
      <mt-settings-row title="Push" description="On the devices listed below.">
        <mt-switch
          name="push"
          label="Push notifications"
          labelHidden
          [ngModel]="notifications().push"
          (ngModelChange)="saveNotifications({ push: $event })"
        />
      </mt-settings-row>
      <mt-notification-matrix [prefs]="notifications()" (changed)="saveNotifications($event)" />
      <mt-select
        name="taskReminderDays"
        label="Remind me about tasks"
        description="At 8:00 am in the practice’s time zone. A reminder that would fall on a weekend or public holiday comes the business day before."
        [native]="true"
        [options]="taskReminderDays"
        [ngModel]="notifications().taskReminderDays ?? defaultTaskReminderDays"
        (ngModelChange)="saveNotifications({ taskReminderDays: +$event })"
      />

      <mt-settings-row title="Quiet hours" description="No email or push between these times.">
        <mt-switch
          name="quiet"
          label="Quiet hours"
          labelHidden
          [ngModel]="quietHours() !== null"
          (ngModelChange)="saveNotifications({ quietHours: $event ? defaultQuietHours : null })"
        />
      </mt-settings-row>
      @if (quietHours(); as quiet) {
        <div class="mt-row" style="gap: 12px; flex-wrap: wrap">
          <mt-select
            style="flex: 1; min-width: 160px"
            name="quietStart"
            label="Quiet from"
            [native]="true"
            [options]="halfHours"
            [ngModel]="quiet.start"
            (ngModelChange)="saveNotifications({ quietHours: { start: $event, end: quiet.end } })"
          />
          <mt-select
            style="flex: 1; min-width: 160px"
            name="quietEnd"
            label="Until"
            [native]="true"
            [options]="halfHours"
            [ngModel]="quiet.end"
            (ngModelChange)="saveNotifications({ quietHours: { start: quiet.start, end: $event } })"
          />
        </div>
      }

      <mt-settings-row title="Daily digest" description="One email with what’s due and what you missed.">
        <mt-switch
          name="digest"
          label="Daily digest"
          labelHidden
          [ngModel]="notifications().digest !== false"
          (ngModelChange)="saveNotifications({ digest: $event })"
        />
      </mt-settings-row>
      @if (notifications().digest !== false) {
        <mt-select
          name="digestHour"
          label="Send the digest at"
          [native]="true"
          [options]="hours"
          [ngModel]="notifications().digestHour"
          (ngModelChange)="saveNotifications({ digestHour: +$event })"
        />
      }
      @if (reportOptIn()) {
        <mt-settings-row
          title="Weekly practice report"
          description="Mondays at 7am, the practice’s time: last week’s figures, the matters with the most work in progress and how many critical deadlines are due."
        >
          <mt-switch
            name="weeklyReport"
            label="Weekly practice report"
            labelHidden
            [ngModel]="notifications().weeklyReport === true"
            (ngModelChange)="saveNotifications({ weeklyReport: $event })"
          />
        </mt-settings-row>
      }
      <mt-select
        name="timezone"
        label="Time zone"
        description="Quiet hours and the digest follow it."
        [native]="true"
        [options]="timeZones()"
        [ngModel]="prefs().timezone ?? ''"
        (ngModelChange)="saveTimezone($event)"
      />
    </mt-settings-section>

    <mt-settings-section title="Keyboard shortcuts" description="Press ? anywhere to see them." [headingLevel]="2">
      @for (group of shortcutGroups(); track group.name) {
        <div class="mt-col" style="gap: 6px">
          <h3 class="shortcut-group">{{ group.name }}</h3>
          <dl class="shortcuts">
            @for (shortcut of group.items; track shortcut.combo) {
              <div>
                <dt>{{ shortcut.description }}</dt>
                <dd><mt-kbd [keys]="shortcut.combo" /></dd>
              </div>
            }
          </dl>
        </div>
      }
    </mt-settings-section>

    <mt-settings-section
      title="Devices"
      description="Where you get push notifications. Signing a device out here stops its pushes."
      [headingLevel]="2"
    >
      @switch (devices.status()) {
        @case ('loading') {
          <mt-skeleton variant="fields" framed label="Loading devices…" [count]="2" />
        }
        @case ('error') {
          <mt-note tone="danger">Couldn’t load your devices.</mt-note>
        }
        @default {
          @for (device of devices.value(); track device.id) {
            <mt-settings-row [title]="platform(device)" [description]="'Last seen ' + lastSeen(device)">
              <button mtButton size="sm" variant="ghost" type="button" (click)="signOutDevice(device)">
                Sign out of this device
              </button>
            </mt-settings-row>
          } @empty {
            <p style="margin: 0; color: var(--text-tertiary)">No devices get push notifications yet.</p>
          }
        }
      }
    </mt-settings-section>
  `,
  styles: `
    .shortcut-group {
      margin: 0;
      font: 600 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .shortcuts {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .shortcuts > div {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font: 400 13px/18px var(--font-sans);
    }
    .shortcuts dd {
      margin: 0;
    }
  `,
})
export class PreferencesPage {
  protected readonly userPrefs = inject(UserPrefsService);
  private readonly context = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly shortcuts = inject(ShortcutService);
  /** Guided tours (CORE-24). */
  protected readonly tours = inject(TourService);
  private readonly org = orgSettingsReadRepository().watch(() => this.context.orgId());
  private readonly deviceRepo = myDevicesRepository();
  protected readonly devices = this.deviceRepo.watchQuery({ orderBy: [['lastSeenAt', 'desc']], pageSize: 20 });

  protected readonly themes = THEMES;
  protected readonly densities = DENSITIES;
  protected readonly startPages = START_PAGES;
  protected readonly hours = HOURS;
  protected readonly halfHours = HALF_HOURS;
  protected readonly defaultQuietHours = DEFAULT_QUIET_HOURS;
  protected readonly taskReminderDays = TASK_REMINDER_DAYS;
  protected readonly defaultTaskReminderDays = DEFAULT_TASK_REMINDER_DAYS;

  protected readonly prefs = this.userPrefs.prefs;
  protected readonly notifications = computed(() => this.prefs().notifications);
  /** Quiet hours, or null when off (absent means the default 19:00–07:00). */
  protected readonly quietHours = computed(() => {
    const quiet = this.notifications().quietHours;
    return quiet === undefined ? DEFAULT_QUIET_HOURS : quiet;
  });
  /** Owners and admins may have the weekly practice report (INS-03). */
  protected readonly reportOptIn = computed(() => {
    const role = this.context.role();
    return !!role && WEEKLY_REPORT_ROLES.includes(role);
  });
  private readonly orgZone = computed(() => this.org.value()?.timezone || DEFAULT_ORG_TIMEZONE);
  protected readonly timeZones = computed<MtOption<string>[]>(() => [
    { value: '', label: `The practice’s (${this.orgZone().replace(/_/g, ' ')})` },
    ...timeZoneOptions().map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') })),
  ]);
  protected readonly datePreview = computed(() => {
    const zone = this.orgZone();
    const time = new Date().toLocaleTimeString('en-AU', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
    return `${toDisplay(today(zone))}, ${time}`;
  });
  protected readonly shortcutGroups = computed(() => {
    const byGroup = new Map<string, ReturnType<ShortcutService['list']>>();
    for (const s of this.shortcuts.list()) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
    return [...byGroup].map(([name, items]) => ({ name, items }));
  });

  protected save(patch: Partial<UserPrefs>): void {
    this.userPrefs.save(patch).catch((error: unknown) => this.failed(error));
  }

  protected setPageTours(auto: boolean): void {
    void this.tours.setAuto(auto);
  }

  protected takeWelcomeTour(): void {
    void this.tours.start(WELCOME_TOUR_ID);
  }

  protected async replayPageTours(): Promise<void> {
    await this.tours.resetPageTours();
    this.toasts.show({ title: 'Page tours will play as you open each page', tone: 'success' });
  }

  protected saveNotifications(patch: Partial<NotificationPrefs>): void {
    this.save({ notifications: { ...this.notifications(), ...patch } });
  }

  protected saveTimezone(zone: string | null): void {
    this.userPrefs
      .save({}, zone ? { timezone: zone } : { clearTimezone: true })
      .catch((error: unknown) => this.failed(error));
  }

  protected platform(device: DeviceItem): string {
    return PLATFORMS[device.platform] ?? 'Device';
  }

  protected lastSeen(device: DeviceItem): string {
    const at = device.lastSeenAt as unknown as Date;
    return at instanceof Date ? at.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
  }

  protected async signOutDevice(device: DeviceItem & { id: string }): Promise<void> {
    try {
      await this.deviceRepo.hardDelete(device.id);
      this.toasts.show({ title: 'Device signed out of push notifications', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The device wasn’t signed out', description: errorCopy(error), tone: 'danger' });
    }
  }

  private failed(error: unknown): void {
    this.toasts.show({ title: 'Your preference didn’t save', description: errorCopy(error), tone: 'danger' });
  }
}
