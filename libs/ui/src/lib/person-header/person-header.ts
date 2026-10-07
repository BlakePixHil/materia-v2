import { ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';

import { MtAvatar } from '../markers/markers';

/** A role a person holds on a matter ("Executor" on WE-142). */
export interface PersonRoleVm {
  label: string;
  /** Matter number. */
  ref?: string | undefined;
}

/**
 * PersonHeader (`mt-person-header`): the top of a contact page: avatar, name, a subtitle, badges
 * (projected, such as "ID verified") and the roles they hold across matters. The name is the page's
 * `h1`, or an `h2` where the page already has one (a contact open beside the Contacts list).
 */
@Component({
  selector: 'mt-person-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/person.css',
    '../../generated/components/roles.css',
    '../../generated/components/role.css',
    '../../generated/components/layout.css',
  ],
  imports: [MtAvatar],
  host: { class: 'mt-col mt-person-header' },
  template: `
    <div class="mt-person">
      <mt-avatar [name]="name()" [src]="src() ?? null" [colorKey]="colorKey() ?? name()" size="xl" />
      <div class="mt-col mt-grow mt-person-text">
        @if (headingLevel() === 1) {
          <h1 class="nm mt-ell">{{ name() }}</h1>
        } @else {
          <h2 class="nm mt-ell">{{ name() }}</h2>
        }
        @if (subtitle(); as text) {
          <span class="mt-person-sub">{{ text }}</span>
        }
      </div>
      <span class="mt-ml mt-row mt-wrap"><ng-content /></span>
    </div>
    @if (roles().length) {
      <ul class="mt-roles" aria-label="Roles">
        @for (role of roles(); track role.label + (role.ref ?? '')) {
          <li class="mt-role">
            {{ role.label }}
            @if (role.ref; as ref) {
              <span class="ref">{{ ref }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class MtPersonHeader {
  readonly name = input.required<string>();
  readonly subtitle = input<string>();
  readonly src = input<string | null>();
  readonly colorKey = input<string>();
  readonly roles = input<readonly PersonRoleVm[]>([]);
  /** Heading level for the name within the page outline (default 1). */
  readonly headingLevel = input<1 | 2>(1);
}
