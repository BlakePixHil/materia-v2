/**
 * Workspace libs load as CommonJS under tsx, so a namespace import can arrive wrapped in `default`
 * (the same interop rules-sync handles). Returns the real module either way.
 */
export function unwrap<T extends object>(ns: T): T {
  return (ns as T & { default?: T }).default ?? ns;
}
