export const PREMIUM_MEDIA_JOB_STATUSES = [
  'SUBMITTING_IMAGES',
  'GENERATING_IMAGES',
  'SUBMITTING_IMAGE_UPSCALE',
  'UPSCALING_IMAGE',
  'SUBMITTING_VIDEOS',
  'GENERATING_VIDEOS',
  'SUBMITTING_VIDEO_UPSCALE',
  'UPSCALING_VIDEO',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type PremiumMediaJobStatus = typeof PREMIUM_MEDIA_JOB_STATUSES[number];
export type PremiumMediaPurpose = 'IMAGE_GENERATION' | 'IMAGE_UPSCALE' | 'VIDEO_GENERATION' | 'VIDEO_UPSCALE';
export type PremiumMediaType = 'IMAGE' | 'VIDEO';
export type KieProviderApi = 'MARKET' | 'VEO';
export type PremiumMediaFundingMode = 'UNRESOLVED' | 'CUSTOMER_PREPAID' | 'PLATFORM_FUNDED';
export type PremiumMediaSubmissionState =
  | 'UNRESERVED'
  | 'RESERVED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'AMBIGUOUS'
  | 'REJECTED'
  | 'SETTLED';
export type PremiumMediaQualitySubmissionState = Exclude<PremiumMediaSubmissionState, 'UNRESERVED'> | 'NOT_STARTED';
export type PremiumMediaCandidateStatus =
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'PROVIDER_SUCCEEDED'
  | 'PROCESSING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'FAILED';

export type PremiumMediaReference = {
  source: 'upload' | 'product_media' | 'external';
  providerUrl: string;
  storageReference?: string | null;
  originalUrl?: string | null;
  mimeType?: string | null;
};

export type PremiumMediaJob = {
  id: string;
  workspaceId: string;
  productId: string;
  variantId: string | null;
  requestedBy: string | null;
  status: PremiumMediaJobStatus;
  aspectRatio: '1:1' | '16:9' | '9:16';
  creativeDirection: string | null;
  referenceAssets: PremiumMediaReference[];
  deliverImage: boolean;
  deliverVideo: boolean;
  imageRound: number;
  videoRound: number;
  maxRounds: number;
  imageQualityThreshold: number;
  videoQualityThreshold: number;
  selectedImageCandidateId: string | null;
  selectedVideoCandidateId: string | null;
  finalImageMediaId: string | null;
  finalVideoMediaId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PremiumMediaCandidate = {
  id: string;
  jobId: string;
  workspaceId: string;
  productId: string;
  variantId: string | null;
  purpose: PremiumMediaPurpose;
  mediaType: PremiumMediaType;
  model: string;
  providerApi: KieProviderApi;
  providerTaskId: string | null;
  reservationId: string | null;
  fundingMode: PremiumMediaFundingMode;
  providerSubmissionState: PremiumMediaSubmissionState;
  billingResolution: string | null;
  billingDurationSeconds: number | null;
  billingMaxCredits: string | number | null;
  callbackToken: string;
  status: PremiumMediaCandidateStatus;
  generationRound: number;
  prompt: string;
  referenceUrls: string[];
  resultUrls: string[];
  providerPayload: Record<string, unknown>;
  creditsConsumed: string | number | null;
  usageRecorded: boolean;
  qualityReservationId: string | null;
  qualityFundingMode: PremiumMediaFundingMode;
  qualitySubmissionState: PremiumMediaQualitySubmissionState;
  qualityProviderResponseId: string | null;
  qualityCreditsConsumed: string | number | null;
  qualityBillingResolution: string | null;
  qualityBillingDurationSeconds: number | null;
  qualityBillingMaxCredits: string | number | null;
  qualityUsageRecorded: boolean;
  qualityScore: number | null;
  qualityReport: Record<string, unknown> | null;
  storageReference: string | null;
  mimeType: string | null;
  productMediaId: string | null;
  processingAttempts: number;
  workerId: string | null;
  processingStartedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PremiumMediaJobView = Omit<PremiumMediaJob, 'referenceAssets'> & {
  referenceCount: number;
  candidates: Array<Omit<PremiumMediaCandidate, 'callbackToken' | 'providerPayload' | 'referenceUrls' | 'resultUrls'> & {
    resultCount: number;
  }>;
};
