import { AppError } from '../../utils/app-error.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import { buildAuthorizationUrl } from '../onboarding/oauth.service.js';
import * as repo from './workspace-app.repo.js';
import { loadGoogleBusinessDirectory } from './google-reviews.service.js';

const GOOGLE_BUSINESS_PROVIDER = 'google-business' as const;
const DEFAULT_GOOGLE_BUSINESS_RETURN_TO = '/app/fresh-tide-9404';

function findGoogleBusinessPlatform(platforms: Awaited<ReturnType<typeof onboardingRepo.listPlatforms>>) {
  return platforms.find((platform) => platform.integrationKey === GOOGLE_BUSINESS_PROVIDER) ?? null;
}

function defaultNextSteps(connected: boolean, hasLocations: boolean, apiReachable: boolean) {
  if (!connected) {
    return [
      'Start the Google Business OAuth flow for the correct workspace owner account.',
      'Approve the business.manage scope so locations, reviews, and replies can be accessed.',
      'Open Reviews after the connection is complete to verify that locations and review data load.',
    ];
  }
  if (!apiReachable) {
    return [
      'Reconnect Google Business because the saved OAuth credential is no longer accepted.',
      'Verify that the connected Google account still has Business Profile access for the target locations.',
      'Retry the Google Business sync after reauthorization.',
    ];
  }
  if (!hasLocations) {
    return [
      'Check that the connected Google account can see the expected Business Profile locations.',
      'Confirm that the right Google Business account was connected for this workspace.',
      'Reconnect if the wrong Google user granted access.',
    ];
  }
  return [
    'Use Reviews to prioritize unanswered and negative reviews.',
    'Run a sync after new Google Business activity to refresh downstream data.',
    'Keep the workspace connected so Google Business automations stay available.',
  ];
}

export async function getGoogleBusinessOverview(workspaceId: string) {
  const platforms = await onboardingRepo.listPlatforms(workspaceId);
  const platform = findGoogleBusinessPlatform(platforms);

  if (!platform) {
    return {
      provider: GOOGLE_BUSINESS_PROVIDER,
      connected: false,
      platformId: null,
      connectionStatus: 'not_connected',
      platformName: 'Google Business',
      category: 'digital-appearance',
      externalAccountId: null,
      grantedScopes: [],
      lastSyncedAt: null,
      lastError: null,
      generatedAt: new Date().toISOString(),
      apiReachable: false,
      reauthRequired: false,
      accounts: [],
      locations: [],
      summary: {
        accountCount: 0,
        locationCount: 0,
      },
      nextSteps: defaultNextSteps(false, false, false),
    };
  }

  try {
    const directory = await loadGoogleBusinessDirectory(workspaceId);
    const locationCountByAccount = new Map<string, number>();
    for (const location of directory.locations) {
      locationCountByAccount.set(location.accountId, (locationCountByAccount.get(location.accountId) ?? 0) + 1);
    }
    return {
      provider: GOOGLE_BUSINESS_PROVIDER,
      connected: true,
      platformId: platform.id,
      connectionStatus: platform.connectionStatus,
      platformName: platform.name,
      category: platform.category,
      externalAccountId: platform.externalAccountId,
      grantedScopes: platform.grantedScopes,
      lastSyncedAt: platform.lastSyncedAt,
      lastError: platform.lastError,
      generatedAt: new Date().toISOString(),
      apiReachable: true,
      reauthRequired: false,
      accounts: directory.accounts.map((account) => ({
        ...account,
        locationCount: locationCountByAccount.get(account.id) ?? 0,
      })),
      locations: directory.locations.map((location) => ({
        accountId: location.accountId,
        id: location.id,
        title: location.title,
        address: location.address,
        storeCode: location.storeCode,
        websiteUrl: location.websiteUrl,
      })),
      summary: {
        accountCount: directory.accounts.length,
        locationCount: directory.locations.length,
      },
      nextSteps: defaultNextSteps(true, directory.locations.length > 0, true),
    };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    const reauthRequired = appError?.code === 'GOOGLE_BUSINESS_REAUTH_REQUIRED' || appError?.code === 'OAUTH_REFRESH_TOKEN_MISSING';
    return {
      provider: GOOGLE_BUSINESS_PROVIDER,
      connected: true,
      platformId: platform.id,
      connectionStatus: reauthRequired ? 'reauthorization_required' : platform.connectionStatus,
      platformName: platform.name,
      category: platform.category,
      externalAccountId: platform.externalAccountId,
      grantedScopes: platform.grantedScopes,
      lastSyncedAt: platform.lastSyncedAt,
      lastError: appError?.message ?? platform.lastError ?? 'Google Business data could not be loaded.',
      generatedAt: new Date().toISOString(),
      apiReachable: false,
      reauthRequired,
      accounts: [],
      locations: [],
      summary: {
        accountCount: 0,
        locationCount: 0,
      },
      nextSteps: defaultNextSteps(true, false, false),
    };
  }
}

export function createGoogleBusinessAuthorization(workspaceId: string, userId: string, input: { returnTo?: string | undefined }) {
  return {
    provider: GOOGLE_BUSINESS_PROVIDER,
    authorizationUrl: buildAuthorizationUrl(
      GOOGLE_BUSINESS_PROVIDER,
      workspaceId,
      userId,
      undefined,
      input.returnTo ?? DEFAULT_GOOGLE_BUSINESS_RETURN_TO,
    ),
  };
}

export async function disconnectGoogleBusiness(workspaceId: string) {
  const platforms = await onboardingRepo.listPlatforms(workspaceId);
  const platform = findGoogleBusinessPlatform(platforms);
  if (!platform) {
    return {
      provider: GOOGLE_BUSINESS_PROVIDER,
      platformId: null,
      connected: false,
      status: 'not_connected',
    };
  }
  await onboardingRepo.archivePlatformByIntegration(
    workspaceId,
    GOOGLE_BUSINESS_PROVIDER,
    'Disconnected from Google Business workspace controls.',
  );
  return {
    provider: GOOGLE_BUSINESS_PROVIDER,
    platformId: platform.id,
    connected: false,
    status: 'disconnected',
  };
}

export async function syncGoogleBusiness(workspaceId: string) {
  const platforms = await onboardingRepo.listPlatforms(workspaceId);
  const platform = findGoogleBusinessPlatform(platforms);
  if (!platform) {
    throw new AppError(409, 'GOOGLE_BUSINESS_NOT_CONNECTED', 'Google Business is not connected for this workspace');
  }
  const run = await repo.queueIntegrationSync(workspaceId, platform.id);
  if (!run) {
    throw new AppError(404, 'GOOGLE_BUSINESS_SYNC_PLATFORM_NOT_FOUND', 'The Google Business integration could not be queued for sync');
  }
  return run;
}
