import { applicationDefault } from 'firebase-admin/app';

import { DomainError } from '@materia/domain';

import { REGION } from '../config';
import { adminApp } from '../core/admin';
import type { JobRunnerPort } from '../ports';

export interface CloudRunJobsOptions {
  /** The GCP project the jobs are deployed in (Functions set GCLOUD_PROJECT). */
  project?: () => string | undefined;
  /** An OAuth access token for the runtime service account (`fn-runtime`, roles/run.invoker). */
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
}

async function defaultToken(): Promise<string> {
  const credential = adminApp().options.credential ?? applicationDefault();
  return (await credential.getAccessToken()).access_token;
}

/**
 * Runs a Cloud Run job execution with the job document's ids as environment overrides (Cloud Run
 * Admin API v2, `jobs.run`). Deployed by the CD workflow as `pdf` in australia-southeast1.
 */
export function cloudRunJobs(options: CloudRunJobsOptions = {}): JobRunnerPort {
  const project = options.project ?? (() => process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT']);
  const accessToken = options.accessToken ?? defaultToken;
  const doFetch = options.fetch ?? fetch;

  return {
    async start(job, { orgId, jobId }) {
      const projectId = project();
      if (!projectId) throw new DomainError('UNAVAILABLE', 'No project configured for Cloud Run jobs');
      const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${REGION}/jobs/${job}:run`;
      const response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                env: [
                  { name: 'JOB_ORG_ID', value: orgId },
                  { name: 'JOB_ID', value: jobId },
                ],
              },
            ],
          },
        }),
      });
      if (!response.ok) {
        throw new DomainError('UNAVAILABLE', `Cloud Run job ${job} did not start`, { status: response.status });
      }
      const operation = (await response.json()) as { name?: string; metadata?: { name?: string } };
      const execution = operation.metadata?.name ?? operation.name ?? '';
      return { executionId: execution.split('/').pop() ?? execution };
    },
  };
}
