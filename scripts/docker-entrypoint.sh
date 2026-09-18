#!/bin/sh
# Entry point for the Docker deployment: generates a local wrangler config and
# .dev.vars (from the container environment), then serves the OpenNext bundle.

cat > wrangler.jsonc <<'EOF'
{
  "name": "123pan-cf-index-ng",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-03-17",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "kv_namespaces": [{ "binding": "PAN_INDEX_KV", "id": "local" }]
}
EOF

printenv | grep -E '^(PAN_|BASE_DIRECTORY)' > .dev.vars || true

exec npx wrangler dev --ip=0.0.0.0 --port=8788
