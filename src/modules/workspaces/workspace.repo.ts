import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceProfileUpdateInput } from './workspace.validator.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type { WorkspaceRole } from './workspace-permissions.js';
export type { WorkspaceRole } from './workspace-permissions.js';
import { ensureWorkspaceBusinessIdentity } from '../business-identity/identity.service.js';
import { logger } from '../../config/logger.js';

export type Workspace = {
  id: string;
  organizationId: string | null;
  factoryId: string | null;
  companyName: string;
  slug: string | null;
  industry: string | null;
  companySize: string | null;
  countryRegion: string | null;
  taxId: string | null;
  address: string | null;
  businessDescription: string | null;
  valueProposition: string | null;
  targetMarket: string | null;
  shortBrandDescription: string | null;
  positioningTags: string[];
  legalForm: string | null;
  foundingYear: number | null;
  employeeCount: number | null;
  annualRevenueRange: string | null;
  businessModelType: string | null;
  companyStage: string | null;
  salesModel: string | null;
  salesCycleDays: number | null;
  primaryIcp: string | null;
  usp: string | null;
  mission: string | null;
  vision: string | null;
  primaryChallenges: string[];
  languages: string[];
  regulatedIndustries: string[];
  onboardingStep: string;
  onboardingCompletedAt: string | null;
  billingSkippedAt: string | null;
  profileCompletedAt: string | null;
  knowledgeBaseCompletedAt: string | null;
  onboardingFileReuploadRequired: boolean;
  onboardingFilesPurgedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  role: WorkspaceRole;
  planKey: 'explorer' | 'viewer' | 'starter' | 'ai' | 'test';
};

export type WorkspaceProfile = {
  workspaceId: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string;
  industry: string | null;
  countryRegion: string | null;
  taxId: string | null;
  address: string | null;
  legalForm: string | null;
  legalRepresentative: string | null;
  phoneNumber: string | null;
  bankAccountNumber: string | null;
  bankOpeningBank: string | null;
  bankBranch: string | null;
  bankCode: string | null;
  branch: string | null;
  onboardingStep: string;
  profileCompletedAt: string | null;
  missingRequiredFields: string[];
  logoUrl: string | null;
  logoMimeType: string | null;
  logoFileName: string | null;
  logoUpdatedAt: string | null;
};

const workspaceSelect = `
  w.id,
  w.organization_id AS "organizationId",
  w.factory_id AS "factoryId",
  w.name AS "companyName",
  w.slug,
  w.industry,
  w.company_size AS "companySize",
  w.country_region AS "countryRegion",
  w.tax_id AS "taxId",
  w.address,
  w.business_description AS "businessDescription",
  w.value_proposition AS "valueProposition",
  w.target_market AS "targetMarket",
  w.short_brand_description AS "shortBrandDescription",
  w.positioning_tags AS "positioningTags",
  w.legal_form AS "legalForm",
  w.founding_year AS "foundingYear",
  w.employee_count AS "employeeCount",
  w.annual_revenue_range AS "annualRevenueRange",
  w.business_model_type AS "businessModelType",
  w.company_stage AS "companyStage",
  w.sales_model AS "salesModel",
  w.sales_cycle_days AS "salesCycleDays",
  w.primary_icp AS "primaryIcp",
  w.usp,
  w.mission,
  w.vision,
  w.primary_challenges AS "primaryChallenges",
  w.languages,
  w.regulated_industries AS "regulatedIndustries",
  w.onboarding_step AS "onboardingStep",
  w.onboarding_completed_at AS "onboardingCompletedAt",
  w.billing_skipped_at AS "billingSkippedAt",
  w.profile_completed_at AS "profileCompletedAt",
  w.knowledge_base_completed_at AS "knowledgeBaseCompletedAt",
  w.onboarding_file_reupload_required AS "onboardingFileReuploadRequired",
  w.onboarding_files_purged_at AS "onboardingFilesPurgedAt",
  w.created_by AS "createdBy",
  w.created_at AS "createdAt",
  w.updated_at AS "updatedAt",
  wm.role,
  COALESCE((SELECT plan_key FROM workspace_subscriptions ws2 WHERE ws2.workspace_id = w.id ORDER BY ws2.updated_at DESC LIMIT 1), 'starter') AS "planKey"
`;

const workspaceProfileSelect = `
  w.id AS "workspaceId",
  u.first_name AS "firstName",
  u.last_name AS "lastName",
  w.name AS "companyName",
  w.industry,
  w.country_region AS "countryRegion",
  w.tax_id AS "taxId",
  w.address,
  w.legal_form AS "legalForm",
  w.legal_representative AS "legalRepresentative",
  w.phone_number AS "phoneNumber",
  w.bank_account_number AS "bankAccountNumber",
  w.bank_opening_bank AS "bankOpeningBank",
  w.bank_branch AS "bankBranch",
  w.bank_code AS "bankCode",
  w.branch,
  w.onboarding_step AS "onboardingStep",
  w.profile_completed_at AS "profileCompletedAt",
  w.logo_storage_reference AS "logoStorageReference",
  w.logo_mime_type AS "logoMimeType",
  w.logo_file_name AS "logoFileName",
  w.logo_updated_at AS "logoUpdatedAt",
  ARRAY_REMOVE(ARRAY[
    CASE WHEN NULLIF(trim(u.first_name),'') IS NULL THEN 'firstName' END,
    CASE WHEN NULLIF(trim(u.last_name),'') IS NULL THEN 'lastName' END,
    CASE WHEN NULLIF(trim(w.name),'') IS NULL THEN 'companyName' END,
    CASE WHEN NULLIF(trim(w.industry),'') IS NULL THEN 'industry' END,
    CASE WHEN NULLIF(trim(w.country_region),'') IS NULL THEN 'countryRegion' END,
    CASE WHEN NULLIF(trim(w.tax_id),'') IS NULL THEN 'taxId' END,
    CASE WHEN NULLIF(trim(w.legal_form),'') IS NULL THEN 'legalForm' END,
    CASE WHEN NULLIF(trim(w.legal_representative),'') IS NULL THEN 'legalRepresentative' END,
    CASE WHEN NULLIF(trim(w.phone_number),'') IS NULL THEN 'phoneNumber' END,
    CASE WHEN NULLIF(trim(w.address),'') IS NULL THEN 'address' END,
    CASE WHEN NULLIF(trim(w.logo_storage_reference),'') IS NULL OR w.logo_mime_type IS NULL THEN 'companyLogo' END,
    CASE WHEN NULLIF(trim(w.bank_account_number),'') IS NULL THEN 'bankAccountNumber' END,
    CASE WHEN NULLIF(trim(w.bank_code),'') IS NULL THEN 'bankCode' END,
    CASE WHEN NULLIF(trim(w.bank_opening_bank),'') IS NULL THEN 'bankOpeningBank' END,
    CASE WHEN NULLIF(trim(w.bank_branch),'') IS NULL THEN 'bankBranch' END,
    CASE WHEN NULLIF(trim(w.branch),'') IS NULL THEN 'branch' END
  ],NULL) AS "missingRequiredFields"
`;

export function workspaceLogoUrl(workspaceId: string, version?: string | null) {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
  return `/api/v1/public/workspaces/${encodeURIComponent(workspaceId)}/logo${suffix}`;
}

export async function createWorkspace(
  userId: string,
  input: CreateWorkspaceInput,
  slug: string
): Promise<Workspace> {
  return withTransaction(async (client) => {
    const created = await query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, industry, company_size, country_region, tax_id, address, created_by, onboarding_step)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'company_information')
       RETURNING id`,
      [
        input.companyName,
        slug,
        input.industry ?? null,
        input.companySize ?? null,
        input.countryRegion ?? null,
        input.taxId ?? null,
        input.address ?? null,
        userId,
      ],
      client
    );

    const workspaceId = created.rows[0]?.id;
    if (!workspaceId) throw new Error('Workspace insert did not return an id');

    await ensureWorkspaceBusinessIdentity({
      workspaceId,
      name: input.companyName,
      country: input.countryRegion ?? null,
      taxIdentifier: input.taxId ?? null,
      address: input.address ?? null,
    }, client);

    await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspaceId, userId],
      client
    );

    await query(
      `INSERT INTO workspace_subscriptions (
         workspace_id, plan_key, status, seats, trial_ends_at,
         current_period_starts_at, current_period_ends_at
       ) VALUES ($1, 'starter', 'trialing', 1, NOW() + INTERVAL '14 days', NOW(), NOW() + INTERVAL '1 month')
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId],
      client
    );

    const workspace = await findWorkspaceForUser(workspaceId, userId, client);
    if (!workspace) throw new Error('Created workspace could not be loaded');
    await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.WORKSPACE_CREATED,
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: { workspaceId, companyName: workspace.companyName },
      metadata: { actorId: userId, source: 'workspaces' },
      idempotencyKey: `workspace:${workspaceId}:created:v1`,
    }, client);
    return workspace;
  });
}

export async function listWorkspacesForUser(userId: string) {
  const { rows } = await query<Workspace>(
    `SELECT ${workspaceSelect}
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1 AND w.deleted_at IS NULL
     ORDER BY w.created_at ASC`,
    [userId]
  );
  return rows;
}

export async function findWorkspaceForUser(
  workspaceId: string,
  userId: string,
  client?: PoolClient
) {
  const { rows } = await query<Workspace>(
    `SELECT ${workspaceSelect}
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE w.id = $1 AND wm.user_id = $2 AND w.deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, userId],
    client
  );
  return rows[0];
}

export async function findWorkspaceById(workspaceId: string) {
  const { rows } = await query<Workspace>(
    `SELECT w.id, w.organization_id AS "organizationId", w.factory_id AS "factoryId", w.name AS "companyName", w.slug, w.industry, w.company_size AS "companySize",
            w.country_region AS "countryRegion", w.tax_id AS "taxId", w.address,
            w.business_description AS "businessDescription",
            w.value_proposition AS "valueProposition", w.target_market AS "targetMarket",
            w.short_brand_description AS "shortBrandDescription", w.positioning_tags AS "positioningTags",
            w.legal_form AS "legalForm", w.founding_year AS "foundingYear",
            w.employee_count AS "employeeCount", w.annual_revenue_range AS "annualRevenueRange",
            w.business_model_type AS "businessModelType", w.company_stage AS "companyStage",
            w.sales_model AS "salesModel", w.sales_cycle_days AS "salesCycleDays",
            w.primary_icp AS "primaryIcp", w.usp, w.mission, w.vision,
            w.primary_challenges AS "primaryChallenges", w.languages,
            w.regulated_industries AS "regulatedIndustries",
            w.onboarding_step AS "onboardingStep", w.onboarding_completed_at AS "onboardingCompletedAt",
            w.billing_skipped_at AS "billingSkippedAt",w.profile_completed_at AS "profileCompletedAt",
            w.knowledge_base_completed_at AS "knowledgeBaseCompletedAt",
            w.onboarding_file_reupload_required AS "onboardingFileReuploadRequired",
            w.onboarding_files_purged_at AS "onboardingFilesPurgedAt",
            w.created_by AS "createdBy", w.created_at AS "createdAt", w.updated_at AS "updatedAt",
            'owner'::text AS role,
            COALESCE((SELECT plan_key FROM workspace_subscriptions ws2 WHERE ws2.workspace_id = w.id ORDER BY ws2.updated_at DESC LIMIT 1), 'starter') AS "planKey"
     FROM workspaces w
     WHERE w.id = $1 AND w.deleted_at IS NULL
     LIMIT 1`,
    [workspaceId]
  );
  return rows[0];
}

const updateColumnMap: Record<keyof UpdateWorkspaceInput, string> = {
  companyName: 'name',
  slug: 'slug',
  industry: 'industry',
  companySize: 'company_size',
  countryRegion: 'country_region',
  taxId: 'tax_id',
  address: 'address',
  businessDescription: 'business_description',
  valueProposition: 'value_proposition',
  targetMarket: 'target_market',
  shortBrandDescription: 'short_brand_description',
  positioningTags: 'positioning_tags',
  legalForm: 'legal_form',
  foundingYear: 'founding_year',
  employeeCount: 'employee_count',
  annualRevenueRange: 'annual_revenue_range',
  businessModelType: 'business_model_type',
  companyStage: 'company_stage',
  salesModel: 'sales_model',
  salesCycleDays: 'sales_cycle_days',
  primaryIcp: 'primary_icp',
  usp: 'usp',
  mission: 'mission',
  vision: 'vision',
  primaryChallenges: 'primary_challenges',
  languages: 'languages',
  regulatedIndustries: 'regulated_industries',
};

export async function updateWorkspace(
  workspaceId: string,
  userId: string,
  input: UpdateWorkspaceInput
) {
  const entries = Object.entries(input).filter((entry) => entry[1] !== undefined) as Array<
    [keyof UpdateWorkspaceInput, unknown]
  >;
  const values: unknown[] = [workspaceId];
  const assignments = entries.map(([key, value], index) => {
    values.push(value);
    return `${updateColumnMap[key]} = $${index + 2}`;
  });

  return withTransaction(async (client) => {
    const { rowCount } = await query(
      `UPDATE workspaces
       SET ${assignments.join(', ')}
       WHERE id = $1 AND deleted_at IS NULL`,
      values,
      client,
    );
    if (rowCount > 0) {
      const current = (await query<{ name: string; countryRegion: string | null; taxId: string | null; legalForm: string | null; address: string | null }>(
        `SELECT name, country_region AS "countryRegion", tax_id AS "taxId", legal_form AS "legalForm", address FROM workspaces WHERE id=$1`,
        [workspaceId], client,
      )).rows[0];
      if (current) await ensureWorkspaceBusinessIdentity({ workspaceId, name: current.name, country: current.countryRegion, taxIdentifier: current.taxId, legalForm: current.legalForm, address: current.address }, client);
      await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.WORKSPACE_UPDATED,
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: { workspaceId, changedFields: entries.map(([key]) => key) },
      metadata: { actorId: userId, source: 'workspaces' },
      }, client);
    }
    return findWorkspaceForUser(workspaceId, userId, client);
  });
}

export async function findMembership(workspaceId: string, userId: string) {
  const { rows } = await query<{ role: WorkspaceRole }>(
    `SELECT wm.role
     FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.workspace_id = $1 AND wm.user_id = $2 AND w.deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, userId]
  );
  return rows[0];
}

export async function findWorkspaceProfileForAdmin(workspaceId: string, userId: string) {
  const { rows } = await query<WorkspaceProfile>(
    `SELECT ${workspaceProfileSelect}
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       JOIN users u ON u.id = wm.user_id
      WHERE w.id = $1
        AND wm.user_id = $2
        AND wm.role IN ('owner', 'admin')
        AND w.deleted_at IS NULL
      LIMIT 1`,
    [workspaceId, userId],
  );
  const profile = rows[0];
  if (!profile) return undefined;
  return {
    ...profile,
    logoUrl: profile.logoMimeType ? workspaceLogoUrl(profile.workspaceId, profile.logoUpdatedAt) : null,
  };
}

export async function findWorkspaceLogo(workspaceId: string) {
  const { rows } = await query<{ storageReference: string | null; mimeType: string | null; fileName: string | null; updatedAt: string | null }>(
    `SELECT logo_storage_reference AS "storageReference",logo_mime_type AS "mimeType",logo_file_name AS "fileName",logo_updated_at AS "updatedAt"
       FROM workspaces WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function updateWorkspaceLogo(
  workspaceId: string,
  userId: string,
  input: { storageReference: string; mimeType: string; fileName: string },
) {
  const result = await query<{ previousStorageReference: string | null }>(
    `UPDATE workspaces w
        SET logo_storage_reference=$3,logo_mime_type=$4,logo_file_name=$5,logo_updated_at=NOW(),updated_at=NOW()
      WHERE w.id=$1 AND w.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=$2 AND wm.role IN ('owner','admin')
      )
      RETURNING NULL::text AS "previousStorageReference"`,
    [workspaceId, userId, input.storageReference, input.mimeType, input.fileName],
  );
  return result.rowCount ? findWorkspaceLogo(workspaceId) : null;
}

export async function clearWorkspaceLogo(workspaceId: string, userId: string) {
  const current = await findWorkspaceLogo(workspaceId);
  const result = await query(
    `UPDATE workspaces w SET logo_storage_reference=NULL,logo_mime_type=NULL,logo_file_name=NULL,logo_updated_at=NULL,updated_at=NOW()
      WHERE w.id=$1 AND w.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=$2 AND wm.role IN ('owner','admin')
      )`,
    [workspaceId, userId],
  );
  return result.rowCount ? current : null;
}

const profileColumnMap: Record<keyof WorkspaceProfileUpdateInput, string> = {
  companyName: 'name',
  industry: 'industry',
  countryRegion: 'country_region',
  taxId: 'tax_id',
  address: 'address',
  legalForm: 'legal_form',
  legalRepresentative: 'legal_representative',
  phoneNumber: 'phone_number',
  bankAccountNumber: 'bank_account_number',
  bankOpeningBank: 'bank_opening_bank',
  bankBranch: 'bank_branch',
  bankCode: 'bank_code',
  branch: 'branch',
};

export async function updateWorkspaceProfile(
  workspaceId: string,
  userId: string,
  input: WorkspaceProfileUpdateInput,
) {
  const entries = Object.entries(input).filter((entry) => entry[1] !== undefined) as Array<
    [keyof WorkspaceProfileUpdateInput, unknown]
  >;
  const values: unknown[] = [workspaceId, userId];
  const assignments = entries.map(([key, value], index) => {
    values.push(value);
    return `${profileColumnMap[key]} = $${index + 3}`;
  });

  return withTransaction(async (client) => {
    const updated = await query(
      `UPDATE workspaces w
          SET ${assignments.join(', ')}, updated_at = NOW()
        WHERE w.id = $1
          AND w.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM workspace_members wm
             WHERE wm.workspace_id = w.id
               AND wm.user_id = $2
               AND wm.role IN ('owner', 'admin')
          )`,
      values,
      client,
    );
    if (!updated.rowCount) return undefined;

    // The database, not the browser, decides when the mandatory profile gate
    // is complete. Partial PATCH calls can never unlock the workspace.
    await query(
      `WITH profile_state AS (
         SELECT ARRAY_REMOVE(ARRAY[
           CASE WHEN NULLIF(trim(u.first_name),'') IS NULL THEN 'firstName' END,
           CASE WHEN NULLIF(trim(u.last_name),'') IS NULL THEN 'lastName' END,
           CASE WHEN NULLIF(trim(w.name),'') IS NULL THEN 'companyName' END,
           CASE WHEN NULLIF(trim(w.industry),'') IS NULL THEN 'industry' END,
           CASE WHEN NULLIF(trim(w.country_region),'') IS NULL THEN 'countryRegion' END,
           CASE WHEN NULLIF(trim(w.tax_id),'') IS NULL THEN 'taxId' END,
           CASE WHEN NULLIF(trim(w.legal_form),'') IS NULL THEN 'legalForm' END,
           CASE WHEN NULLIF(trim(w.legal_representative),'') IS NULL THEN 'legalRepresentative' END,
           CASE WHEN NULLIF(trim(w.phone_number),'') IS NULL THEN 'phoneNumber' END,
           CASE WHEN NULLIF(trim(w.address),'') IS NULL THEN 'address' END,
           CASE WHEN NULLIF(trim(w.logo_storage_reference),'') IS NULL OR w.logo_mime_type IS NULL THEN 'companyLogo' END,
           CASE WHEN NULLIF(trim(w.bank_account_number),'') IS NULL THEN 'bankAccountNumber' END,
           CASE WHEN NULLIF(trim(w.bank_code),'') IS NULL THEN 'bankCode' END,
           CASE WHEN NULLIF(trim(w.bank_opening_bank),'') IS NULL THEN 'bankOpeningBank' END,
           CASE WHEN NULLIF(trim(w.bank_branch),'') IS NULL THEN 'bankBranch' END,
           CASE WHEN NULLIF(trim(w.branch),'') IS NULL THEN 'branch' END
         ],NULL) AS missing
         FROM workspaces w
         JOIN users u ON u.id = $2
         WHERE w.id = $1 AND w.deleted_at IS NULL
       )
       UPDATE workspaces w SET
         profile_completed_at = CASE WHEN cardinality(profile_state.missing) = 0 THEN COALESCE(w.profile_completed_at,NOW()) ELSE NULL END,
         onboarding_step = CASE
           WHEN w.onboarding_completed_at IS NOT NULL THEN w.onboarding_step
           WHEN cardinality(profile_state.missing) = 0 AND w.onboarding_step='profile_completion' THEN 'knowledge_base'
           WHEN cardinality(profile_state.missing) > 0 AND w.onboarding_step='knowledge_base' THEN 'profile_completion'
           ELSE w.onboarding_step
         END
       FROM profile_state
       WHERE w.id=$1 AND w.onboarding_completed_at IS NULL`,
      [workspaceId, userId], client,
    );

    const current = (await query<{ name: string; country: string | null; taxId: string | null; legalForm: string | null; address: string | null }>(
      `SELECT name, country_region AS country, tax_id AS "taxId", legal_form AS "legalForm", address
         FROM workspaces WHERE id = $1`,
      [workspaceId],
      client,
    )).rows[0];
    // Keep the profile write durable even if an older production database has
    // a temporary identity/event inconsistency. A savepoint lets us roll back
    // only these secondary side effects while preserving the actual profile
    // update; the error remains observable in structured server logs.
    await query('SAVEPOINT workspace_profile_side_effects', [], client);
    try {
      if (current) {
        await ensureWorkspaceBusinessIdentity({
          workspaceId,
          name: current.name,
          country: current.country,
          taxIdentifier: current.taxId,
          legalForm: current.legalForm,
          address: current.address,
        }, client);
      }
      await appendDomainEvent({
        workspaceId,
        type: DOMAIN_EVENT_TYPES.WORKSPACE_UPDATED,
        aggregateType: 'workspace',
        aggregateId: workspaceId,
        payload: { workspaceId, changedFields: entries.map(([key]) => key), source: 'profile' },
        metadata: { actorId: userId, source: 'workspace-profile' },
        idempotencyKey: `workspace:${workspaceId}:profile:${Date.now()}:${crypto.randomUUID()}`,
      }, client);
      await query('RELEASE SAVEPOINT workspace_profile_side_effects', [], client);
    } catch (error) {
      await query('ROLLBACK TO SAVEPOINT workspace_profile_side_effects', [], client);
      await query('RELEASE SAVEPOINT workspace_profile_side_effects', [], client);
      logger.error({ error, workspaceId, userId }, 'Workspace profile secondary synchronization failed');
    }
    return (await query<WorkspaceProfile>(
      `SELECT ${workspaceProfileSelect}
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         JOIN users u ON u.id = wm.user_id
        WHERE w.id = $1 AND wm.user_id = $2 AND w.deleted_at IS NULL
        LIMIT 1`,
      [workspaceId, userId],
      client,
    )).rows[0];
  });
}
