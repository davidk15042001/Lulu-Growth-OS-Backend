import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspace.validator.js';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export type Workspace = {
  id: string;
  companyName: string;
  slug: string | null;
  industry: string | null;
  companySize: string | null;
  countryRegion: string | null;
  businessDescription: string | null;
  valueProposition: string | null;
  targetMarket: string | null;
  shortBrandDescription: string | null;
  positioningTags: string[];
  onboardingStep: string;
  onboardingCompletedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  role: WorkspaceRole;
};

const workspaceSelect = `
  w.id,
  w.name AS "companyName",
  w.slug,
  w.industry,
  w.company_size AS "companySize",
  w.country_region AS "countryRegion",
  w.business_description AS "businessDescription",
  w.value_proposition AS "valueProposition",
  w.target_market AS "targetMarket",
  w.short_brand_description AS "shortBrandDescription",
  w.positioning_tags AS "positioningTags",
  w.onboarding_step AS "onboardingStep",
  w.onboarding_completed_at AS "onboardingCompletedAt",
  w.created_by AS "createdBy",
  w.created_at AS "createdAt",
  w.updated_at AS "updatedAt",
  wm.role
`;

export async function createWorkspace(
  userId: string,
  input: CreateWorkspaceInput,
  slug: string
): Promise<Workspace> {
  return withTransaction(async (client) => {
    const created = await query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, industry, company_size, country_region, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.companyName,
        slug,
        input.industry ?? null,
        input.companySize ?? null,
        input.countryRegion ?? null,
        userId,
      ],
      client
    );

    const workspaceId = created.rows[0]?.id;
    if (!workspaceId) throw new Error('Workspace insert did not return an id');

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

const updateColumnMap: Record<keyof UpdateWorkspaceInput, string> = {
  companyName: 'name',
  slug: 'slug',
  industry: 'industry',
  companySize: 'company_size',
  countryRegion: 'country_region',
  businessDescription: 'business_description',
  valueProposition: 'value_proposition',
  targetMarket: 'target_market',
  shortBrandDescription: 'short_brand_description',
  positioningTags: 'positioning_tags',
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

  await query(
    `UPDATE workspaces
     SET ${assignments.join(', ')}
     WHERE id = $1 AND deleted_at IS NULL`,
    values
  );

  return findWorkspaceForUser(workspaceId, userId);
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
