#!/bin/sh
set -eu

backend_dir=/var/www/lulu-growth-os/backend
frontend_dir=/var/www/lulu-ai.cn/html
environment_file=/etc/lulu-growth-backend.env
migration_unit="lulu-growth-backend-migration-$$"
reset_unit="lulu-growth-backend-test-reset-$$"
reset_marker="$backend_dir/.run-test-data-reset"

# The application tree may contain files from an older root-owned deployment.
# GitHub Actions uploads as the restricted deploy user, so repair only the
# code tree before the regular deployment path. Secrets and dependencies keep
# their existing ownership and are never made writable by the deploy user.
if [ "${1:-}" = "--repair-permissions" ]; then
  if [ "$(id -u)" -ne 0 ] || [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = "root" ]; then
    echo "Permission repair must run through the restricted root wrapper." >&2
    exit 1
  fi
  /usr/bin/find "$backend_dir" \
    -path "$backend_dir/.env" -prune -o \
    -path "$backend_dir/.runtime-secrets" -prune -o \
    -path "$backend_dir/node_modules" -prune -o \
    -exec /usr/bin/chown -h "$SUDO_USER" {} +
  if [ -d "$frontend_dir" ]; then
    /usr/bin/find "$frontend_dir" -exec /usr/bin/chown -h "$SUDO_USER" {} +
  fi
  exit 0
fi

# The combined release uploads the frontend after this privileged backend
# step. Repair only deploy-owned application trees so stale root-owned static
# files cannot make the final frontend rsync fail. Runtime secrets and
# dependencies remain outside this ownership repair.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  if [ -d "$frontend_dir" ]; then
    /usr/bin/find "$frontend_dir" -exec /usr/bin/chown -h "$SUDO_USER" {} +
  fi
fi

# Text/agent execution is owned by OpenAI/ChatGPT. Keep the production
# environment self-healing so a retired provider setting can never select an
# unsupported text provider after a deploy. KIE remains a separate premium-
# media integration and is intentionally not added to the text fallback chain.
if [ -f "$environment_file" ]; then
  # The API can stay online with background workers disabled, but that would
  # silently stop autonomous execution and make production readiness false.
  # Per-workspace pause/resume is enforced in the application layer; the
  # process-level worker runtime must remain enabled in production.
  if /usr/bin/grep -q '^BACKGROUND_WORKERS_ENABLED=' "$environment_file"; then
    /usr/bin/sed -i 's/^BACKGROUND_WORKERS_ENABLED=.*/BACKGROUND_WORKERS_ENABLED=true/' "$environment_file"
  else
    printf '\nBACKGROUND_WORKERS_ENABLED=true\n' >> "$environment_file"
  fi
  legacy_ai_prefix=DEEP
  legacy_ai_name=SEEK
  /usr/bin/sed -i \
    -e "/^${legacy_ai_prefix}${legacy_ai_name}_API_KEY=/d" \
    -e "/^${legacy_ai_prefix}${legacy_ai_name}_BASE_URL=/d" \
    -e "/^${legacy_ai_prefix}${legacy_ai_name}_MODEL=/d" \
    "$environment_file"
  if /usr/bin/grep -q '^OPENAI_API_KEY=[^[:space:]]' "$environment_file"; then
    /usr/bin/sed -i \
      -e 's/^AI_PROVIDER=.*/AI_PROVIDER=openai/' \
      -e 's/^AI_PROVIDER_FALLBACK_ORDER=.*/AI_PROVIDER_FALLBACK_ORDER=openai/' \
      "$environment_file"
  elif /usr/bin/grep -q '^KIE_API_KEY=[^[:space:]]' "$environment_file"; then
    # Keep an existing installation available until its ChatGPT key is added.
    # This is an explicit transitional mode; new environments default to
    # OpenAI and never include a retired provider in their fallback chain.
    /usr/bin/sed -i \
      -e 's/^AI_PROVIDER=.*/AI_PROVIDER=kie/' \
      -e 's/^AI_PROVIDER_FALLBACK_ORDER=.*/AI_PROVIDER_FALLBACK_ORDER=kie/' \
      "$environment_file"
  else
    /usr/bin/sed -i \
      -e 's/^AI_PROVIDER=.*/AI_PROVIDER=openai/' \
      -e 's/^AI_PROVIDER_FALLBACK_ORDER=.*/AI_PROVIDER_FALLBACK_ORDER=openai/' \
      "$environment_file"
  fi
fi

# A migration must never leave the production process stopped if the database
# is locked or the release runner disappears. The trap restores the service
# with the last complete code (or the new code if migration succeeded).
restore_backend() {
  if ! /usr/bin/systemctl is-active --quiet lulu-growth-backend 2>/dev/null; then
    /usr/bin/systemctl start lulu-growth-backend 2>/dev/null || true
  fi
}

# Keep a failed/disconnected deploy from leaving a named transient migration
# service behind. A completed systemd-run unit may already be collected; the
# stop is intentionally best-effort in that case.
cleanup_migration() {
  /usr/bin/systemctl stop "$migration_unit" 2>/dev/null || true
}
trap 'cleanup_migration; restore_backend' EXIT

# Deployments are pushed by GitHub Actions into a release directory without a
# .git checkout. Disable the obsolete minute-based git-poll timer so it cannot
# generate permanent failures or race the versioned deployment.
if /usr/bin/systemctl is-enabled --quiet lulu-backend-deploy.timer 2>/dev/null; then
  /usr/bin/systemctl disable --now lulu-backend-deploy.timer
fi
/usr/bin/systemctl reset-failed lulu-backend-deploy.service 2>/dev/null || true

# Wallet and ledger migrations include reconciliation backfills. Quiesce the
# old writer first so no payment/usage update can race the financial snapshot.
# The service's graceful shutdown drains in-flight provider work before exit.
/usr/bin/systemctl stop lulu-growth-backend

systemd-run --quiet --wait --pipe --collect \
  --unit="$migration_unit" \
  --property=Type=oneshot \
  --property=TimeoutStartSec=4h \
  --property=RuntimeMaxSec=4h \
  --property=WorkingDirectory="$backend_dir" \
  --property=EnvironmentFile="$environment_file" \
  /usr/bin/node "$backend_dir/dist/database/run.js"

# A one-time, explicitly authorized test-data reset can be requested by the
# deployment workflow through a marker file. It runs while the API is stopped,
# inside its own long-lived systemd unit, and the marker is removed only after
# the transaction commits successfully. Normal deployments never execute this.
if [ -f "$reset_marker" ]; then
  systemd-run --quiet --wait --pipe --collect \
    --unit="$reset_unit" \
    --property=Type=oneshot \
    --property=TimeoutStartSec=8h \
    --property=RuntimeMaxSec=8h \
    --property=WorkingDirectory="$backend_dir" \
    --property=EnvironmentFile="$environment_file" \
    /usr/bin/node "$backend_dir/scripts/lulu-fast-reset.mjs"
  rm -f "$reset_marker"
fi

# Backfill customer-facing Lulu invoices for every already-confirmed prepaid
# top-up and paid storage period before the API starts serving the release.
# The operation ledger and invoice-payment idempotency keys make this safe to
# run on every deployment, while the worker continues retrying transient
# provider/profile failures after startup.
if [ -f "$backend_dir/scripts/reconcile-paid-billing-invoices.mjs" ]; then
  systemd-run --quiet --wait --pipe --collect \
    --unit="lulu-paid-billing-reconcile-$$" \
    --property=Type=oneshot \
    --property=TimeoutStartSec=30min \
    --property=RuntimeMaxSec=30min \
    --property=WorkingDirectory="$backend_dir" \
    --property=EnvironmentFile="$environment_file" \
    /usr/bin/node "$backend_dir/scripts/reconcile-paid-billing-invoices.mjs" || \
    echo "Paid billing invoice reconciliation reported failures; the worker will retry after startup."
fi

/usr/bin/systemctl start lulu-growth-backend
/usr/bin/systemctl is-active --quiet lulu-growth-backend

# Keep verified Lulu domains routed to their canonical managed storefront and
# let ACME certificates be issued without granting the API process root access.
if [ -f "$backend_dir/deploy/lulu-managed-domain-reconcile.service" ] && [ -f "$backend_dir/deploy/lulu-managed-domain-reconcile.timer" ]; then
  /usr/bin/install -m 0644 "$backend_dir/deploy/lulu-managed-domain-reconcile.service" /etc/systemd/system/lulu-managed-domain-reconcile.service
  /usr/bin/install -m 0644 "$backend_dir/deploy/lulu-managed-domain-reconcile.timer" /etc/systemd/system/lulu-managed-domain-reconcile.timer
  /usr/bin/systemctl daemon-reload
  /usr/bin/systemctl enable --now lulu-managed-domain-reconcile.timer
  /usr/bin/systemctl start lulu-managed-domain-reconcile.service
fi
trap - EXIT
