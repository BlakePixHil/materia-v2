#!/usr/bin/env bash
# Builds and deploys the Cloud Run document services (CORE-12a, ADR-028) from a doc-services
# bundle (`pnpm nx build doc-services`): the ClamAV scan service `clamav` and the preview service
# `preview`. Used by deploy.yml (every release) and scanner-signatures.yml (daily, clamav only).
#
#   deploy-doc-services.sh <bundle-dir> <image-tag> [clamav] [preview]
#
# Needs PROJECT and REGION, and gcloud authenticated as the deployer. Both services are private:
# only callers with roles/run.invoker (the functions runtime) can reach them. They scale to zero.
set -euo pipefail

bundle="$1"
tag="$2"
shift 2
services=("$@")
[ ${#services[@]} -gt 0 ] || services=(clamav preview)

registry="$REGION-docker.pkg.dev/$PROJECT/services"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

for service in "${services[@]}"; do
  case "$service" in
    clamav)
      dockerfile="$bundle/docker/scanner.Dockerfile"
      # clamd holds the signatures in memory (about 1 GiB); 4 scans at a time per instance.
      flags=(--cpu 1 --memory 2Gi --concurrency 4 --max-instances 2 --timeout 300)
      ;;
    preview)
      dockerfile="$bundle/docker/preview.Dockerfile"
      # One LibreOffice conversion per instance at a time.
      flags=(--cpu 2 --memory 2Gi --concurrency 1 --max-instances 3 --timeout 300)
      ;;
    *)
      echo "::error::Unknown service $service"
      exit 1
      ;;
  esac
  image="$registry/$service:$tag"
  # --pull: the scanner's base image and signatures, and Debian's security updates, are always current.
  docker build --pull -f "$dockerfile" -t "$image" "$bundle"
  docker push "$image"
  gcloud run deploy "$service" \
    --project "$PROJECT" \
    --region "$REGION" \
    --image "$image" \
    --service-account "$service-runtime@$PROJECT.iam.gserviceaccount.com" \
    --no-allow-unauthenticated \
    --ingress all \
    --execution-environment gen2 \
    --cpu-boost \
    --min-instances 0 \
    "${flags[@]}" \
    --labels "app=materia,release=${tag:0:12}" \
    --quiet
done
