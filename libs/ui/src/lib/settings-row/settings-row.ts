import { booleanAttribute, ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';

import { MtIcon } from '../icon/icon';

let nextId = 0;

/**
 * SettingsSection (`mt-settings-section`): a titled group of SettingsRows ("What Clerk can read").
 */
@Component({
  selector: 'mt-settings-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/settings.css',
  // `title` is also a native attribute: drop it from the host so the browser doesn't show it as a
  // tooltip over everything in the section.
  host: { class: 'mt-settings-section', role: 'group', '[attr.aria-labelledby]': 'id', '[attr.title]': 'null' },
  // The design's sections hold only SettingsRows, which join into one bordered list. Pages also put
  // fields, notes and buttons in them: those sit 12px apart (a gap, so a child's own `margin: 0`
  // can't undo it), 4px under the title and 8px under the description.
  styles: `
    .mt-settings-section {
      gap: var(--space-12);
    }
    .mt-settings-section > h3:first-child {
      margin-bottom: calc(var(--space-4) - var(--space-12));
    }
    .mt-settings-section > h3:first-child + p {
      margin-bottom: calc(var(--space-8) - var(--space-12));
    }
    .mt-settings-section > .mt-setting + .mt-setting {
      margin-top: calc(-1 * var(--space-12));
    }
    /* A run of rows between other content still has rounded ends. */
    .mt-settings-section > :not(.mt-setting) + .mt-setting {
      border-start-start-radius: var(--radius-lg);
      border-start-end-radius: var(--radius-lg);
    }
    .mt-settings-section > .mt-setting:not(:has(+ .mt-setting)) {
      border-end-start-radius: var(--radius-lg);
      border-end-end-radius: var(--radius-lg);
    }
  `,
  template: `
    <h3
      [id]="id"
      [attr.role]="headingLevel() === 3 ? null : 'heading'"
      [attr.aria-level]="headingLevel() === 3 ? null : headingLevel()"
    >
      {{ title() }}
    </h3>
    @if (description(); as text) {
      <p>{{ text }}</p>
    }
    <ng-content />
  `,
})
export class MtSettingsSection {
  readonly title = input.required<string>();
  readonly description = input<string>();
  /** Heading level for the title within the page outline (default 3). */
  readonly headingLevel = input(3);
  protected readonly id = `mt-settings-section-${nextId++}`;
}

/**
 * SettingsRow (`mt-settings-row`): one setting: a title, a description and its control (projected,
 * usually a Switch or Select with `labelHidden` and the same label). `locked` shows a shield and is
 * for settings the org can't change ("Clerk never sends, files or bills anything"). Content marked
 * `mtRowLead` (a person's avatar) goes before the title.
 */
@Component({
  selector: 'mt-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/setting.css',
  imports: [MtIcon],
  host: { class: 'mt-setting', '[attr.data-locked]': 'locked() ? "" : null', '[attr.title]': 'null' },
  // When the controls don't fit beside a readable title (a member's several actions, a phone), they
  // wrap under it, still at the end, instead of squeezing the title into a narrow column.
  styles: `
    .mt-setting {
      flex-wrap: wrap;
    }
    .mt-setting > .tx {
      flex: 1 1 240px;
    }
    .mt-setting > .tx ~ * {
      margin-inline-start: auto;
    }
  `,
  template: `
    <ng-content select="[mtRowLead]" />
    <div class="tx">
      <div class="tt">
        {{ title() }}
        @if (locked()) {
          <mt-icon name="shield" label="Locked" />
        }
      </div>
      @if (description(); as text) {
        <div class="ts">{{ text }}</div>
      }
    </div>
    <ng-content />
  `,
})
export class MtSettingsRow {
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly locked = input(false, { transform: booleanAttribute });
}
