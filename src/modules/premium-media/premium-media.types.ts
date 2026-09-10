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
  purpose: PremiumMediaPurpose;
  mediaType: PremiumMediaType;
  model: string;
  providerApi: KieProviderApi;
  providerTaskId: string | null;
  callbackToken: string;
  status: PremiumMediaCandidateStatus;
  generationRound: number;
  prompt: string;
  referenceUrls: string[];
  resultUrls: string[];
  providerPayload: Record<string, unknown>;
  creditsConsumed: string | number;
  usageRecorded: boolean;
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
