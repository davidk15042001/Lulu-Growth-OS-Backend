import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

export const SOCIAL_EVENT_TYPES = {
  ACCOUNT_CREATED: DOMAIN_EVENT_TYPES.SOCIAL_ACCOUNT_CREATED,
  ACCOUNT_VERIFIED: DOMAIN_EVENT_TYPES.SOCIAL_ACCOUNT_VERIFIED,
  ACCOUNT_BLOCKED: DOMAIN_EVENT_TYPES.SOCIAL_ACCOUNT_BLOCKED,
  CONTENT_CREATED: DOMAIN_EVENT_TYPES.SOCIAL_CONTENT_CREATED,
  CONTENT_UPDATED: DOMAIN_EVENT_TYPES.SOCIAL_CONTENT_UPDATED,
  PUBLICATION_CREATED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_CREATED,
  PUBLICATION_QUEUED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_QUEUED,
  PUBLICATION_RETRY_SCHEDULED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_RETRY_SCHEDULED,
  PUBLICATION_PUBLISHED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_PUBLISHED,
  PUBLICATION_FAILED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_FAILED,
  PUBLICATION_BLOCKED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_BLOCKED,
  PUBLICATION_CANCELLED: DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_CANCELLED,
} as const;

export type SocialProvider = 'FACEBOOK' | 'INSTAGRAM';
export type SocialAccountStatus = 'AVAILABLE' | 'BLOCKED' | 'UNAVAILABLE';
export type SocialContentType = 'TEXT' | 'LINK' | 'IMAGE';
export type SocialContentStatus = 'DRAFT' | 'READY' | 'ARCHIVED';
export type SocialPublicationStatus =
  | 'DRAFT' | 'SCHEDULED' | 'QUEUED' | 'PUBLISHING'
  | 'PUBLISHED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
export type SocialPublicationAttemptStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'DEAD_LETTER';
export type SocialActorType = 'USER' | 'AI_AGENT' | 'WORKFLOW' | 'SYSTEM' | 'ADMIN';

export type SocialAccount = {
  id: string;
  workspaceId: string;
  providerConnectionId: string;
  provider: SocialProvider;
  displayName: string;
  facebookPageId: string;
  instagramBusinessAccountId: string | null;
  providerUsername: string | null;
  status: SocialAccountStatus;
  statusReason: string;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type SocialContent = {
  id: string;
  workspaceId: string;
  contentType: SocialContentType;
  status: SocialContentStatus;
  message: string;
  linkUrl: string | null;
  mediaUrl: string | null;
  altText: string | null;
  metadata: Record<string, unknown>;
  version: number;
  createdByActorType: SocialActorType;
  createdByActorRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialPublicationAttempt = {
  id: string;
  attemptNumber: number;
  status: SocialPublicationAttemptStatus;
  workerId: string;
  requestSummary: Record<string, unknown>;
  responseSummary: Record<string, unknown> | null;
  providerRequestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type SocialPublicationJob = {
  id: string;
  workspaceId: string;
  socialAccountId: string;
  contentId: string;
  status: SocialPublicationStatus;
  scheduledAt: string | null;
  availableAt: string;
  providerPublicationId: string | null;
  providerPermalink: string | null;
  attemptCount: number;
  maxAttempts: number;
  publishedAt: string | null;
  finishedAt: string | null;
  blockCode: string | null;
  blockMessage: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  version: number;
  createdByActorType: SocialActorType;
  createdByActorRef: string | null;
  executionActorType: SocialActorType;
  executionActorRef: string | null;
  lastTransitionActorType: SocialActorType;
  lastTransitionActorRef: string | null;
  lastTransitionActorId: string | null;
  createdAt: string;
  updatedAt: string;
  account?: SocialAccount;
  content?: SocialContent;
  attempts?: SocialPublicationAttempt[];
};

export type ClaimedSocialPublication = SocialPublicationJob & {
  workerId: string;
  attemptId: string;
  account: SocialAccount;
  content: SocialContent;
};

export type SocialProviderContext = {
  connectionId: string;
  providerKey: 'facebook' | 'instagram';
  connectionStatus: string;
  authorizationState: string;
  sourceType: string | null;
  grantedScopes: string[];
  sharedGrantedCapabilities: string[] | null;
  encryptedAccessToken: string | null;
  tokenExpiresAt: string | null;
  credentialStatus: string | null;
};

export const SOCIAL_WORKER_DEFAULTS = {
  intervalMs: 5_000,
  leaseSeconds: 120,
  maxBatchSize: 10,
} as const;
