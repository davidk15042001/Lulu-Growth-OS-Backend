import { AppError } from '../../utils/app-error.js';

/**
 * These failures are not transient execution errors. They mean that the
 * workspace has not supplied a connection, permission, or business input the
 * agent needs in order to do useful work. They must be visible as blocked
 * setup work and must never be replayed by an automatic worker.
 */
const prerequisiteCodes = new Set([
  'AD_BUDGET_AUTHORIZATION_REQUIRED',
  'AD_PROVIDER_EXECUTION_UNAVAILABLE',
  'AD_SPEND_FUNDS_REQUIRED',
  'ADVERTISING_PROVIDER_NOT_CONNECTED',
  'AI_FUNDS_EXHAUSTED',
  'AI_FUNDS_REQUIRED',
  'AI_NOT_CONFIGURED',
  'AI_PROVIDER_NOT_CONFIGURED',
  'AI_REVERSAL_DEBT',
  'AGENT_REASONING_NOT_CONFIGURED',
  'CALENDAR_ACCOUNT_LOOKUP_FAILED',
  'CALENDAR_PROVIDER_NOT_CONFIGURED',
  'COMMERCIAL_POLICY_MISSING',
  'CUSTOMER_BUDGET_REQUIRED',
  'EMAIL_IMAP_CONNECTION_FAILED',
  'EMAIL_PROVIDER_NOT_CONFIGURED',
  'EMAIL_RECIPIENT_MISSING',
  'GOOGLE_ADS_CAMPAIGN_CONTEXT_INCOMPLETE',
  'GOOGLE_ADS_CONFIGURATION_MISSING',
  'GOOGLE_ADS_NOT_CONNECTED',
  'GOOGLE_ADS_PAYER_MAPPING_MISSING',
  'GOOGLE_BUSINESS_NOT_CONNECTED',
  'INVOICE_CUSTOMER_REQUIRED',
  'KIE_CREDITS_REQUIRED',
  'KIE_NOT_CONFIGURED',
  'PREMIUM_MEDIA_REFERENCE_REQUIRED',
  'OMNICHANNEL_DELIVERY_CONTEXT_MISSING',
  'PAYG_BILLING_CUSTOMER_REQUIRED',
  'PROFILE_COMPLETION_REQUIRED',
  'QUOTE_CUSTOMER_REQUIRED',
  'SEARCH_INTELLIGENCE_CONTEXT_MISSING',
  'SOCIAL_PROVIDER_NOT_CONNECTED',
  'SOCIAL_PROVIDER_SCOPE_MISSING',
  'TWILIO_MESSAGE_BODY_REQUIRED',
  'TWILIO_WHATSAPP_TEMPLATE_REQUIRED',
  'TWILIO_WORKSPACE_CREDENTIALS_UNAVAILABLE',
  'UNIFYPORT_ACCOUNT_ID_MISSING',
  'UNIFYPORT_NOT_CONFIGURED',
  'WEBSITE_PROVIDER_COLLECTION_REQUIRED',
  'WEBSITE_PROVIDER_CONFIGURATION_MISSING',
  'WEBSITE_PROVIDER_NOT_CONNECTED',
  'WEBSITE_PROVIDER_SITE_ID_MISSING',
  'WEBSITE_PROVIDER_REAUTH_REQUIRED',
  'WEBSITE_PROVIDER_SITE_SELECTION_REQUIRED',
]);

const prerequisiteMessage = 'This agent is paused because a required connection, permission, or piece of business information is missing.';

function errorCode(error: unknown) {
  return error instanceof AppError
    ? error.code
    : error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isAgentPrerequisiteFailure(error: unknown) {
  const code = errorCode(error);
  if (prerequisiteCodes.has(code)) return true;
  // A small, intentionally conservative fallback covers provider/tool errors
  // that have not yet been added to the code list. Generic 5xx/network errors
  // are excluded so temporary outages remain diagnosable as real failures.
  if (error instanceof AppError && error.status >= 500) return false;
  return /(?:not connected|connection required|missing required|context is missing|information is missing|must be configured|requires .* before|customer .* required|provider .* unavailable)/i.test(errorMessage(error));
}

export function classifyAgentFailure(error: unknown) {
  const originalCode = errorCode(error) || 'AGENT_RUN_FAILED';
  const originalMessage = errorMessage(error);
  if (!isAgentPrerequisiteFailure(error)) {
    return { blocked: false as const, code: originalCode, message: originalMessage, originalCode };
  }
  return {
    blocked: true as const,
    code: 'AGENT_PREREQUISITE_REQUIRED',
    originalCode,
    message: `${prerequisiteMessage} ${originalMessage} Lulu will not retry this work automatically. Fix the requirement, then choose Resume in the Office.`,
  };
}
