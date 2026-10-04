import {
  computed,
  effect,
  inject,
  Injectable,
  InjectionToken,
  isDevMode,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import {
  FLAG_KEYS,
  isFlagKey,
  resolveFlag,
  type FlagKey,
  type FlagSource,
  type FlagValue,
  type FlagValueOf,
} from '@materia/domain';

import { AuthState } from '../auth/auth-state';

/** Where flag values come from: Remote Config and the org document. */
export interface FlagValueSource {
  /** Remote Config values for the registry's flags; empty when unavailable. */
  remote(): Promise<Record<string, FlagValue>>;
  /** The org's overrides (`orgs/{orgId}.flags`). */
  org(orgId: string): Promise<Record<string, unknown>>;
}

export const FLAG_SOURCE = new InjectionToken<FlagValueSource>('FLAG_SOURCE', {
  providedIn: 'root',
  factory: () => lazyFirebaseFlagSource(),
});

/** Loads the Firebase flag source (Remote Config, Firestore lite) on first use. */
export function lazyFirebaseFlagSource(
  load = () => import('./firebase-flag-source').then((m) => m.createFirebaseFlagSource()),
): FlagValueSource {
  let source: Promise<FlagValueSource> | undefined;
  const get = () => (source ??= load());
  return {
    remote: () => get().then((s) => s.remote()),
    org: (orgId) => get().then((s) => s.org(orgId)),
  };
}

/** Dev-only local overrides (the `/__dev/flags` page). */
export const LOCAL_FLAGS_KEY = 'materia.flags.local';

function readLocal(): Record<string, FlagValue> {
  if (!isDevMode()) return {};
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(LOCAL_FLAGS_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => isFlagKey(key))) as Record<string, FlagValue>;
  } catch {
    return {};
  }
}

/**
 * Feature flags in the web app (FND-23): registry defaults, then Remote Config, then the org's
 * overrides (and, in dev builds only, local overrides). Values are signals, so the UI follows
 * changes; guards read them on each navigation.
 *
 * Flags hide or show features. They are never authorisation: roles and rules decide access, and
 * server-enforced flags are checked again by the callables.
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlagService {
  private readonly source = inject(FLAG_SOURCE);
  private readonly auth = inject(AuthState);
  private readonly remote = signal<Record<string, FlagValue>>({});
  private readonly org = signal<Record<string, unknown>>({});
  private readonly local = signal<Record<string, FlagValue>>(readLocal());
  private readonly cache = new Map<FlagKey, Signal<{ value: FlagValue; source: FlagSource }>>();
  private remoteLoaded: Promise<void>;
  private orgLoad: { orgId: string | null; done: Promise<void> } = { orgId: null, done: Promise.resolve() };

  constructor() {
    this.remoteLoaded = this.source
      .remote()
      .then((values) => this.remote.set(values))
      .catch(() => console.warn('Remote Config unavailable; using flag defaults'));
    // Reload the org's overrides whenever the active org changes (sign-in, switch, sign-out).
    effect(() => {
      const orgId = this.auth.activeOrgId();
      untracked(() => void this.loadOrg(orgId));
    });
  }

  /** Loads (once per org) the active org's overrides; clears them when there's no org. */
  private loadOrg(orgId: string | null): Promise<void> {
    if (this.orgLoad.orgId === orgId) return this.orgLoad.done;
    this.org.set({});
    const done = orgId
      ? this.source
          .org(orgId)
          .then((values) => {
            if (this.auth.activeOrgId() === orgId) this.org.set(values);
          })
          .catch(() => undefined)
      : Promise.resolve();
    this.orgLoad = { orgId, done };
    return done;
  }

  /** Resolves once Remote Config and the current org's overrides have loaded (or failed). */
  async ready(): Promise<void> {
    await this.auth.whenReady();
    await Promise.all([this.remoteLoaded, this.loadOrg(this.auth.activeOrgId())]);
  }

  private resolved(key: FlagKey) {
    let entry = this.cache.get(key);
    if (!entry) {
      entry = computed(() => resolveFlag(key, { local: this.local(), org: this.org(), remote: this.remote() }));
      this.cache.set(key, entry);
    }
    return entry;
  }

  /** A flag's value as a signal. */
  flag<K extends FlagKey>(key: K): Signal<FlagValueOf<K>> {
    const resolved = this.resolved(key);
    return computed(() => resolved().value as FlagValueOf<K>);
  }

  /** Whether a boolean flag is on, now (reads the signal: reactive in templates and effects). */
  isOn(key: FlagKey): boolean {
    return this.resolved(key)().value === true;
  }

  /** Every flag with its value and where it came from (for the dev page). */
  readonly all = computed(() => FLAG_KEYS.map((key) => ({ key, ...this.resolved(key)() })));

  /** Dev builds only: override a flag locally (undefined clears it). */
  setLocal(key: FlagKey, value: FlagValue | undefined): void {
    if (!isDevMode()) return;
    this.local.update((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([k]) => k !== key));
      if (value !== undefined) next[key] = value;
      try {
        globalThis.localStorage?.setItem(LOCAL_FLAGS_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: the override lasts for this session.
      }
      return next;
    });
  }
}
