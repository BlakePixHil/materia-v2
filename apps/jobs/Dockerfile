# Placeholder image for the Cloud Run jobs (ADR-014). FND-24 finalises it.
# Build: pnpm nx build jobs && docker build -f apps/jobs/Dockerfile -t materia-jobs dist/apps/jobs
FROM docker.io/node:22-alpine

WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --prod --frozen-lockfile=false

USER node
ENTRYPOINT ["node", "main.js"]
