import type { JobType } from '@materia/domain';

import { mergeHandler } from './merge';
import { renderHandler } from './render';
import type { JobHandler } from '../core/types';
import { zipHandler } from '../documents/zip';

/** The `pdf` Cloud Run job runs both PDF job types, and zip downloads of documents (CORE-12b). */
export const PDF_HANDLERS: Record<JobType, JobHandler> = {
  'pdf.render': renderHandler as JobHandler,
  'pdf.merge': mergeHandler as JobHandler,
  'documents.zip': zipHandler as JobHandler,
};
