import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

type DeploymentMetadata = {
  backend?: unknown;
  pushedAt?: unknown;
  deployedAt?: unknown;
};

export type PublicDeploymentInfo = {
  service: 'backend';
  commitSha: string | null;
  pushedAt: string | null;
  deployedAt: string | null;
  environment: string;
};

function validIso(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function validSha(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value) ? value : null;
}

export function getPublicDeploymentInfo(): PublicDeploymentInfo {
  const metadataPath = path.resolve(process.env.LULU_DEPLOYMENT_METADATA_FILE ?? path.join(process.cwd(), '.runtime-deployment.json'));
  let metadata: DeploymentMetadata = {};
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as DeploymentMetadata;
  } catch {
    // Local/test environments do not have deployment metadata.
  }

  return {
    service: 'backend',
    commitSha: validSha(metadata.backend),
    pushedAt: validIso(metadata.pushedAt),
    deployedAt: validIso(metadata.deployedAt),
    environment: env.NODE_ENV,
  };
}
