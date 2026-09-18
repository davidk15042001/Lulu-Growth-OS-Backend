import 'dotenv/config';
import crypto from 'node:crypto';
import { getProviderAdapter, getProviderRuntimeReadiness } from '../src/modules/provider-control/provider-registry.js';

/**
 * Read-only live provider gate.
 *
 * This command is deliberately opt-in. It never sends a message, publishes a
 * campaign, writes a CMS object, or changes a provider account. It only calls
 * the adapter's verification/health/capability/discovery reads and fails when
 * the requested provider cannot prove readiness.
 */

type Capability = { capabilityKey?: string; status?: string };

function requestedProviders() {
  return (process.env.PROVIDER_LIVE_E2E_PROVIDERS ?? 'unifyport')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function context(providerKey: string) {
  return {
    connectionId: `live-readiness:${providerKey}`,
    providerKey,
    workspaceId: process.env.PROVIDER_LIVE_E2E_WORKSPACE_ID ?? crypto.randomUUID(),
    externalAccountId: process.env.PROVIDER_LIVE_E2E_EXTERNAL_ACCOUNT_ID ?? null,
    grantedScopes: [],
    metadata: {},
  };
}

function assertEnabled() {
  if (process.env.PROVIDER_LIVE_E2E !== '1') {
    throw new Error('Refusing live provider calls. Set PROVIDER_LIVE_E2E=1 explicitly.');
  }
}

async function check(providerKey: string) {
  const runtime = getProviderRuntimeReadiness(providerKey);
  if (!runtime.adapterRegistered) throw new Error(`${providerKey}: no registered adapter`);
  const adapter = getProviderAdapter(providerKey);
  const input = context(providerKey);
  const verification = await adapter.verifyConnection(input);
  const health = typeof adapter.getHealth === 'function' ? await adapter.getHealth(input) : null;
  const capabilities = typeof adapter.getCapabilities === 'function'
    ? await adapter.getCapabilities(input) as Capability[]
    : [];
  const accounts = typeof adapter.discoverAccounts === 'function' ? await adapter.discoverAccounts(input) : [];

  const unavailable = capabilities.filter((capability) => capability.status !== 'AVAILABLE');
  const result = {
    provider: providerKey,
    verified: verification.verified,
    verificationStatus: verification.status,
    healthStatus: health?.status ?? null,
    capabilityStatuses: capabilities.map((capability) => ({ key: capability.capabilityKey, status: capability.status })),
    discoveredAccounts: accounts.length,
  };
  console.log(JSON.stringify(result));

  if (!verification.verified) throw new Error(`${providerKey}: verification did not pass (${verification.status})`);
  if (health && health.status !== 'HEALTHY') throw new Error(`${providerKey}: health is ${health.status}`);
  if (unavailable.length > 0) {
    throw new Error(`${providerKey}: ${unavailable.length} capability check(s) are not AVAILABLE`);
  }
  return result;
}

assertEnabled();
const providers = requestedProviders();
if (providers.length === 0) throw new Error('No providers requested. Set PROVIDER_LIVE_E2E_PROVIDERS.');

for (const provider of providers) await check(provider);
console.log(JSON.stringify({ status: 'READY', providers }));
