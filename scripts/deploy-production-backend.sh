#!/bin/sh
set -eu

backend_dir=/var/www/lulu-growth-os/backend
environment_file=/etc/lulu-growth-backend.env

systemd-run --quiet --wait --pipe --collect \
  --property=Type=oneshot \
  --property=WorkingDirectory="$backend_dir" \
  --property=EnvironmentFile="$environment_file" \
  /usr/bin/node "$backend_dir/dist/database/run.js"

/usr/bin/systemctl restart lulu-growth-backend
/usr/bin/systemctl is-active --quiet lulu-growth-backend
