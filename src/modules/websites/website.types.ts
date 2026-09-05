export type WebsiteProvider = 'wordpress' | 'webflow' | 'managed';
export type OwnershipMode = 'connected' | 'managed';
export type WebsiteStatus = 'draft' | 'connected' | 'generating' | 'preview' | 'publishing' | 'published' | 'error' | 'disconnected';
export type DomainStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'expired' | 'removed';
export type WebsiteJobStatus = 'queued' | 'planning' | 'generated' | 'preview' | 'publishing' | 'published' | 'failed' | 'cancelled';
export type WebsiteGenerationTargetMode = 'existing' | 'new';

export type WebsiteSite = {
  id: string;
  workspaceId: string;
  provider: WebsiteProvider;
  ownershipMode: OwnershipMode;
  name: string;
  externalSiteId: string | null;
  externalSiteUrl: string | null;
  status: WebsiteStatus;
  settings: Record<string, unknown>;
  domains: WebsiteDomain[];
  createdAt: string;
  updatedAt: string;
};

export type WebsiteDomain = {
  id: string;
  siteId: string;
  hostname: string;
  verificationToken: string;
  expiresAt: string;
  recordName: string;
  verificationMethod: 'dns_txt' | 'dns_cname';
  status: DomainStatus;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebsiteGenerationJob = {
  id: string;
  siteId: string;
  prompt: string;
  status: WebsiteJobStatus;
  plan: Record<string, unknown>;
  preview: Record<string, unknown>;
  providerResult: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  requestedLanguage: string | null;
  autoPublish: boolean;
  attemptCount: number;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebsiteGenerationWorkItem = WebsiteGenerationJob & {
  workspaceId: string;
  provider: WebsiteProvider;
  ownershipMode: OwnershipMode;
};
