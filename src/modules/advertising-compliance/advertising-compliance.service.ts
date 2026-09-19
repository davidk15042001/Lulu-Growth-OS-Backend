import { randomUUID } from 'node:crypto';
import { query } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';

export const ADS_COMPLIANCE_AGENT_ID = 'system:ads-compliance-auditor';
export const ADS_COMPLIANCE_POLICY_VERSION = '2026-09-19.1';

export type AdsProvider = 'google-ads' | 'meta-ads' | 'linkedin-ads';
export type AdsComplianceAction = 'launch' | 'publish' | 'pause';

export type AdsComplianceContext = {
  accountId?: string | null;
  campaignId?: string | null;
  countries?: string[] | null;
  industry?: string | null;
  campaignName?: string | null;
  adText?: string | null;
  headlines?: string[] | null;
  descriptions?: string[] | null;
  landingPageUrl?: string | null;
  privacyPolicyUrl?: string | null;
  imprintUrl?: string | null;
  termsUrl?: string | null;
  consentMechanism?: string | null;
  specialAdCategory?: string | null;
  legalReviewApproved?: boolean | null;
  platformPolicyAcknowledged?: boolean | null;
  claims?: string[] | null;
  audience?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
};

export type AdsComplianceInput = {
  workspaceId: string;
  provider: string;
  action: AdsComplianceAction;
  context?: AdsComplianceContext | null;
};

export type AdsComplianceFinding = {
  code: string;
  severity: 'ERROR' | 'REVIEW';
  message: string;
  correction: string;
};

export type AdsComplianceDecision = 'PASSED' | 'BLOCKED' | 'REVIEW_REQUIRED';

export type AdsComplianceResult = {
  checkId: string;
  agentId: typeof ADS_COMPLIANCE_AGENT_ID;
  policyVersion: string;
  provider: AdsProvider;
  action: AdsComplianceAction;
  decision: AdsComplianceDecision;
  findings: AdsComplianceFinding[];
  corrections: string[];
};

const providerAliases: Record<string, AdsProvider> = {
  'google': 'google-ads',
  'google_ads': 'google-ads',
  'google-ads': 'google-ads',
  'meta': 'meta-ads',
  'facebook': 'meta-ads',
  'meta_ads': 'meta-ads',
  'meta-ads': 'meta-ads',
  'linkedin': 'linkedin-ads',
  'linkedin_ads': 'linkedin-ads',
  'linkedin-ads': 'linkedin-ads',
};

// This is intentionally a conservative policy pack. It does not claim to be
// legal advice; regulated or high-risk cases are sent to human review instead
// of being guessed through by an LLM or a provider response.
const regulatedIndustryRules: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /financial|finance|bank|loan|credit|insurance|invest/i, label: 'financial services' },
  { pattern: /crypto|cryptocurrency|token|forex|binary option/i, label: 'crypto/forex' },
  { pattern: /health|medical|clinic|pharma|drug|supplement|therapy/i, label: 'health/medical' },
  { pattern: /gambl|casino|betting|lottery/i, label: 'gambling' },
  { pattern: /alcohol|tobacco|nicotine|vape|cannabis/i, label: 'age-restricted products' },
  { pattern: /politic|election|government|public office/i, label: 'political content' },
  { pattern: /employment|recruit|job|housing|real estate|mortgage/i, label: 'restricted targeting category' },
];

const prohibitedClaimRules: Array<{ pattern: RegExp; code: string; message: string; correction: string }> = [
  { pattern: /guaranteed?\s+(income|profit|return|approval|result)|risk[- ]free|no risk/i, code: 'UNVERIFIABLE_GUARANTEE', message: 'The ad contains a guarantee or risk-free claim that cannot be published without verified evidence.', correction: 'Replace absolute promises with a qualified, evidence-backed statement.' },
  { pattern: /cure|treats?\s+all|100%\s+(effective|safe)|no side effects/i, code: 'UNSUPPORTED_HEALTH_CLAIM', message: 'The ad contains an absolute health or safety claim.', correction: 'Remove the claim or provide approved evidence and send it for legal review.' },
  { pattern: /#1|number one|best in the world|cheapest|fastest/i, code: 'UNSUBSTANTIATED_SUPERLATIVE', message: 'The ad contains a superlative that needs current, verifiable evidence.', correction: 'Add a dated source or rewrite the claim without an absolute ranking.' },
  { pattern: /discriminat|only\s+for\s+(men|women|white|christian)|exclude\s+(people|applicants)/i, code: 'DISCRIMINATORY_TARGETING', message: 'The ad appears to exclude or target a protected group.', correction: 'Remove the exclusion and route the campaign to human policy review.' },
];

const restrictedCountries = new Set(['CU', 'IR', 'KP', 'SY']);

function normalizeProvider(provider: string): AdsProvider {
  const normalized = provider.trim().toLowerCase();
  const result = providerAliases[normalized];
  if (!result) throw new AppError(409, 'AD_COMPLIANCE_PROVIDER_UNSUPPORTED', `Ads compliance does not support provider ${provider}.`);
  return result;
}

function normalizedCountries(countries: unknown) {
  if (!Array.isArray(countries)) return [];
  return [...new Set(countries.filter((value): value is string => typeof value === 'string').map((value) => value.trim().toUpperCase()).filter(Boolean))].slice(0, 50);
}

function normalizedText(context: AdsComplianceContext) {
  return [context.campaignName, context.adText, ...(context.headlines ?? []), ...(context.descriptions ?? []), ...(context.claims ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .slice(0, 20_000);
}

function isEuropeanMarket(countries: string[]) {
  return countries.some((country) => ['AT','BE','BG','CH','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IS','IT','LI','LT','LU','LV','MT','NL','NO','PL','PT','RO','SE','SI','SK','UK','GB'].includes(country));
}

export function evaluateAdsCompliance(input: AdsComplianceInput): Omit<AdsComplianceResult, 'checkId'> & { provider: AdsProvider } {
  const provider = normalizeProvider(input.provider);
  const context = input.context ?? {};
  const countries = normalizedCountries(context.countries);
  const findings: AdsComplianceFinding[] = [];
  const add = (finding: AdsComplianceFinding) => findings.push(finding);

  if (input.action === 'pause') {
    return { agentId: ADS_COMPLIANCE_AGENT_ID, policyVersion: ADS_COMPLIANCE_POLICY_VERSION, provider, action: input.action, decision: 'PASSED', findings: [], corrections: [] };
  }
  if (countries.length === 0) add({ code: 'COUNTRY_REQUIRED', severity: 'ERROR', message: 'The target country or countries are missing.', correction: 'Select every country the campaign will target.' });
  const restricted = countries.filter((country) => restrictedCountries.has(country));
  if (restricted.length) add({ code: 'RESTRICTED_COUNTRY', severity: 'ERROR', message: `The selected target market is restricted for paid advertising (${restricted.join(', ')}).`, correction: 'Remove the restricted market or obtain a documented compliance decision outside the autonomous launch path.' });
  if (!String(context.industry ?? '').trim()) add({ code: 'INDUSTRY_REQUIRED', severity: 'ERROR', message: 'The advertised industry is missing.', correction: 'Set the customer industry before preparing the campaign.' });
  if (!normalizedText(context)) add({ code: 'AD_CONTENT_REQUIRED', severity: 'ERROR', message: 'No campaign text or creative description was supplied.', correction: 'Provide the actual campaign copy and creative claims for review.' });

  const landingPage = String(context.landingPageUrl ?? '').trim();
  if (!landingPage) add({ code: 'LANDING_PAGE_REQUIRED', severity: 'ERROR', message: 'A landing page is required before an ad can be published.', correction: 'Add the final HTTPS landing-page URL and verify that it is reachable.' });
  else {
    try { if (new URL(landingPage).protocol !== 'https:') add({ code: 'LANDING_PAGE_NOT_HTTPS', severity: 'ERROR', message: 'The landing page is not HTTPS.', correction: 'Use a valid HTTPS landing page.' }); }
    catch { add({ code: 'LANDING_PAGE_INVALID', severity: 'ERROR', message: 'The landing page URL is invalid.', correction: 'Provide a complete HTTPS URL.' }); }
  }

  const industry = String(context.industry ?? '');
  const regulated = regulatedIndustryRules.find((rule) => rule.pattern.test(industry));
  if (regulated && !context.legalReviewApproved) add({ code: 'REGULATED_INDUSTRY_REVIEW', severity: 'REVIEW', message: `The campaign is in the ${regulated.label} category and needs a human policy/legal review.`, correction: 'Attach the required licences, disclaimers and platform approval, then mark the review as approved.' });

  const text = normalizedText(context);
  for (const rule of prohibitedClaimRules) if (rule.pattern.test(text)) add({ code: rule.code, severity: 'ERROR', message: rule.message, correction: rule.correction });

  if (isEuropeanMarket(countries)) {
    if (!context.privacyPolicyUrl) add({ code: 'PRIVACY_POLICY_REQUIRED', severity: 'REVIEW', message: 'European targeting requires a verified privacy policy link.', correction: 'Add the final privacy-policy URL and confirm the data-use/consent flow.' });
    if (!context.consentMechanism) add({ code: 'CONSENT_FLOW_REQUIRED', severity: 'REVIEW', message: 'The consent or lawful-basis mechanism for the target market is not documented.', correction: 'Document the consent/lawful-basis mechanism used on the landing page.' });
    if (countries.some((country) => ['DE', 'AT', 'CH'].includes(country)) && !context.imprintUrl) add({ code: 'IMPRINT_REQUIRED', severity: 'REVIEW', message: 'The German-speaking target market needs a verified legal-imprint link before publication.', correction: 'Add and verify the legal-imprint URL on the landing page.' });
  }
  if (['meta-ads', 'linkedin-ads'].includes(provider) && !context.platformPolicyAcknowledged) {
    add({ code: 'PLATFORM_POLICY_ACK_REQUIRED', severity: 'REVIEW', message: `The ${provider} policy acknowledgement is missing.`, correction: 'Confirm the current platform policy and any special-ad-category declaration.' });
  }
  if (provider === 'meta-ads' && regulated && !context.specialAdCategory) add({ code: 'META_SPECIAL_CATEGORY_REQUIRED', severity: 'REVIEW', message: 'Meta requires a special-ad-category decision for this campaign.', correction: 'Set the applicable Meta special ad category or route it to human review.' });

  const decision: AdsComplianceDecision = findings.some((finding) => finding.severity === 'ERROR') ? 'BLOCKED' : findings.length ? 'REVIEW_REQUIRED' : 'PASSED';
  return { agentId: ADS_COMPLIANCE_AGENT_ID, policyVersion: ADS_COMPLIANCE_POLICY_VERSION, provider, action: input.action, decision, findings, corrections: [...new Set(findings.map((finding) => finding.correction))] };
}

export async function runAdsComplianceGate(input: AdsComplianceInput): Promise<AdsComplianceResult> {
  const result = evaluateAdsCompliance(input);
  const checkId = randomUUID();
  const context = input.context ?? {};
  const idempotencyKey = context.idempotencyKey?.trim() || null;
  let persistedCheckId: string = checkId;
  try {
    const persisted = await query<{ id: string }>(
      `INSERT INTO ad_compliance_checks
        (id,workspace_id,agent_id,provider,action,account_id,campaign_id,country_codes,industry,decision,findings,corrections,input_snapshot,policy_version,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)
       ON CONFLICT (workspace_id,idempotency_key) DO UPDATE SET decision=EXCLUDED.decision,findings=EXCLUDED.findings,corrections=EXCLUDED.corrections,input_snapshot=EXCLUDED.input_snapshot,policy_version=EXCLUDED.policy_version,created_at=NOW()
       RETURNING id`,
      [checkId, input.workspaceId, ADS_COMPLIANCE_AGENT_ID, result.provider, result.action, context.accountId ?? null, context.campaignId ?? null, normalizedCountries(context.countries), context.industry ?? null, result.decision, JSON.stringify(result.findings), JSON.stringify(result.corrections), JSON.stringify(context), ADS_COMPLIANCE_POLICY_VERSION, idempotencyKey],
    );
    persistedCheckId = persisted.rows[0]?.id ?? checkId;
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: result.decision === 'PASSED'
        ? DOMAIN_EVENT_TYPES.AD_COMPLIANCE_PASSED
        : result.decision === 'REVIEW_REQUIRED'
          ? DOMAIN_EVENT_TYPES.AD_COMPLIANCE_REVIEW_REQUIRED
          : DOMAIN_EVENT_TYPES.AD_COMPLIANCE_BLOCKED,
      aggregateType: 'ad_compliance_check',
      aggregateId: persistedCheckId,
      payload: { provider: result.provider, action: result.action, decision: result.decision, findings: result.findings, corrections: result.corrections, policyVersion: result.policyVersion },
      metadata: { source: ADS_COMPLIANCE_AGENT_ID },
      idempotencyKey: `ad-compliance:${input.workspaceId}:${idempotencyKey ?? checkId}`,
    });
  } catch (error) {
    throw new AppError(503, 'AD_COMPLIANCE_CHECK_UNAVAILABLE', 'The Ads Compliance Agent could not persist its decision. The campaign remains blocked until the check succeeds.', { cause: error instanceof Error ? error.message : String(error) });
  }
  return { ...result, checkId: persistedCheckId };
}

export function assertAdsCompliancePassed(result: AdsComplianceResult) {
  if (result.decision === 'PASSED') return result;
  const summary = result.findings.map((finding) => `${finding.code}: ${finding.message}`).join(' ');
  throw new AppError(409, 'AD_COMPLIANCE_BLOCKED', `Ads publication was blocked by the Ads Compliance Agent. ${summary}`, { checkId: result.checkId, decision: result.decision, findings: result.findings, corrections: result.corrections, agentId: result.agentId, policyVersion: result.policyVersion });
}

export async function listAdsComplianceChecks(workspaceId: string, limit = 50) {
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
  const result = await query(`
    SELECT id,agent_id AS "agentId",provider,action,account_id AS "accountId",campaign_id AS "campaignId",
           country_codes AS "countryCodes",industry,decision,findings,corrections,policy_version AS "policyVersion",
           created_at AS "createdAt",resolved_at AS "resolvedAt"
      FROM ad_compliance_checks
     WHERE workspace_id=$1
     ORDER BY created_at DESC
     LIMIT $2
  `, [workspaceId, bounded]);
  return result.rows;
}
