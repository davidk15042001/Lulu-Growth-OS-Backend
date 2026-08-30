import { hasAiProvider } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import * as workspaceService from '../workspaces/workspace.service.js';

export type GoogleAccount = {
  id: string;
  name: string;
  type: string | null;
};

export type GoogleLocation = {
  accountId: string;
  id: string;
  title: string;
  name: string;
  storeCode: string | null;
  websiteUrl: string | null;
  address: string;
};

type TopicCount = {
  topic: string;
  count: number;
};

type GoogleReviewReply = {
  comment: string;
  updateTime: string | null;
};

export type GoogleReviewManagerReview = {
  id: string;
  name: string;
  accountId: string;
  locationId: string;
  locationTitle: string;
  locationAddress: string;
  starRating: number;
  comment: string;
  reviewerDisplayName: string;
  reviewerIsAnonymous: boolean;
  createTime: string | null;
  updateTime: string | null;
  sentiment: 'positive' | 'mixed' | 'negative';
  urgency: 'critical' | 'high' | 'medium' | 'low';
  topics: string[];
  verifiedFacts: string[];
  inferredIssues: string[];
  recommendedActions: string[];
  summary: string;
  suggestedReply: string;
  requiresHuman: boolean;
  reviewReply: GoogleReviewReply | null;
};

export type GoogleReviewManagerResponse = {
  connected: boolean;
  platformId: string | null;
  aiAvailable: boolean;
  generatedAt: string;
  accounts: GoogleAccount[];
  locations: Array<{
    accountId: string;
    id: string;
    title: string;
    address: string;
    storeCode: string | null;
    websiteUrl: string | null;
    totalReviewCount: number;
    averageRating: number | null;
    unansweredCount: number;
    negativeCount: number;
  }>;
  summary: {
    totalReviews: number;
    averageRating: number | null;
    replyRate: number;
    unansweredCount: number;
    negativeCount: number;
    mixedCount: number;
    positiveCount: number;
    priorityReviewCount: number;
  };
  insights: {
    headline: string;
    topTopics: TopicCount[];
    strengths: string[];
    risks: string[];
    recommendedActions: string[];
    dataGaps: string[];
  };
  reviews: GoogleReviewManagerReview[];
};

const negativeWords = ['bad', 'poor', 'terrible', 'awful', 'slow', 'late', 'broken', 'refund', 'problem', 'issue', 'disappointed', 'unprofessional', 'rude'];
const positiveWords = ['great', 'excellent', 'amazing', 'helpful', 'friendly', 'fast', 'perfect', 'recommend', 'love', 'smooth', 'professional'];

const topicMatchers: Array<{ topic: string; patterns: RegExp[] }> = [
  { topic: 'Service quality', patterns: [/\bservice\b/i, /\bsupport\b/i, /\bstaff\b/i, /\bteam\b/i, /\bhelpful\b/i, /\brude\b/i] },
  { topic: 'Response speed', patterns: [/\bslow\b/i, /\bfast\b/i, /\bwait\b/i, /\bdelay\b/i, /\bresponse\b/i, /\btime\b/i] },
  { topic: 'Product quality', patterns: [/\bquality\b/i, /\bbug\b/i, /\bbroken\b/i, /\bissue\b/i, /\bdefect\b/i] },
  { topic: 'Pricing', patterns: [/\bprice\b/i, /\bcost\b/i, /\bexpensive\b/i, /\bcheap\b/i, /\bvalue\b/i] },
  { topic: 'Communication', patterns: [/\bcommunicat/i, /\bexplained\b/i, /\bclarity\b/i, /\bunclear\b/i, /\bcontact\b/i] },
  { topic: 'Onboarding', patterns: [/\bonboarding\b/i, /\bsetup\b/i, /\bimplementation\b/i, /\btraining\b/i] },
  { topic: 'Results', patterns: [/\bresult\b/i, /\boutcome\b/i, /\bimprovement\b/i, /\bgrowth\b/i, /\bconversion\b/i] },
];

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIso(value: unknown) {
  const raw = stringValue(value);
  return raw || null;
}

function compactAddress(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const parts = [
    stringValue(record.addressLines && Array.isArray(record.addressLines) ? record.addressLines.join(', ') : ''),
    stringValue(record.locality),
    stringValue(record.administrativeArea),
    stringValue(record.postalCode),
    stringValue(record.regionCode),
  ].filter(Boolean);
  return parts.join(', ');
}

function normalizeRating(value: unknown) {
  if (typeof value === 'number') return Math.max(1, Math.min(5, Math.round(value)));
  const raw = stringValue(value).toUpperCase();
  if (raw === 'ONE') return 1;
  if (raw === 'TWO') return 2;
  if (raw === 'THREE') return 3;
  if (raw === 'FOUR') return 4;
  if (raw === 'FIVE') return 5;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return Math.max(1, Math.min(5, Math.round(numeric)));
  return 0;
}

function topicList(text: string) {
  const matches = topicMatchers
    .filter((entry) => entry.patterns.some((pattern) => pattern.test(text)))
    .map((entry) => entry.topic);
  return matches.length ? matches : ['General experience'];
}

function sentimentFromReview(rating: number, text: string) {
  const lower = text.toLowerCase();
  const negativeHits = negativeWords.filter((word) => lower.includes(word)).length;
  const positiveHits = positiveWords.filter((word) => lower.includes(word)).length;
  if (rating <= 2 || negativeHits > positiveHits + 1) return 'negative';
  if (rating === 3 || (negativeHits > 0 && positiveHits > 0)) return 'mixed';
  return 'positive';
}

function urgencyFromReview(rating: number, sentiment: 'positive' | 'mixed' | 'negative', hasReply: boolean) {
  if (!hasReply && rating <= 2) return 'critical';
  if (!hasReply && sentiment === 'negative') return 'high';
  if (!hasReply && sentiment === 'mixed') return 'medium';
  if (hasReply && sentiment === 'negative') return 'medium';
  return 'low';
}

function summarizeReview(rating: number, sentiment: 'positive' | 'mixed' | 'negative', topics: string[], comment: string) {
  const preview = comment.replace(/\s+/g, ' ').trim().slice(0, 180);
  const sentimentLabel = sentiment === 'positive' ? 'positive' : sentiment === 'negative' ? 'critical' : 'mixed';
  return `${rating}-star ${sentimentLabel} review focused on ${topics.slice(0, 2).join(' and ')}.${preview ? ` "${preview}${preview.length >= 180 ? '…' : ''}"` : ''}`;
}

function buildSuggestedReply(companyName: string, reviewerName: string, sentiment: 'positive' | 'mixed' | 'negative', topics: string[], comment: string) {
  const name = reviewerName && reviewerName.toLowerCase() !== 'anonymous' ? reviewerName : 'there';
  const primaryTopic = topics[0] ?? 'your experience';
  if (sentiment === 'positive') {
    return `Hi ${name}, thank you for your review and for highlighting ${primaryTopic.toLowerCase()}. We appreciate the trust in ${companyName} and look forward to supporting you again.`;
  }
  if (sentiment === 'mixed') {
    return `Hi ${name}, thank you for the honest feedback. We are glad you shared your experience around ${primaryTopic.toLowerCase()}, and we are reviewing the details internally so we can improve the next interaction.`;
  }
  const mention = comment ? 'We are sorry that your experience did not meet expectations.' : `We are sorry to hear about the issue around ${primaryTopic.toLowerCase()}.`;
  return `Hi ${name}, thank you for raising this. ${mention} Please reply here or contact us directly so ${companyName} can review the case and make it right quickly.`;
}

function inferredIssues(sentiment: 'positive' | 'mixed' | 'negative', topics: string[], hasReply: boolean) {
  const issues: string[] = [];
  if (sentiment === 'negative') issues.push('The reviewer signals churn or trust risk.');
  if (sentiment === 'mixed') issues.push('The reviewer sees partial value but not a fully smooth experience.');
  if (!hasReply) issues.push('The conversation is still open publicly because no owner reply is visible.');
  if (topics.includes('Response speed')) issues.push('Speed of response may be hurting perceived reliability.');
  if (topics.includes('Communication')) issues.push('Expectation-setting and explanation quality likely need work.');
  if (topics.includes('Pricing')) issues.push('Perceived value versus price may need stronger framing.');
  return issues;
}

function recommendedActions(sentiment: 'positive' | 'mixed' | 'negative', topics: string[], hasReply: boolean) {
  const actions: string[] = [];
  if (!hasReply) actions.push('Post an owner reply.');
  if (sentiment !== 'positive') actions.push('Route the review into a service-recovery workflow.');
  if (topics.includes('Service quality')) actions.push('Review the responsible service delivery touchpoint.');
  if (topics.includes('Response speed')) actions.push('Tighten SLA and first-response monitoring.');
  if (topics.includes('Communication')) actions.push('Improve messaging and expectation-setting scripts.');
  if (topics.includes('Pricing')) actions.push('Clarify ROI and package boundaries in the sales journey.');
  if (!actions.length) actions.push('Ask for more detail and capture the feedback as a proof point.');
  return actions.slice(0, 3);
}

function average(values: number[]) {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function countTopics(reviews: GoogleReviewManagerReview[]) {
  const counts = new Map<string, number>();
  for (const review of reviews) {
    for (const topic of review.topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([topic, count]) => ({ topic, count }));
}

function buildHeadline(companyName: string, totalReviews: number, averageRatingValue: number | null, unansweredCount: number, negativeCount: number) {
  if (totalReviews === 0) return `${companyName} has no Google review data available yet.`;
  if ((averageRatingValue ?? 0) >= 4.5 && unansweredCount <= 2) return `${companyName} has strong review health, but there is still room to turn recent praise into more public proof.`;
  if (negativeCount > 0 && unansweredCount > 0) return `${companyName} has public reputation risk because negative reviews remain unanswered.`;
  return `${companyName} has active review activity that should be managed systematically across locations.`;
}

function emptyGoogleReviewsResponse(platformId: string | null, headline: string, risks: string[], recommendedActions: string[], dataGaps: string[]): GoogleReviewManagerResponse {
  return {
    connected: Boolean(platformId),
    platformId,
    aiAvailable: hasAiProvider,
    generatedAt: new Date().toISOString(),
    accounts: [],
    locations: [],
    summary: {
      totalReviews: 0,
      averageRating: null,
      replyRate: 0,
      unansweredCount: 0,
      negativeCount: 0,
      mixedCount: 0,
      positiveCount: 0,
      priorityReviewCount: 0,
    },
    insights: {
      headline,
      topTopics: [],
      strengths: [],
      risks,
      recommendedActions,
      dataGaps,
    },
    reviews: [],
  };
}

async function getGoogleBusinessToken(workspaceId: string) {
  const credential = await onboardingRepo.getPlatformOAuthCredential(workspaceId, 'google-business');
  if (!credential) throw new AppError(409, 'GOOGLE_BUSINESS_NOT_CONNECTED', 'Google Business is not connected for this workspace');
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : 0;
  if (credential.encryptedRefreshToken && expiresAt && expiresAt <= Date.now() + 60_000) {
    return {
      platformId: credential.platformId,
      token: await refreshStoredOAuthCredential({
        workspaceId,
        provider: 'google-business',
        encryptedRefreshToken: credential.encryptedRefreshToken,
      }),
    };
  }
  return {
    platformId: credential.platformId,
    token: decryptSecret(credential.encryptedAccessToken),
  };
}

async function googleJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = stringValue(payload.error && typeof payload.error === 'object' ? (payload.error as Record<string, unknown>).message : payload.message) || 'Google Business rejected the request';
    throw new AppError(
      response.status === 401 ? 401 : 502,
      response.status === 401 ? 'GOOGLE_BUSINESS_REAUTH_REQUIRED' : 'GOOGLE_BUSINESS_API_ERROR',
      message,
      { providerHttpStatus: response.status },
    );
  }
  return payload as T;
}

async function listAccounts(token: string) {
  const data = await googleJson<{ accounts?: Array<Record<string, unknown>> }>(
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
    token,
  );
  return (data.accounts ?? [])
    .map((account) => ({
      id: stringValue(account.name).split('/').pop() ?? '',
      name: stringValue(account.accountName) || stringValue(account.name),
      type: stringValue(account.type) || null,
    }))
    .filter((account) => account.id);
}

async function listLocations(accountId: string, token: string) {
  const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations`);
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('readMask', 'name,title,storeCode,websiteUri,storefrontAddress');
  const data = await googleJson<{ locations?: Array<Record<string, unknown>> }>(url.toString(), token);
  return (data.locations ?? [])
    .map((location) => {
      const name = stringValue(location.name);
      const id = name.split('/').pop() ?? '';
      return {
        accountId,
        id,
        name,
        title: stringValue(location.title) || 'Untitled location',
        storeCode: stringValue(location.storeCode) || null,
        websiteUrl: stringValue(location.websiteUri) || null,
        address: compactAddress(location.storefrontAddress),
      } satisfies GoogleLocation;
    })
    .filter((location) => location.id);
}

export async function loadGoogleBusinessDirectory(workspaceId: string) {
  const { platformId, token } = await getGoogleBusinessToken(workspaceId);
  const accounts = await listAccounts(token);
  const locationBatches = await Promise.all(accounts.map((account) => listLocations(account.id, token)));
  return {
    platformId,
    token,
    accounts,
    locations: locationBatches.flat(),
  };
}

async function listReviews(location: GoogleLocation, token: string) {
  const url = new URL(`https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(location.accountId)}/locations/${encodeURIComponent(location.id)}/reviews`);
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('orderBy', 'updateTime desc');
  return googleJson<{
    reviews?: Array<Record<string, unknown>>;
    averageRating?: number;
    totalReviewCount?: number;
  }>(url.toString(), token);
}

function buildReview(companyName: string, location: GoogleLocation, review: Record<string, unknown>): GoogleReviewManagerReview {
  const name = stringValue(review.name);
  const id = name.split('/').pop() ?? '';
  const comment = stringValue(review.comment);
  const reviewer = review.reviewer && typeof review.reviewer === 'object' ? review.reviewer as Record<string, unknown> : {};
  const reply = review.reviewReply && typeof review.reviewReply === 'object' ? review.reviewReply as Record<string, unknown> : null;
  const starRating = normalizeRating(review.starRating);
  const sentiment = sentimentFromReview(starRating, comment);
  const hasReply = Boolean(reply && stringValue(reply.comment));
  const topics = topicList(comment.toLowerCase());
  const urgency = urgencyFromReview(starRating, sentiment, hasReply);
  const reviewerDisplayName = stringValue(reviewer.displayName) || 'Anonymous';
  return {
    id,
    name,
    accountId: location.accountId,
    locationId: location.id,
    locationTitle: location.title,
    locationAddress: location.address,
    starRating,
    comment,
    reviewerDisplayName,
    reviewerIsAnonymous: Boolean(reviewer.isAnonymous),
    createTime: toIso(review.createTime),
    updateTime: toIso(review.updateTime),
    sentiment,
    urgency,
    topics,
    verifiedFacts: [
      `${starRating || 0}-star Google review`,
      location.title ? `Location: ${location.title}` : '',
      comment ? 'Public comment is available' : 'No public comment text is available',
      hasReply ? 'Owner reply already exists' : 'No owner reply exists yet',
    ].filter(Boolean),
    inferredIssues: inferredIssues(sentiment, topics, hasReply),
    recommendedActions: recommendedActions(sentiment, topics, hasReply),
    summary: summarizeReview(starRating, sentiment, topics, comment),
    suggestedReply: buildSuggestedReply(companyName, reviewerDisplayName, sentiment, topics, comment),
    requiresHuman: urgency === 'critical' || topics.includes('Pricing'),
    reviewReply: hasReply ? { comment: stringValue(reply?.comment), updateTime: toIso(reply?.updateTime) } : null,
  };
}

export async function getGoogleReviewsManager(workspaceId: string, userId: string, input: { locationId?: string | undefined; limit: number }): Promise<GoogleReviewManagerResponse> {
  const workspace = await workspaceService.getWorkspace(workspaceId, userId);
  let platformId: string | null = null;
  let accounts: GoogleAccount[] = [];
  let allLocations: GoogleLocation[] = [];
  let token: string;
  try {
    const directory = await loadGoogleBusinessDirectory(workspaceId);
    platformId = directory.platformId;
    token = directory.token;
    accounts = directory.accounts;
    allLocations = directory.locations.filter((location) => !input.locationId || location.id === input.locationId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'GOOGLE_BUSINESS_NOT_CONNECTED') {
      return emptyGoogleReviewsResponse(
        null,
        'Google Business is not connected yet for this workspace.',
        ['No Google Business Profile connection is available yet.'],
        ['Connect the correct Google Business account to load locations, reviews and reply workflows.'],
        ['No Google Business OAuth credential exists for this workspace.'],
      );
    }
    throw error;
  }
  if (!accounts.length) {
    return emptyGoogleReviewsResponse(
      platformId,
      'Google Business is connected, but no managed Business Profile accounts were returned.',
      ['No Google Business Profile accounts are visible for the connected user.'],
      ['Reconnect the correct Google Business account or verify location access.'],
      ['No account-level Google Business access could be confirmed.'],
    );
  }

  const reviewPayloads = await Promise.all(allLocations.map(async (location) => ({
    location,
    payload: await listReviews(location, token),
  })));

  const companyName = workspace.companyName.trim() || 'your business';
  const reviews = reviewPayloads
    .flatMap(({ location, payload }) => (payload.reviews ?? []).map((review) => buildReview(companyName, location, review)))
    .sort((left, right) => Date.parse(right.updateTime ?? right.createTime ?? '') - Date.parse(left.updateTime ?? left.createTime ?? ''))
    .slice(0, input.limit);

  const unansweredCount = reviews.filter((review) => !review.reviewReply).length;
  const negativeCount = reviews.filter((review) => review.sentiment === 'negative').length;
  const mixedCount = reviews.filter((review) => review.sentiment === 'mixed').length;
  const positiveCount = reviews.filter((review) => review.sentiment === 'positive').length;
  const priorityReviewCount = reviews.filter((review) => review.urgency === 'critical' || review.urgency === 'high').length;
  const replyRate = reviews.length ? Math.round(((reviews.length - unansweredCount) / reviews.length) * 100) : 0;
  const averageRatingValue = average(reviews.map((review) => review.starRating).filter((rating) => rating > 0));
  const topTopics = countTopics(reviews);
  const strengths = positiveCount > 0
    ? [`${positiveCount} reviews are currently positive and can be reused as public trust signals.`]
    : [];
  const risks = [
    ...(negativeCount > 0 ? [`${negativeCount} reviews are negative and need active recovery.`] : []),
    ...(unansweredCount > 0 ? [`${unansweredCount} reviews still do not have an owner reply.`] : []),
  ];
  const recommendedActions = [
    ...(priorityReviewCount > 0 ? [`Reply to the ${priorityReviewCount} highest-priority reviews first.`] : []),
    ...(topTopics[0] ? [`Audit the recurring topic "${topTopics[0].topic}" across affected locations.`] : []),
    ...(replyRate < 85 ? ['Raise review reply coverage above 85% to improve public trust.'] : []),
  ].slice(0, 4);
  const dataGaps = [
    ...(reviews.some((review) => !review.comment) ? ['Some reviews have no public comment text, so issue classification is weaker.'] : []),
    ...(allLocations.length === 0 ? ['No accessible Business Profile locations were returned.'] : []),
  ];

  return {
    connected: true,
    platformId,
    aiAvailable: hasAiProvider,
    generatedAt: new Date().toISOString(),
    accounts,
    locations: reviewPayloads.map(({ location, payload }) => {
      const locationReviews = reviews.filter((review) => review.locationId === location.id);
      return {
        accountId: location.accountId,
        id: location.id,
        title: location.title,
        address: location.address,
        storeCode: location.storeCode,
        websiteUrl: location.websiteUrl,
        totalReviewCount: numberValue(payload.totalReviewCount) ?? locationReviews.length,
        averageRating: numberValue(payload.averageRating),
        unansweredCount: locationReviews.filter((review) => !review.reviewReply).length,
        negativeCount: locationReviews.filter((review) => review.sentiment === 'negative').length,
      };
    }),
    summary: {
      totalReviews: reviews.length,
      averageRating: averageRatingValue,
      replyRate,
      unansweredCount,
      negativeCount,
      mixedCount,
      positiveCount,
      priorityReviewCount,
    },
    insights: {
      headline: buildHeadline(companyName, reviews.length, averageRatingValue, unansweredCount, negativeCount),
      topTopics,
      strengths,
      risks,
      recommendedActions,
      dataGaps,
    },
    reviews,
  };
}

export async function updateGoogleReviewReply(
  workspaceId: string,
  reviewId: string,
  input: { accountId: string; locationId: string; comment: string },
) {
  const { token } = await getGoogleBusinessToken(workspaceId);
  const name = `accounts/${input.accountId}/locations/${input.locationId}/reviews/${reviewId}`;
  const payload = await googleJson<{ reviewReply?: Record<string, unknown> }>(
    `https://mybusiness.googleapis.com/v4/${name}/reply`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ comment: input.comment }),
    },
  );
  return {
    reviewId,
    name,
    reviewReply: {
      comment: stringValue(payload.reviewReply?.comment ?? input.comment),
      updateTime: toIso(payload.reviewReply?.updateTime ?? new Date().toISOString()),
    },
  };
}
