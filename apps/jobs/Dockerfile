# Cloud Run jobs image (ADR-014, FND-24): Node 22, Chromium (HTML → PDF), qpdf (merge, repair,
# linearise) and fonts (Geist ships in the bundle; DejaVu Sans is the fallback for any glyph Geist
# lacks). Runs as the non-root `node` user.
#
# Build from the bundle, not the repo:
#   pnpm nx build jobs && docker build -f apps/jobs/Dockerfile -t materia-jobs dist/apps/jobs
# Try it without Google Cloud: docker run --rm -v "$PWD/job:/work" materia-jobs pdf --local /work

# ---- dependencies: production node_modules from the bundle's pruned lockfile ----
FROM docker.io/library/node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile --ignore-scripts \
  && rm -rf /root/.cache /root/.local/share/pnpm

# ---- runtime ----
FROM docker.io/library/node:22-bookworm-slim
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    STAMP_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium qpdf fonts-dejavu-core ca-certificates \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY main.js package.json ./
COPY templates ./templates
COPY fonts ./fonts

USER node
ENTRYPOINT ["node", "main.js"]
