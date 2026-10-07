import type { Route } from '@angular/router';

import { LEGAL_DOCUMENTS } from '@materia/domain';

const documentPage = () => import('./legal-document-page').then((m) => m.LegalDocumentPage);

/**
 * `/legal/*` (SEC-01): the index and one page per document in the registry, so a new document
 * (the accessibility statement, SEC-06) is a Markdown file, not a route. Public: no guards.
 */
export const LEGAL_ROUTES: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Legal',
    loadComponent: () => import('./legal-index-page').then((m) => m.LegalIndexPage),
  },
  ...LEGAL_DOCUMENTS.map((doc): Route => ({
    path: doc.key,
    title: doc.title,
    data: { legalKey: doc.key },
    loadComponent: documentPage,
  })),
  { path: '**', redirectTo: '' },
];
