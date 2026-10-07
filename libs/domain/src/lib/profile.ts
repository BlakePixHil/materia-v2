import * as z from 'zod';

import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_KIND_IDS,
  NOTIFICATION_KINDS,
  readNotificationPrefs,
  type NotificationPrefs,
} from './notifications';
import { ThemeSchema } from './schemas/enums';
import { NOTIFICATION_CHANNELS, type NotificationChannel, type NotificationKind } from './schemas/org-records';

/*
 * A person's own profile and preferences (CORE-20): Settings → Profile and Preferences. The names
 * live on `users/{uid}`; title, admission number, initials and colour on their member document in
 * the active org. Preferences are `users/{uid}.prefs`, written client-direct.
 */

// ---------- profile ----------

/** The colours a person can pick for their initials (the same set new members get one from). */
export const MEMBER_COLOURS = ['#346CFC', '#0E9F6E', '#C2410C', '#7C3AED', '#0891B2', '#BE185D', '#4D7C0F', '#B45309'];

const trimmed = (max: number) => z.string().trim().max(max);

/** What Settings → Profile saves. */
export const ProfileInput = z
  .object({
    firstName: trimmed(60).min(1, { message: 'Enter your first name.' }),
    lastName: trimmed(60),
    displayName: trimmed(80).min(1, { message: 'Enter the name colleagues see.' }),
    title: trimmed(80),
    admissionNo: trimmed(40),
    initials: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,3}$/, { message: 'One to three letters.' })
      .transform((value) => value.toUpperCase())
      .or(z.literal('')),
    colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  })
  .strict();
export type ProfileInput = z.infer<typeof ProfileInput>;

/** Two letters from a name ("Priya Shah" → "PS"), as new members get. */
export function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}` : (parts[0] ?? '').slice(0, 2);
  return letters.toUpperCase() || '?';
}

// ---------- avatar ----------

/** The stored avatar: a square PNG this many pixels a side, at most this many bytes (storage.rules). */
export const AVATAR_SIZE = 512;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export interface CropRect {
  x: number;
  y: number;
  size: number;
}

/**
 * The square of the source image the avatar shows. `zoom` 1 is the largest square that fits;
 * `zoom` 2 shows half of that. `panX` and `panY` run from -1 (left or top edge) to 1 (right or
 * bottom edge), 0 centred. The square never leaves the image.
 */
export function squareCrop(width: number, height: number, zoom = 1, panX = 0, panY = 0): CropRect {
  const side = Math.min(width, height) / Math.max(1, zoom);
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const x = ((width - side) / 2) * (1 + clamp(panX));
  const y = ((height - side) / 2) * (1 + clamp(panY));
  return { x, y, size: side };
}

// ---------- preferences ----------

export type ThemePref = z.infer<typeof ThemeSchema>;
export type DensityPref = 'comfortable' | 'compact';
export type StartPage = 'today' | 'matters';

/**
 * Guided tours (CORE-24). `auto` plays a page's tour the first time the page opens; `seen` lists the
 * tours finished or skipped (`welcome` among them once the first-sign-in tour has been answered).
 */
export interface TourPrefs {
  auto: boolean;
  seen: string[];
}

/** At most this many tour ids are kept in `seen` (the oldest drop off). */
export const TOUR_SEEN_MAX = 40;
/** A tour id: lower-case words joined by hyphens (`welcome`, `matter-documents`). */
export const TOUR_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** `users/{uid}.prefs`, with every field filled. */
export interface UserPrefs {
  theme: ThemePref;
  density: DensityPref;
  shortcuts: boolean;
  notifications: NotificationPrefs;
  timezone?: string;
  startPage: StartPage;
  tours: TourPrefs;
}

export const DEFAULT_USER_PREFS: UserPrefs = {
  theme: 'system',
  density: 'comfortable',
  shortcuts: true,
  notifications: DEFAULT_NOTIFICATION_PREFS,
  startPage: 'today',
  tours: { auto: false, seen: [] },
};

/** Reads stored tour preferences defensively: unknown ids and duplicates are dropped. */
export function readTourPrefs(raw: unknown): TourPrefs {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = Array.isArray(data['seen'])
    ? data['seen'].filter((id): id is string => typeof id === 'string' && TOUR_ID_PATTERN.test(id))
    : [];
  return { auto: data['auto'] === true, seen: [...new Set(seen)].slice(-TOUR_SEEN_MAX) };
}

/** Marks a tour finished or skipped: it moves to the end of `seen`, which keeps the newest ids. */
export function markTourSeen(tours: TourPrefs, id: string): TourPrefs {
  return { ...tours, seen: [...tours.seen.filter((seen) => seen !== id), id].slice(-TOUR_SEEN_MAX) };
}

/** Reads stored preferences defensively: a missing or invalid field takes its default. */
export function readUserPrefs(raw: unknown): UserPrefs {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const theme = ThemeSchema.safeParse(data['theme']);
  const prefs: UserPrefs = {
    theme: theme.success ? theme.data : DEFAULT_USER_PREFS.theme,
    density: data['density'] === 'compact' ? 'compact' : 'comfortable',
    shortcuts: typeof data['shortcuts'] === 'boolean' ? data['shortcuts'] : true,
    notifications: readNotificationPrefs(data['notifications']),
    startPage: data['startPage'] === 'matters' ? 'matters' : 'today',
    tours: readTourPrefs(data['tours']),
  };
  if (typeof data['timezone'] === 'string' && data['timezone']) prefs.timezone = data['timezone'];
  return prefs;
}

// ---------- the notification matrix ----------

/**
 * Channels a person can't turn off for a kind. Critical kinds (deadline escalations) always go
 * in-app and by email: `resolveChannels` enforces it on the server whatever is stored, and the
 * rules refuse storing it off.
 */
export function lockedChannels(kind: NotificationKind): readonly NotificationChannel[] {
  return NOTIFICATION_KINDS[kind].priority === 'critical' ? ['inapp', 'email'] : [];
}

export interface MatrixCell {
  channel: NotificationChannel;
  on: boolean;
  /** Can't be turned off (critical). */
  locked: boolean;
  /** Switched off for everything by the channel's master switch (`email: false`, `push: false`). */
  masterOff: boolean;
}

export interface MatrixRow {
  kind: NotificationKind;
  label: string;
  cells: MatrixCell[];
}

/** One row per kind, one cell per channel, as Settings → Preferences shows them. */
export function notificationMatrix(prefs: NotificationPrefs): MatrixRow[] {
  return NOTIFICATION_KIND_IDS.map((kind) => {
    const spec = NOTIFICATION_KINDS[kind];
    const own = prefs.kinds?.[kind] ?? {};
    const locked = lockedChannels(kind);
    return {
      kind,
      label: spec.label,
      cells: NOTIFICATION_CHANNELS.map((channel) => {
        const isLocked = locked.includes(channel);
        const master = channel === 'email' ? prefs.email : channel === 'push' ? prefs.push : true;
        return {
          channel,
          on: isLocked || (own[channel] ?? (spec.channels as readonly string[]).includes(channel)),
          locked: isLocked,
          masterOff: !isLocked && !master,
        };
      }),
    };
  });
}

/**
 * Turns one kind's channel on or off. A locked channel stays on; a choice that matches the kind's
 * default is dropped rather than stored, so a later change of default reaches everyone who never
 * chose.
 */
export function setKindChannel(
  prefs: NotificationPrefs,
  kind: NotificationKind,
  channel: NotificationChannel,
  on: boolean,
): NotificationPrefs {
  if (lockedChannels(kind).includes(channel)) return prefs;
  const isDefault = (NOTIFICATION_KINDS[kind].channels as readonly string[]).includes(channel) === on;
  const own = Object.fromEntries(
    Object.entries({ ...(prefs.kinds?.[kind] ?? {}), [channel]: on }).filter(([c]) => !isDefault || c !== channel),
  );
  const kinds = Object.fromEntries(
    Object.entries({ ...(prefs.kinds ?? {}), [kind]: own }).filter(([, choice]) => Object.keys(choice).length),
  );
  const next: NotificationPrefs = { ...prefs, kinds };
  if (!Object.keys(kinds).length) delete next.kinds;
  return next;
}
