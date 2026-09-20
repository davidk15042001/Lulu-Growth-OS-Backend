import fs from 'node:fs/promises';

const manifestFile = process.env.RELEASE_MANIFEST_FILE;
const manifestUrl = process.env.RELEASE_MANIFEST_URL;
const expectedBackend = process.env.EXPECTED_BACKEND_SHA?.trim();
const expectedFrontend = process.env.EXPECTED_FRONTEND_SHA?.trim();
const healthUrl = process.env.CANARY_HEALTH_URL?.trim();
const readyUrl = process.env.CANARY_READY_URL?.trim();
const strict = process.env.RELEASE_GATE_STRICT === '1';
const failures = [];

async function readManifest() {
  if (manifestFile) return JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifestUrl) {
    const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Release manifest returned HTTP ${response.status}`);
    return response.json();
  }
  return null;
}

let manifest = null;
try {
  manifest = await readManifest();
} catch (error) {
  failures.push(`Unable to read release manifest: ${error instanceof Error ? error.message : String(error)}`);
}
if (!manifest) failures.push('A release manifest file or URL is required');
if (expectedBackend && manifest?.backend?.sha !== expectedBackend) failures.push('Backend SHA does not match the expected release');
if (expectedFrontend && manifest?.frontend?.sha !== expectedFrontend) failures.push('Frontend SHA does not match the expected release');
if (strict && !healthUrl) failures.push('CANARY_HEALTH_URL is required in strict mode');
if (strict && !readyUrl) failures.push('CANARY_READY_URL is required in strict mode');

async function checkEndpoint(url, label, expectReady = false) {
  if (!url) return;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      failures.push(`${label} returned HTTP ${response.status}`);
      return;
    }
    if (expectReady) {
      const payload = await response.json();
      if (payload?.data?.ready !== true) failures.push(`${label} did not report ready=true`);
    }
  } catch (error) {
    failures.push(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
await checkEndpoint(healthUrl, 'Canary health');
await checkEndpoint(readyUrl, 'Canary readiness', true);

const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  strict,
  manifest,
  canary: { healthUrl: healthUrl ?? null, readyUrl: readyUrl ?? null },
  failures,
  note: 'This gate validates an already deployed canary; it does not shift traffic or perform rollback itself.',
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;

