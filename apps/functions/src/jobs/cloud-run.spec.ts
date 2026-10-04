import { cloudRunJobs } from './cloud-run';

describe('cloudRunJobs', () => {
  it('runs the job with the ids as environment overrides and returns the execution id', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        name: 'projects/p/locations/australia-southeast1/operations/op-1',
        metadata: { name: 'projects/p/locations/australia-southeast1/jobs/pdf/executions/pdf-abc12' },
      }),
    );
    const jobs = cloudRunJobs({ project: () => 'materia-v2-dev', accessToken: async () => 'token-1', fetch });
    await expect(jobs.start('pdf', { orgId: 'org-1', jobId: 'job-1' })).resolves.toEqual({ executionId: 'pdf-abc12' });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://run.googleapis.com/v2/projects/materia-v2-dev/locations/australia-southeast1/jobs/pdf:run',
    );
    expect(init.headers).toMatchObject({ authorization: 'Bearer token-1' });
    expect(JSON.parse(init.body as string)).toEqual({
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: 'JOB_ORG_ID', value: 'org-1' },
              { name: 'JOB_ID', value: 'job-1' },
            ],
          },
        ],
      },
    });
  });

  it('falls back to the operation name when the execution is not in the metadata', async () => {
    const jobs = cloudRunJobs({
      project: () => 'p',
      accessToken: async () => 't',
      fetch: async () => Response.json({ name: 'operations/op-9' }),
    });
    await expect(jobs.start('pdf', { orgId: 'o', jobId: 'j' })).resolves.toEqual({ executionId: 'op-9' });
  });

  it('fails with UNAVAILABLE when the API refuses or no project is set', async () => {
    const refused = cloudRunJobs({
      project: () => 'p',
      accessToken: async () => 't',
      fetch: async () => new Response('denied', { status: 403 }),
    });
    await expect(refused.start('pdf', { orgId: 'o', jobId: 'j' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { status: 403 },
    });
    const noProject = cloudRunJobs({ project: () => undefined, accessToken: async () => 't' });
    await expect(noProject.start('pdf', { orgId: 'o', jobId: 'j' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
