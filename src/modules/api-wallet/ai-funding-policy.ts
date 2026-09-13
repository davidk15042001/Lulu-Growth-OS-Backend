import { query } from '../../db/pool.js';
import { hasAdminCapability } from '../admin/admin.authorization.js';

export type AiFundingDecision =
  | { mode: 'CUSTOMER_PREPAID'; bypassReason: null }
  | { mode: 'PLATFORM_FUNDED'; bypassReason: 'INTERNAL_PLAN' | 'TEST_PLAN' | 'BILLING_ADMIN' | 'ADMIN_OWNED_WORKSPACE' };

export type AiFundingMode = AiFundingDecision['mode'];

/**
 * Single source of truth for AI funding.  Access checks, reservations and final
 * usage settlement must all use this decision; otherwise an admin bypass can
 * execute a provider call that a later wallet settlement incorrectly bills to
 * the customer.
 */
export async function resolveAiFundingMode(workspaceId: string, userId?: string | null): Promise<AiFundingDecision> {
  const subscription = (await query<{ provider: string | null; planKey: string | null; fundedNow: boolean }>(
    `SELECT provider,plan_key AS "planKey",
            CASE
              WHEN status='active' THEN current_period_ends_at IS NULL OR current_period_ends_at>NOW()
              WHEN status='trialing' THEN (trial_ends_at IS NULL OR trial_ends_at>NOW())
                AND (current_period_ends_at IS NULL OR current_period_ends_at>NOW())
              ELSE FALSE
            END AS "fundedNow"
       FROM workspace_subscriptions
      WHERE workspace_id=$1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [workspaceId],
  )).rows[0];
  const subscriptionIsFunded = subscription?.fundedNow === true;

  if (subscriptionIsFunded && subscription?.provider === 'internal') {
    return { mode: 'PLATFORM_FUNDED', bypassReason: 'INTERNAL_PLAN' };
  }
  if (subscriptionIsFunded && subscription?.planKey === 'test') {
    return { mode: 'PLATFORM_FUNDED', bypassReason: 'TEST_PLAN' };
  }
  if (userId && await hasAdminCapability(userId, 'billing.bypass')) {
    return { mode: 'PLATFORM_FUNDED', bypassReason: 'BILLING_ADMIN' };
  }

  const owner = (await query<{ userId: string }>(
    `SELECT wm.user_id AS "userId"
       FROM workspace_members wm
      WHERE wm.workspace_id=$1 AND wm.role='owner'
      ORDER BY wm.joined_at
      LIMIT 1`,
    [workspaceId],
  )).rows[0];
  if (owner?.userId && await hasAdminCapability(owner.userId, 'billing.bypass')) {
    return { mode: 'PLATFORM_FUNDED', bypassReason: 'ADMIN_OWNED_WORKSPACE' };
  }

  return { mode: 'CUSTOMER_PREPAID', bypassReason: null };
}
