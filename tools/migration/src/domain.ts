import * as domainModule from '@materia/domain';

/**
 * `@materia/domain` for the CLI. Workspace libs load as CommonJS under tsx, so a namespace import
 * can arrive wrapped in `default` and named imports fail (the interop tools/scripts handles too).
 */
export const domain: typeof domainModule =
  (domainModule as typeof domainModule & { default?: typeof domainModule }).default ?? domainModule;
