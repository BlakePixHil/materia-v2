# Preview service image (CORE-12a, ADR-028): Node 22, LibreOffice headless (Office → PDF) and
# libheif's heif-convert (HEIC → JPEG), with metric-compatible fonts for Calibri, Cambria, Arial
# and Times so converted documents keep their layout. Runs as the non-root `node` user.
#
# Build from the bundle, not the repo:
#   pnpm nx build doc-services && docker build -f dist/apps/doc-services/docker/preview.Dockerfile -t materia-preview dist/apps/doc-services
FROM docker.io/library/node:22-bookworm-slim
ENV NODE_ENV=production \
    HOME=/tmp

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
    libheif-examples \
    fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
    ca-certificates \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY preview.js ./preview.js
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/preview.js"]
