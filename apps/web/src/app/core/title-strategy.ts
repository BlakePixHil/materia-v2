import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type ActivatedRouteSnapshot, type RouterStateSnapshot, TitleStrategy } from '@angular/router';

/** Every route's title segments from root to leaf, plus the matter number on matter routes. */
export function titleSegments(root: ActivatedRouteSnapshot): string[] {
  const segments: string[] = [];
  let route: ActivatedRouteSnapshot | null = root;
  while (route) {
    const title = route.title ?? (route.data['title'] as string | undefined);
    if (title && !segments.includes(title)) segments.push(title);
    const matterId = route.paramMap.get('id');
    if (matterId && route.data['matterRoute'] === true && !segments.includes(matterId)) segments.push(matterId);
    route = route.firstChild;
  }
  return segments;
}

/** `Matter · M-2026-0142 · Materia`: route titles from root to leaf, then the product name. */
@Injectable({ providedIn: 'root' })
export class MateriaTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const segments = titleSegments(snapshot.root);
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
export function routeCrumbs(root: ActivatedRouteSnapshot): RouteCrumb[] {
  const crumbs: RouteCrumb[] = [];
  const path: string[] = [];
  let route: ActivatedRouteSnapshot | null = root;
  while (route) {
    path.push(...route.url.map((segment) => segment.path));
    const link = '/' + path.join('/');
    const config = route.routeConfig;
    const matterId = route.paramMap.get('id');
    if (config?.data?.['matterRoute'] === true && matterId) {
      crumbs.push({ label: matterId, link, ref: true });
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
