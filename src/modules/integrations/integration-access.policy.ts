const restrictedComposioToolkits = new Set([
  'whatsapp',
  'meta',
  'meta_ads',
  'metaads',
  'facebook_ads',
  'facebookads',
  'google_ads',
  'googleads',
  'linkedin',
  'linkedin_ads',
  'linkedinads',
]);

const restrictedWorkspaceProviders = new Set([
  'google-ads',
  'meta',
  'whatsapp',
  'linkedin',
]);

function normalized(value: string) {
  return value.trim().toLowerCase().replaceAll('-', '_');
}

export function isCustomerRestrictedComposioToolkit(value: string) {
  return restrictedComposioToolkits.has(normalized(value));
}

export function isCustomerRestrictedWorkspaceProvider(value: string) {
  const provider = value.trim().toLowerCase().replaceAll('_', '-');
  return restrictedWorkspaceProviders.has(provider);
}
