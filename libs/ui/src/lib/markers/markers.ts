import { ChangeDetectionStrategy, Component, computed, input, signal, ViewEncapsulation } from '@angular/core';

import type { MatterType, Priority } from '@materia/domain';

import type { MtStatusKind } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { MtTooltip } from '../tooltip/tooltip';

export type MtBadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'ai';

/** Badge (`mt-badge`): a short status label with a tone dot ("Grant issued", "Awaiting client"). */
@Component({
  selector: 'mt-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/badge.css',
  imports: [MtIcon],
  host: { class: 'mt-badge', '[attr.data-tone]': 'tone() === "neutral" ? null : tone()' },
  template: `
    @if (tone() === 'ai') {
      <mt-icon name="sparkle" />
    }
    <ng-content />
  `,
})
export class MtBadge {
  readonly tone = input<MtBadgeTone>('neutral');
}

/** Labels for the eight matter types, as the design system names them. */
export const MATTER_TYPE_LABELS: Readonly<Record<MatterType, string>> = {
  will: 'Will',
  poa: 'Power of attorney',
  probate: 'Probate',
  loa: 'Letters of admin',
  admin: 'Estate admin',
  fp: 'Family provision',
  contest: 'Will dispute',
  trust: 'Testamentary trust',
};

/** MatterTag (`mt-matter-tag`): the matter type with its colour square (the `matter-*` tokens). */
@Component({
  selector: 'mt-matter-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/tag.css',
  host: { class: 'mt-tag', '[attr.data-type]': 'type()' },
  template: `{{ label() }}`,
})
export class MtMatterTag {
  readonly type = input.required<MatterType>();
  protected readonly label = computed(() => MATTER_TYPE_LABELS[this.type()]);
}

export type MtAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Up to two initials from a name ("Catherine Whitfield" → "CW"). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * A stable colour (1–4) for a person, so two people with the same initials still look different.
 * Derived from their id (or name), never random.
 */
export function avatarHue(key: string): 1 | 2 | 3 | 4 {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ((hash % 4) + 1) as 1 | 2 | 3 | 4;
}

/**
 * Avatar (`mt-avatar`): a photo, or initials on a stable colour when there's no image or it fails to
 * load. The name is the accessible label and, with `tooltip`, shows on hover. `kind="clerk"` shows the
 * Clerk mark; `kind="org"` a square org badge.
 */
@Component({
  selector: 'mt-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/avatar.css',
  imports: [MtIcon],
  hostDirectives: [{ directive: MtTooltip, inputs: ['mtTooltip: name', 'mtTooltipDisabled: tooltipDisabled'] }],
  host: {
    class: 'mt-avatar',
    role: 'img',
    '[attr.aria-label]': 'name()',
    '[attr.data-size]': 'size() === "md" ? null : size()',
    '[attr.data-kind]': 'kind() === "person" ? null : kind()',
    '[attr.data-hue]': 'hueAttr()',
    '[attr.tabindex]': 'tooltip() ? 0 : null',
  },
  template: `
    @if (kind() === 'clerk') {
      <mt-icon name="sparkle" />
    } @else if (src() && !failed()) {
      <img [src]="src()" alt="" (error)="failed.set(true)" />
    } @else {
      <span aria-hidden="true">{{ initials() }}</span>
    }
  `,
})
export class MtAvatar {
  readonly name = input.required<string>();
  readonly src = input<string | null>();
  readonly size = input<MtAvatarSize>('md');
  readonly kind = input<'person' | 'clerk' | 'org'>('person');
  /** A stable key for the colour, such as the user id; defaults to the name. */
  readonly colorKey = input<string>();
  /** `risk` marks a person flagged in the conflict check. */
  readonly hue = input<1 | 2 | 3 | 4 | 'risk'>();
  /** Show the name in a tooltip (and make the avatar focusable for keyboard users). */
  readonly tooltip = input(false);

  protected readonly failed = signal(false);
  protected readonly initials = computed(() => initialsOf(this.name()));
  protected readonly tooltipDisabled = computed(() => !this.tooltip());
  protected readonly hueAttr = computed(() => {
    const hue = this.hue() ?? avatarHue(this.colorKey() ?? this.name());
    return hue === 1 ? null : String(hue);
  });
}

/** A person shown in an AvatarGroup. */
export interface MtAvatarPerson {
  name: string;
  src?: string | null;
  id?: string;
}

/** AvatarGroup (`mt-avatar-group`): overlapping avatars, collapsing extras into "+N". */
@Component({
  selector: 'mt-avatar-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/avatars.css', '../../generated/components/avatar.css'],
  imports: [MtAvatar],
  host: { class: 'mt-avatars', role: 'group', '[attr.aria-label]': 'label()' },
  template: `
    @for (person of shown(); track person.id ?? person.name) {
      <mt-avatar
        [name]="person.name"
        [src]="person.src ?? null"
        [colorKey]="person.id ?? person.name"
        [size]="size()"
        [tooltip]="true"
      />
    }
    @if (extra() > 0) {
      <span
        class="mt-avatar"
        [attr.data-size]="size() === 'md' ? null : size()"
        role="img"
        [attr.aria-label]="extra() + ' more'"
      >
        +{{ extra() }}
      </span>
    }
  `,
})
export class MtAvatarGroup {
  readonly people = input.required<readonly MtAvatarPerson[]>();
  readonly max = input(3);
  readonly size = input<MtAvatarSize>('md');
  protected readonly shown = computed(() => this.people().slice(0, this.max()));
  protected readonly extra = computed(() => Math.max(0, this.people().length - this.max()));
  protected readonly label = computed(() =>
    this.people()
      .map((p) => p.name)
      .join(', '),
  );
}

/** StatusIcon (`mt-status-icon`): the stage glyph (draft, active, review, done, blocked). */
@Component({
  selector: 'mt-status-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/status.css',
  host: { style: 'display: contents' },
  template: `
    <svg
      class="mt-status"
      viewBox="0 0 14 14"
      role="img"
      [attr.data-status]="status()"
      [attr.aria-label]="label() ?? status()"
    >
      @switch (status()) {
        @case ('draft') {
          <svg:circle class="ring" cx="7" cy="7" r="6" stroke="currentColor" stroke-dasharray="1.8 1.9" />
        }
        @case ('active') {
          <svg:circle class="ring" cx="7" cy="7" r="6" stroke="currentColor" />
          <svg:circle
            class="pie"
            cx="7"
            cy="7"
            r="2.5"
            stroke="currentColor"
            stroke-dasharray="7.85 15.708"
            transform="rotate(-90 7 7)"
          />
        }
        @case ('review') {
          <svg:circle class="ring" cx="7" cy="7" r="6" stroke="currentColor" />
          <svg:circle
            class="pie"
            cx="7"
            cy="7"
            r="2.5"
            stroke="currentColor"
            stroke-dasharray="11.78 15.708"
            transform="rotate(-90 7 7)"
          />
        }
        @case ('done') {
          <svg:circle cx="7" cy="7" r="7" fill="currentColor" />
          <svg:path
            d="M4.4 7.2 6.2 9l3.4-3.6"
            fill="none"
            stroke="var(--bg-surface)"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        }
        @case ('blocked') {
          <svg:circle cx="7" cy="7" r="7" fill="currentColor" />
          <svg:path d="M4.5 7h5" stroke="var(--bg-surface)" stroke-width="1.6" stroke-linecap="round" />
        }
      }
    </svg>
  `,
})
export class MtStatusIcon {
  readonly status = input.required<MtStatusKind>();
  /** Accessible name, such as the stage ("Notice period"); defaults to the status. */
  readonly label = input<string>();
}

const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'No priority',
  low: 'Low priority',
  medium: 'Medium priority',
  high: 'High priority',
  urgent: 'Urgent priority',
};

/** PriorityIcon (`mt-priority-icon`): three bars, or a red "!" for urgent. */
@Component({
  selector: 'mt-priority-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/priority.css',
  host: { class: 'mt-priority', role: 'img', '[attr.data-level]': 'level()', '[attr.aria-label]': 'label()' },
  template: `<i></i><i></i><i></i>`,
})
export class MtPriorityIcon {
  readonly level = input.required<Priority>();
  protected readonly label = computed(() => PRIORITY_LABELS[this.level()]);
}
