#!/bin/sh
set -e

python -m alembic upgrade head

if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  python scripts/seed_demo_data.py
  python scripts/seed_demo_attendance.py
fi

if [ "${DEBUGPY:-false}" = "true" ]; then
  # --wait-for-client blocks here until VS Code's "Remote Attach" connects,
  # so there's no race between container start and attaching the debugger.
  echo "debugpy: waiting for debugger to attach on 0.0.0.0:5678..."
  exec python -X frozen_modules=off -m debugpy --listen 0.0.0.0:5678 --wait-for-client \
    -m uvicorn app.main:app --host 0.0.0.0 --port 8010
fi

exec "$@"
