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
 * usually a Switch with `labelHidden` and the same label, or a Select). `locked` shows a shield and is
 * for settings the org can't change ("Clerk never sends, files or bills anything").
 */
@Component({
  selector: 'mt-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/setting.css',
  imports: [MtIcon],
  host: { class: 'mt-setting', '[attr.data-locked]': 'locked() ? "" : null', '[attr.title]': 'null' },
  template: `
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
