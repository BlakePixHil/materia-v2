import type { JobType } from '@materia/domain';

import { mergeHandler } from './merge';
import { renderHandler } from './render';
import type { JobHandler } from '../core/types';

/** The `pdf` Cloud Run job runs both PDF job types. */
export const PDF_HANDLERS: Record<JobType, JobHandler> = {
  'pdf.render': renderHandler as JobHandler,
  'pdf.merge': mergeHandler as JobHandler,
};
