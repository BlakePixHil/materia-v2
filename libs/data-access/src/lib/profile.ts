import { inject } from '@angular/core';
import * as z from 'zod';

import { Device, User } from '@materia/domain';

import { OrgContext } from './org-context';
import { repo, type Repository } from './repository';

/**
 * What Settings → Profile and Preferences read from the signed-in person's `users/{uid}` (CORE-20).
 * `prefs` is read loosely (`readUserPrefs` in libs/domain fills defaults), so a document written
 * before a preference existed still loads. Other fields are dropped, not rejected.
 */
export const UserProfileSchema = /* @__PURE__ */ z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  avatarUrl: z.string().optional(),
  prefs: z.record(z.string(), z.unknown()).optional(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/**
 * `users/{uid}`, by the uid. The person updates their own names, `prefs` (written whole) and
 * `avatarUrl` client-direct (`User.update`); everything else is server-owned. Call it in an
 * injection context.
 */
export function userProfileRepository(): Repository<UserProfile> {
  return repo(() => 'users', { schema: UserProfileSchema, version: User.version, update: User.update });
}

/** A registered push device (`users/{uid}/devices`). */
export type DeviceItem = z.infer<typeof Device.schema>;

/**
 * The signed-in person's push devices (FND-20). Removing one deletes its FCM token, so that device
 * gets no more pushes. Call it in an injection context.
 */
export function myDevicesRepository(): Repository<DeviceItem> {
  const context = inject(OrgContext);
  return repo(() => `users/${context.uid() ?? '_'}/devices`, Device);
}
