import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import { Router, type CanActivateFn, type CanMatchFn } from '@angular/router';

import type { FlagKey } from '@materia/domain';

import { FeatureFlagService } from './feature-flags';

/**
 * Shows its content while a boolean flag is on: `<button *mtFlag="'billing.invoicing'">Invoice</button>`.
 * Hiding isn't security; server-enforced flags are checked by the callables too.
 */
@Directive({ selector: '[mtFlag]' })
export class MtFlag {
  readonly mtFlag = input.required<FlagKey>();

  constructor() {
    const template = inject(TemplateRef);
    const container = inject(ViewContainerRef);
    const flags = inject(FeatureFlagService);
    let shown = false;
    effect(() => {
      const on = flags.isOn(this.mtFlag());
      if (on && !shown) container.createEmbeddedView(template);
      if (!on && shown) container.clear();
      shown = on;
    });
  }
}

/** A route that exists only while its flag is on; otherwise Today. Re-evaluated on each navigation. */
export function flagGuard(key: FlagKey): CanActivateFn & CanMatchFn {
  return async () => {
    const flags = inject(FeatureFlagService);
    const router = inject(Router);
    await flags.ready();
    return flags.isOn(key) ? true : router.createUrlTree(['/today']);
  };
}
