import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { can } from '@materia/data-access';
import {
  contactsRepository,
  MATTER_CALLABLES,
  matterConflictsRepository,
  type ContactListItem,
} from '@materia/data-access/repository';
import {
  conflictAllowsOpening,
  MATTER_STATUS_LABELS,
  type ChangeMatterStatusResult,
  type ConflictSubject,
  type MatterStatus,
} from '@materia/domain';
import { MtButton, MtNote, ToastService } from '@materia/ui';

import { ConflictCheckPanel } from './conflict-check-panel';
import { matterSubjectRefs, subjectFromContact } from './conflict-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { changeStatusErrorCopy } from '../matters/matters-view';

/**
 * A matter's conflict check (`/matters/:id/conflicts`, CORE-02): the panel prefilled with the
 * matter's clients, deceased and testator, checked against everyone else (the matter's own parties
 * aren't hits). Once a lawyer records Clear or waives a potential conflict, a lead can open here.
 */
@Component({
  selector: 'mt-matter-conflicts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConflictCheckPanel, MtButton, MtNote, RouterLink],
  template: `
    <div class="head">
      <div class="mt-col" style="gap: var(--space-4)">
        <h2 class="title-m">Conflict check</h2>
        @if (matter.value(); as m) {
          <p class="body-s t-2">{{ m.number }} · {{ m.title }} · {{ statusLabels[m.status] }}</p>
        }
      </div>
      @if (canOpen()) {
        <button
          mtButton
          class="mt-ml"
          variant="primary"
          size="sm"
          iconStart="check-circle"
          [loading]="opening()"
          (click)="openMatter()"
        >
          Open matter
        </button>
      }
    </div>
    @switch (matter.status()) {
      @case ('loading') {
        <p role="status" class="caption t-3">Loading the matter…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
      @default {
        @if (matter.value(); as m) {
          @if (m.status !== 'lead') {
            <mt-note
              >This matter is {{ statusLabels[m.status].toLowerCase() }}. You can still check it and record the
              result.</mt-note
            >
          }
          <mt-conflict-check-panel [subjects]="subjects()" [matterId]="m.id" [current]="m.conflictCheck ?? null" />
        } @else {
          <mt-note tone="danger"
            >We couldn’t find that matter. It may have been deleted.
            <a routerLink="/matters">Back to matters</a></mt-note
          >
        }
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
      max-width: 1120px;
    }
    .head {
      display: flex;
      align-items: flex-start;
      gap: var(--space-12);
    }
    h2,
    p {
      margin: 0;
    }
  `,
})
export class MatterConflictsPage {
  private readonly callables = inject(CALLABLES);
  private readonly toasts = inject(ToastService);
  private readonly contacts = contactsRepository();
  private readonly canStatus = can('matter.status');

  protected readonly statusLabels = MATTER_STATUS_LABELS;
  private readonly route = inject(ActivatedRoute);
  /** The matter id is the parent (MatterLayout) route's parameter. */
  private readonly id = toSignal((this.route.parent ?? this.route).paramMap.pipe(map((p) => p.get('id'))), {
    initialValue: null,
  });
  protected readonly matter = matterConflictsRepository().watch(() => this.id());
  protected readonly loadError = computed(() => errorCopy(this.matter.error()));
  protected readonly subjects = signal<ConflictSubject[]>([]);
  protected readonly opening = signal(false);
  protected readonly canOpen = computed(() => {
    const matter = this.matter.value();
    return (
      !!matter && matter.status === 'lead' && this.canStatus() && conflictAllowsOpening(matter.conflictCheck?.status)
    );
  });
  /** Which matter's contacts the subjects came from (they load once per matter). */
  private loadedFor: string | null = null;

  constructor() {
    effect(() => {
      const matter = this.matter.value();
      if (!matter || this.loadedFor === matter.id) return;
      this.loadedFor = matter.id;
      const refs = matterSubjectRefs(matter);
      untracked(() => void this.loadSubjects(refs));
    });
  }

  private async loadSubjects(refs: ReturnType<typeof matterSubjectRefs>): Promise<void> {
    const contacts = await Promise.all(
      refs.map((ref) => this.contacts.get(ref.contactId).catch((): ContactListItem | null => null)),
    );
    this.subjects.set(
      refs.flatMap((ref, i) => {
        const contact = contacts[i];
        return contact ? [subjectFromContact(ref.contactId, contact, ref.role)] : [];
      }),
    );
  }

  protected async openMatter(): Promise<void> {
    const matter = this.matter.value();
    if (!matter || this.opening()) return;
    this.opening.set(true);
    try {
      await this.callables.call<{ matterId: string; to: MatterStatus }, ChangeMatterStatusResult>(
        MATTER_CALLABLES.changeStatus,
        { matterId: matter.id, to: 'open' },
        { idempotent: true },
      );
      this.toasts.show({ title: `${matter.number} is open`, tone: 'success' });
    } catch (error) {
      this.toasts.show({
        title: 'Couldn’t open the matter',
        description: changeStatusErrorCopy(error),
        tone: 'danger',
      });
    } finally {
      this.opening.set(false);
    }
  }
}
