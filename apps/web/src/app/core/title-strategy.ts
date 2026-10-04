import { effect, Injectable, inject, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type ActivatedRouteSnapshot, type RouterStateSnapshot, TitleStrategy } from '@angular/router';

/**
 * Matter numbers by matter id, recorded by the matter screen once the matter loads, so titles and
 * breadcrumbs show `M-2026-0142` rather than the document id. Until then the id stands in.
 */
@Injectable({ providedIn: 'root' })
export class MatterRefs {
  private readonly numbers = signal<Readonly<Record<string, string>>>({});
  /** Every known number, by matter id. */
  readonly all = this.numbers.asReadonly();

  /** The matter's number, or its id while the number isn't known. */
  label(id: string): string {
    return this.numbers()[id] ?? id;
  }

  set(id: string, number: string): void {
    if (this.numbers()[id] !== number) this.numbers.update((numbers) => ({ ...numbers, [id]: number }));
  }
}

const asIs = (id: string) => id;

/** Every route's title segments from root to leaf, plus the matter number on matter routes. */
export function titleSegments(root: ActivatedRouteSnapshot, matterRef: (id: string) => string = asIs): string[] {
  const segments: string[] = [];
  let route: ActivatedRouteSnapshot | null = root;
  while (route) {
    const title = route.title ?? (route.data['title'] as string | undefined);
    if (title && !segments.includes(title)) segments.push(title);
    const matterId = route.paramMap.get('id');
    const ref = matterId ? matterRef(matterId) : null;
    if (ref && route.data['matterRoute'] === true && !segments.includes(ref)) segments.push(ref);
    route = route.firstChild;
  }
  return segments;
}

/** `Matter · M-2026-0142 · Materia`: route titles from root to leaf, then the product name. */
@Injectable({ providedIn: 'root' })
export class MateriaTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly refs = inject(MatterRefs);
  private snapshot: RouterStateSnapshot | null = null;

  constructor() {
    super();
    // A matter number arriving after navigation retitles the page.
    effect(() => {
      this.refs.all();
      const snapshot = this.snapshot;
      if (snapshot) untracked(() => this.updateTitle(snapshot));
    });
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.snapshot = snapshot;
    const segments = titleSegments(snapshot.root, (id) => untracked(() => this.refs.label(id)));
    this.title.setTitle([...segments, 'Materia'].join(' · '));
  }
}

/** A breadcrumb built from the route tree. */
export interface RouteCrumb {
  label: string;
  link: string;
  ref?: boolean;
}

/**
 * Breadcrumbs from root to leaf: each route config's own `data.crumb` (or its string title), linked
 * to that route's URL. Only the route's own config counts, not data inherited from a parent. The
 * matter number on the matter route (`data.matterRoute`) is a mono `ref` crumb.
 */
export function routeCrumbs(root: ActivatedRouteSnapshot, matterRef: (id: string) => string = asIs): RouteCrumb[] {
  const crumbs: RouteCrumb[] = [];
  const path: string[] = [];
  let route: ActivatedRouteSnapshot | null = root;
  while (route) {
    path.push(...route.url.map((segment) => segment.path));
    const link = '/' + path.join('/');
    const config = route.routeConfig;
    const matterId = route.paramMap.get('id');
    if (config?.data?.['matterRoute'] === true && matterId) {
      crumbs.push({ label: matterRef(matterId), link, ref: true });
    } else {
      const label =
        (config?.data?.['crumb'] as string | undefined) ??
        (typeof config?.title === 'string' ? config.title : undefined);
      const previous = crumbs[crumbs.length - 1];
      if (label && previous?.label === label) previous.link = link;
      else if (label) crumbs.push({ label, link });
    }
    route = route.firstChild;
  }
  return crumbs;
}
