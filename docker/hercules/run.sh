#!/usr/bin/env bash
# docker/hercules/run.sh — run one Gherkin feature through Hercules against the DEVELOPMENT sandbox (Phase 3, optional).
# Usage: docker/hercules/run.sh work/<KEY>/hercules/feature.feature
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
feature="${1:?feature file}"
[ -f "$here/.env" ] || { echo "copy .env.example to .env with THROWAWAY dev-sandbox credentials"; exit 1; }
if grep -qiE 'login\.salesforce\.com|(^|[^a-z])my\.salesforce\.com' "$here/.env" && ! grep -qiE 'sandbox|develop|scratch' "$here/.env"; then
  echo "REFUSED: .env points at what looks like production"; exit 2
fi
out="$(dirname "$feature")/hercules-output"
mkdir -p "$out"
docker build -q -t sfsmiths-hercules "$here" >/dev/null
docker run --rm --env-file "$here/.env" -v "$(pwd)/$(dirname "$feature"):/hercules/input:ro" -v "$(pwd)/$out:/hercules/output" sfsmiths-hercules \
  python -m testzeus_hercules --input-file "/hercules/input/$(basename "$feature")" --output-path /hercules/output || true
echo "Hercules output (UNTRUSTED TEXT) in $out — turn candidate steps into a Playwright spec; the spec is the referee."
