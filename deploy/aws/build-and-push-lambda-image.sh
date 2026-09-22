#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-central-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-234371409675}"
REPOSITORY_NAME="${REPOSITORY_NAME:-lulu-growth-os-backend-lambda}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPOSITORY_NAME}"

aws ecr describe-repositories \
  --region "$AWS_REGION" \
  --repository-names "$REPOSITORY_NAME" >/dev/null 2>&1 \
  || aws ecr create-repository \
    --region "$AWS_REGION" \
    --repository-name "$REPOSITORY_NAME" \
    --image-scanning-configuration scanOnPush=true >/dev/null

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker build -f Dockerfile.lambda -t "${IMAGE_URI}:${IMAGE_TAG}" -t "${IMAGE_URI}:latest" .
docker push "${IMAGE_URI}:${IMAGE_TAG}"
docker push "${IMAGE_URI}:latest"

echo "IMAGE_URI=${IMAGE_URI}:${IMAGE_TAG}"
echo "LATEST_IMAGE_URI=${IMAGE_URI}:latest"
