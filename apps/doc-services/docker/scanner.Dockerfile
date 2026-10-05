# ClamAV scan service image (CORE-12a, ADR-028): ClamAV's official Debian image, its signatures
# brought up to date by freshclam at build time, plus Node 22 for the HTTP wrapper. The image is
# rebuilt on every deploy and daily (scanner-signatures.yml), and freshclam also runs inside the
# container, so signatures are never more than a day old.
#
# Build from the bundle, not the repo:
#   pnpm nx build doc-services && docker build -f dist/apps/doc-services/docker/scanner.Dockerfile -t materia-clamav dist/apps/doc-services
FROM docker.io/library/node:22-bookworm-slim AS node

FROM docker.io/clamav/clamav-debian:stable
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY docker/clamd.conf docker/freshclam.conf /etc/clamav/
RUN mkdir -p /app && chown -R clamav:clamav /var/lib/clamav
USER clamav
# Today's signatures. A mirror outage keeps the base image's (freshclam retries when it runs).
RUN freshclam --foreground --stdout --config-file=/etc/clamav/freshclam.conf \
  || echo "warning: freshclam failed; using the base image's signatures"
COPY scanner.js /app/scanner.js

ENV NODE_ENV=production \
    CLAMD_SOCKET=/tmp/clamd.sock
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["node", "/app/scanner.js"]
