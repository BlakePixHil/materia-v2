import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { membersRepository } from '@materia/data-access/repository';
import { initialsFrom, MEMBER_COLOURS, ProfileInput } from '@materia/domain';
import {
  DialogService,
  MtAvatar,
  MtButton,
  MtNote,
  MtSettingsRow,
  MtSettingsSection,
  MtTextField,
  ToastService,
} from '@materia/ui';

import { AvatarCropper, type AvatarCropData } from './avatar-cropper';
import { AVATAR_STORE } from './avatar-store';
import { AuthState } from '../../core/auth/auth-state';
import { errorCopy } from '../../core/error-copy';
import { UserPrefsService } from '../../core/profile/user-prefs';
import { warnBeforeUnload, type HasUnsavedChanges } from '../settings/unsaved-changes';

interface ProfileForm {
  firstName: string;
  lastName: string;
  displayName: string;
  title: string;
  admissionNo: string;
  initials: string;
  colour: string;
}

const EMPTY: ProfileForm = {
  firstName: '',
  lastName: '',
  displayName: '',
  title: '',
  admissionNo: '',
  initials: '',
  colour: MEMBER_COLOURS[0] as string,
};

/**
 * Settings → Profile (`/settings/profile`, CORE-20; everyone): the person's names on `users/{uid}`,
 * and their title, admission number, initials and colour on their member document in the active
 * org. A new display name reaches their other orgs through `orgs-onProfileWrite`. The photo is
 * cropped to a square and downscaled here, then uploaded to `users/{uid}/avatar.png`.
 */
@Component({
  selector: 'mt-profile-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtAvatar, MtButton, MtNote, MtSettingsRow, MtSettingsSection, MtTextField],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Profile</h1>
      <p style="margin: 0; color: var(--text-secondary)">How colleagues see you in {{ orgName() }}.</p>
    </div>

    @if (prefs.profile.status() === 'error') {
      <mt-note tone="danger">Couldn’t load your profile. Check your connection and reload.</mt-note>
    }

    <mt-settings-section title="Photo" [headingLevel]="2">
      <mt-settings-row
        title="Your photo"
        description="A square crop, shown beside your name. JPEG, PNG, WebP, or HEIC in Safari."
      >
        <div class="mt-row" style="gap: 12px; align-items: center">
          <mt-avatar size="lg" [name]="form().displayName || 'You'" [colorKey]="uid() ?? ''" [src]="avatarUrl()" />
          <input
            #photo
            type="file"
            accept="image/*,.heic,.heif"
            class="mt-sr"
            aria-label="Choose a photo"
            (change)="choose($event)"
          />
          <button mtButton size="sm" type="button" [loading]="uploading()" (click)="photoInput().nativeElement.click()">
            {{ avatarUrl() ? 'Change photo' : 'Add photo' }}
          </button>
          @if (avatarUrl()) {
            <button mtButton size="sm" variant="ghost" type="button" [disabled]="uploading()" (click)="removePhoto()">
              Remove
            </button>
          }
        </div>
      </mt-settings-row>
    </mt-settings-section>

    <form class="mt-col" style="gap: 24px" (submit)="$event.preventDefault(); save()">
      <mt-settings-section title="Name" [headingLevel]="2">
        <div class="mt-row" style="gap: 12px; flex-wrap: wrap">
          <mt-text-field
            style="flex: 1; min-width: 200px"
            name="firstName"
            label="First name"
            autocomplete="given-name"
            [error]="problems()['firstName']"
            [ngModel]="form().firstName"
            (ngModelChange)="set({ firstName: $event ?? '' })"
          />
          <mt-text-field
            style="flex: 1; min-width: 200px"
            name="lastName"
            label="Last name"
            autocomplete="family-name"
            optional
            [ngModel]="form().lastName"
            (ngModelChange)="set({ lastName: $event ?? '' })"
          />
        </div>
        <mt-text-field
          name="displayName"
          label="Display name"
          description="What colleagues see on matters, tasks and notes."
          autocomplete="name"
          [error]="problems()['displayName']"
          [ngModel]="form().displayName"
          (ngModelChange)="set({ displayName: $event ?? '' })"
        />
      </mt-settings-section>

      <mt-settings-section title="Practice details" [headingLevel]="2">
        <mt-text-field
          name="title"
          label="Title"
          optional
          description="Such as Senior Associate or Law clerk."
          [ngModel]="form().title"
          (ngModelChange)="set({ title: $event ?? '' })"
        />
        <mt-text-field
          name="admissionNo"
          label="Admission number"
          optional
          description="Your practising certificate or roll number, if you’re admitted."
          [ngModel]="form().admissionNo"
          (ngModelChange)="set({ admissionNo: $event ?? '' })"
        />
        <mt-text-field
          name="initials"
          label="Initials"
          optional
          [description]="'One to three letters. Leave blank for ' + defaultInitials() + '.'"
          [error]="problems()['initials']"
          [ngModel]="form().initials"
          (ngModelChange)="set({ initials: $event ?? '' })"
        />
        <fieldset class="colours">
          <legend class="label">Colour</legend>
          @for (colour of colours; track colour; let i = $index) {
            <label class="swatch" [style.background]="colour">
              <input
                type="radio"
                name="colour"
                class="mt-sr"
                [attr.aria-label]="'Colour ' + (i + 1)"
                [checked]="form().colour === colour"
                (change)="set({ colour })"
              />
            </label>
          }
        </fieldset>
      </mt-settings-section>

      <div class="mt-row" style="gap: 8px">
        <button mtButton variant="primary" type="submit" [loading]="saving()" [disabled]="!ready()">Save</button>
        <button mtButton variant="ghost" type="button" [disabled]="!unsaved()" (click)="reset()">
          Discard changes
        </button>
      </div>
    </form>
  `,
  styles: `
    .colours {
      border: 0;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .colours legend {
      margin-bottom: 8px;
    }
    .swatch {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      cursor: pointer;
      box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
    }
    .swatch:has(input:checked) {
      outline: 2px solid var(--text-primary);
      outline-offset: 2px;
    }
    .swatch:has(input:focus-visible) {
      outline: 2px solid var(--focus, var(--text-primary));
      outline-offset: 2px;
    }
  `,
})
export class ProfilePage implements HasUnsavedChanges {
  private readonly context = inject(OrgContext);
  private readonly auth = inject(AuthState);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly avatars = inject(AVATAR_STORE);
  private readonly members = membersRepository();
  protected readonly prefs = inject(UserPrefsService);
  protected readonly member = this.members.watch(() => this.context.uid());
  protected readonly photoInput = viewChild.required<ElementRef<HTMLInputElement>>('photo');

  protected readonly uid = this.context.uid;
  protected readonly colours = MEMBER_COLOURS;
  protected readonly orgName = computed(() => this.auth.user()?.orgName ?? 'your practice');
  protected readonly avatarUrl = computed(() => this.prefs.profile.value()?.avatarUrl ?? null);

  protected readonly form = signal<ProfileForm>(EMPTY);
  private readonly saved = signal<ProfileForm | null>(null);
  protected readonly saving = signal(false);
  protected readonly uploading = signal(false);

  readonly unsaved = computed(() => {
    const saved = this.saved();
    return !!saved && JSON.stringify(saved) !== JSON.stringify(this.form());
  });
  private readonly input = computed(() => ProfileInput.safeParse(this.form()));
  protected readonly problems = computed<Record<string, string | undefined>>(() => {
    const parsed = this.input();
    if (parsed.success) return {};
    return Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
  });
  protected readonly defaultInitials = computed(() => initialsFrom(this.form().displayName || this.form().firstName));
  protected readonly ready = computed(() => this.unsaved() && this.input().success && !this.saving());

  constructor() {
    warnBeforeUnload(this.unsaved);
    // Fill the form when both documents have loaded (and after a save), not while editing.
    effect(() => {
      const user = this.prefs.profile.value();
      const member = this.member.value();
      if (!user || !member) return;
      untracked(() => {
        if (this.unsaved()) return;
        const form: ProfileForm = {
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? '',
          displayName: member.displayName || user.displayName || '',
          title: member.title ?? '',
          admissionNo: member.admissionNo ?? '',
          initials: member.initials && member.initials !== initialsFrom(member.displayName) ? member.initials : '',
          colour:
            member.colour && MEMBER_COLOURS.includes(member.colour) ? member.colour : (MEMBER_COLOURS[0] as string),
        };
        this.form.set(form);
        this.saved.set(form);
      });
    });
  }

  protected set(patch: Partial<ProfileForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected reset(): void {
    const saved = this.saved();
    if (saved) this.form.set(saved);
  }

  protected async save(): Promise<void> {
    const parsed = this.input();
    const uid = this.uid();
    if (!this.ready() || !parsed.success || !uid) return;
    const profile = parsed.data;
    this.saving.set(true);
    try {
      await Promise.all([
        this.prefs.saveProfile({
          firstName: profile.firstName,
          lastName: profile.lastName,
          displayName: profile.displayName,
        }),
        this.members.update(uid, {
          displayName: profile.displayName,
          title: profile.title,
          admissionNo: profile.admissionNo,
          initials: profile.initials || initialsFrom(profile.displayName),
          colour: profile.colour,
        }),
      ]);
      this.saved.set(this.form());
      this.toasts.show({ title: 'Profile saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Your profile didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }

  protected async choose(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const uid = this.uid();
    if (!file || !uid) return;
    const png = await this.dialogs.open<AvatarCropData, Blob | undefined>(AvatarCropper, { data: { file } }).result;
    if (!png) return;
    this.uploading.set(true);
    try {
      const url = await this.avatars.upload(uid, png);
      await this.prefs.saveProfile({ avatarUrl: url });
      this.toasts.show({ title: 'Photo updated', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The photo didn’t upload', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.uploading.set(false);
    }
  }

  protected async removePhoto(): Promise<void> {
    const uid = this.uid();
    if (!uid) return;
    this.uploading.set(true);
    try {
      await this.prefs.saveProfile({}, ['avatarUrl']);
      await this.avatars.remove(uid);
      this.toasts.show({ title: 'Photo removed', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The photo wasn’t removed', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.uploading.set(false);
    }
  }
}
