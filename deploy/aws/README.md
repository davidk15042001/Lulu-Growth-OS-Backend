# AWS Deployment Runbook

This backend is a Node.js 20 Express API with PostgreSQL, durable database-backed workers, and optional private S3 storage.

## Recommended Low-Cost Architecture

- Compute: Amazon ECS Express Mode on AWS Fargate.
- API service: public HTTPS service, `BACKGROUND_WORKERS_ENABLED=false`, autoscaled from 1 to 4 tasks to start.
- Worker service: private/no-load-balancer service, `BACKGROUND_WORKERS_ENABLED=true`, desired count 1 to start.
- Database: PostgreSQL on Amazon RDS. For a new low-traffic account, start with either RDS PostgreSQL free-plan `db.t4g.micro` or Aurora PostgreSQL Serverless v2 if the account's Free Tier plan covers it.
- Object storage: private S3 bucket for onboarding/document assets.
- Secrets: Systems Manager Parameter Store `SecureString` standard parameters for the first deployment. Move to Secrets Manager later if rotation/audit requirements justify the extra monthly cost.
- Logs/metrics: CloudWatch Logs with short retention at first, plus AWS Budgets before creating compute.

Avoid AWS App Runner for new accounts. AWS documentation says App Runner is no longer open to new customers starting March 31, 2026.

## First Production Shape

Use one container image for all runtime modes.

API task environment:

```text
NODE_ENV=production
PORT=4000
RUN_MIGRATIONS_ON_STARTUP=false
BACKGROUND_WORKERS_ENABLED=false
DATABASE_SSL=true
TRUST_PROXY=true
```

Worker task environment:

```text
NODE_ENV=production
PORT=4000
RUN_MIGRATIONS_ON_STARTUP=false
BACKGROUND_WORKERS_ENABLED=true
DATABASE_SSL=true
TRUST_PROXY=false
```

Run migrations as a one-off ECS task before starting or updating the services:

```bash
npm run migrate
```

Use `/health` for the load balancer health check. `/ready` includes deeper runtime checks and expects workers in production, so it is better as an operational endpoint than as the public ALB health check for the API-only service.

## Required Parameters

Create these as SSM Parameter Store `SecureString` values, then inject them into both ECS task definitions:

```text
/lulu/prod/DATABASE_URL
/lulu/prod/JWT_SECRET
/lulu/prod/PROVIDER_CREDENTIAL_KEY
/lulu/prod/MFA_SECRET_KEY
/lulu/prod/KIE_API_KEY
```

Create these as normal environment variables:

```text
CORS_ORIGIN=https://<frontend-domain>
FRONTEND_BASE_URL=https://<frontend-domain>
AWS_REGION=eu-central-1
AWS_S3_BUCKET=<private-bucket-name>
REFRESH_COOKIE_SAME_SITE=none
```

Add optional provider secrets only when those integrations are actually being enabled.

## Safe Setup Order

1. Create an AWS Budget with email alerts before compute or databases.
2. Pick one Region and keep all resources there. `eu-central-1` is the default in this repo and is a good default for Germany.
3. Create a private S3 bucket with public access blocked.
4. Create the PostgreSQL database and store the connection string in SSM.
5. Create an ECR repository and push this Docker image.
6. Create the ECS/Fargate API service with an HTTPS load balancer and `/health` check.
7. Run the migration task once.
8. Create the ECS/Fargate worker service with desired count 1 and no public load balancer.
9. Add target-tracking autoscaling to the API service. Start with CPU 60%, memory 70%, min 1, max 4.
10. Wire the frontend API setting to the load balancer domain or custom API domain.

## Cost Controls

- Put an AWS Budget alert at a low threshold first, for example USD 0.01 actual for zero-spend and USD 10 forecasted before production.
- Keep the API max task count small until real traffic appears.
- Keep worker desired count at 1 initially.
- Use short CloudWatch log retention.
- Do not create NAT gateways unless the architecture explicitly needs private outbound internet; NAT gateways can cost more than the first small app.
- Prefer SSM standard SecureString parameters initially to avoid Secrets Manager per-secret monthly charges.
