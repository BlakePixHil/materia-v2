/**
 * Fictional data for tests and fixtures. Never use real client names, matters or documents.
 * FND-13 adds the entity factories.
 */
export const FICTIONAL_PEOPLE = [
  { givenName: 'Alex', familyName: 'Example' },
  { givenName: 'Jordan', familyName: 'Sample' },
  { givenName: 'Sam', familyName: 'Placeholder' },
] as const;

/** Returns a fictional person, chosen deterministically from `seed`. */
export function fictionalPerson(seed: number): (typeof FICTIONAL_PEOPLE)[number] {
  const index = Math.abs(Math.trunc(seed)) % FICTIONAL_PEOPLE.length;
  // The modulo keeps the index in range, so the lookup always succeeds.
  return FICTIONAL_PEOPLE[index] as (typeof FICTIONAL_PEOPLE)[number];
}
