import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceProfileUpdateInput } from './workspace.validator.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type { WorkspaceRole } from './workspace-permissions.js';
export type { WorkspaceRole } from './workspace-permissions.js';
import { ensureWorkspaceBusinessIdentity } from '../business-identity/identity.service.js';

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
  w.bank_code AS "bankCode"
`;

export async function createWorkspace(
  userId: string,
  input: CreateWorkspaceInput,
  slug: string
): Promise<Workspace> {
  return withTransaction(async (client) => {
    const created = await query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, industry, company_size, country_region, tax_id, address, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      WHERE w.id = $1
        AND wm.user_id = $2
        AND wm.role IN ('owner', 'admin')
        AND w.deleted_at IS NULL
      LIMIT 1`,
    [workspaceId, userId],
  );
  return rows[0];
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
          SET ${assignments.join(', ')}
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

    const current = (await query<{ name: string; country: string | null; taxId: string | null; legalForm: string | null; address: string | null }>(
      `SELECT name, country_region AS country, tax_id AS "taxId", legal_form AS "legalForm", address
         FROM workspaces WHERE id = $1`,
      [workspaceId],
      client,
    )).rows[0];
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
    return (await query<WorkspaceProfile>(
      `SELECT ${workspaceProfileSelect} FROM workspaces w WHERE w.id = $1 AND w.deleted_at IS NULL`,
      [workspaceId],
      client,
    )).rows[0];
  });
}
