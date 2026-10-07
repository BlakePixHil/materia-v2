import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { MtButton, MtIcon } from '@materia/ui';

import { PushDevices } from './push-devices';
import { PushSetup } from './push-setup';
import { InstallPrompt } from '../pwa/install-prompt';

/** Remembered per browser once the person answers the offer. */
export const PUSH_OFFER_KEY = 'materia.pushOffer';

function answered(): boolean {
  try {
    return globalThis.localStorage?.getItem(PUSH_OFFER_KEY) === 'answered';
  } catch {
    return false;
  }
}

function rememberAnswer(): void {
  try {
    globalThis.localStorage?.setItem(PUSH_OFFER_KEY, 'answered');
  } catch {
    // Storage may be unavailable; the offer comes back next time.
  }
}

/**
 * "Get deadline alerts on this device" (MOB-04): shown beside critical deadlines, never on first
 * load, until the person answers it on this browser. It says what alerts are first; the browser's
 * own permission prompt comes only from "Turn on alerts". On an iPhone or iPad in Safari, where
 * push needs the installed app, it offers the install steps instead. Nothing shows once alerts are
 * on, blocked, or impossible here; Settings → Preferences has the same switch.
 */
@Component({
  selector: 'mt-push-offer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtIcon],
  template: `
    @if (shown()) {
      <section class="push-offer" aria-labelledby="push-offer-title" data-push-offer [attr.data-state]="state()">
        <span class="push-offer-icon" aria-hidden="true"
          ><mt-icon [name]="state() === 'install' ? 'smartphone' : 'bell'"
        /></span>
        <div class="push-offer-text">
          @if (state() === 'install') {
            <p class="push-offer-title" id="push-offer-title">Install Materia to receive alerts</p>
            <p>
              On iPhone and iPad, deadline alerts come only to Materia on your Home Screen. Install it, open it from
              there, and turn alerts on.
            </p>
          } @else {
            <p class="push-offer-title" id="push-offer-title">Get deadline alerts on this device</p>
            <p>
              Materia can tell this device when a critical deadline is close or nobody has acknowledged it, even when
              Materia is closed. Alerts name the matter number, never the client.
            </p>
          }
        </div>
        <div class="push-offer-actions">
          @if (state() === 'install') {
            <button mtButton size="sm" variant="primary" type="button" (click)="install()">How to install</button>
          } @else {
            <button mtButton size="sm" variant="primary" type="button" [loading]="devices.busy()" (click)="turnOn()">
              Turn on alerts
            </button>
          }
          <button mtButton size="sm" variant="ghost" type="button" (click)="notNow()">Not now</button>
        </div>
      </section>
    }
  `,
  styles: `
    .push-offer {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      animation: push-offer-in 220ms ease-out;
    }
    .push-offer-icon {
      flex: none;
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-full);
      background: var(--bg-brand-subtle);
      color: var(--icon-brand);
    }
    .push-offer-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .push-offer-text p {
      margin: 0;
      font: 400 13px/19px var(--font-sans);
      color: var(--text-secondary);
    }
    .push-offer-text .push-offer-title {
      font: 600 14px/20px var(--font-sans);
      color: var(--text-primary);
      text-wrap: balance;
    }
    .push-offer-actions {
      flex: none;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    @media (max-width: 767px) {
      .push-offer {
        flex-wrap: wrap;
      }
      .push-offer-actions {
        flex-basis: 100%;
        padding-left: 44px;
      }
    }
    @keyframes push-offer-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .push-offer {
        animation: none;
      }
    }
  `,
})
export class PushOffer {
  protected readonly devices = inject(PushDevices);
  private readonly setup = inject(PushSetup);
  private readonly installer = inject(InstallPrompt);
  private readonly dismissed = signal(answered());

  protected readonly state = computed(() => this.devices.status());
  protected readonly shown = computed(
    () => this.devices.loaded() && !this.dismissed() && (this.state() === 'off' || this.state() === 'install'),
  );

  constructor() {
    void this.devices.load();
  }

  protected async turnOn(): Promise<void> {
    if (await this.setup.turnOn()) this.answer();
    else if (this.devices.status() === 'denied') this.answer();
  }

  protected async install(): Promise<void> {
    await this.installer.install();
  }

  protected notNow(): void {
    this.answer();
  }

  private answer(): void {
    rememberAnswer();
    this.dismissed.set(true);
  }
}
