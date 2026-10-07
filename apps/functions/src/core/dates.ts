import { Timestamp } from 'firebase-admin/firestore';

/** Firestore Timestamps as Dates, so stored records parse with the domain schemas. */
export function withDates(value: unknown, depth = 0): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (depth > 6 || value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => withDates(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withDates(item, depth + 1)]));
}
