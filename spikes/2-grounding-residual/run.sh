#!/usr/bin/env bash
# Spike 2 — grounding residual: what the caches and the READ-ONLY user can actually see.
set -euo pipefail
DEV="${DEV:-DevSandbox}"; PROD="${PROD:-Production}"
echo "a) describe shape (dev)";        sf sobject describe -s Case -o "$DEV" --json | head -c 600; echo
echo "b) FieldDefinition via Tooling (dev)"; sf data query -q "SELECT QualifiedApiName, DataType, IsCalculated FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName='Case' LIMIT 5" -o "$DEV" --use-tooling-api --json | head -c 600; echo
echo "c) metadata types (dev)";        sf org list metadata-types -o "$DEV" --json | head -c 400; echo
echo "d) Tooling SOQL with the READ-ONLY prod user (engine keychain NOT involved; this is the agent keychain evidence user)"
for q in "SELECT Name, LastModifiedDate FROM ApexClass LIMIT 3" "SELECT DeveloperName, LatestVersion.Status FROM FlowDefinition LIMIT 3" "SELECT ValidationName, Active FROM ValidationRule LIMIT 3" "SELECT MetadataComponentName, RefMetadataComponentName FROM MetadataComponentDependency LIMIT 3"; do
  echo "   $q"; sf data query -q "$q" -o "$PROD" --use-tooling-api --json 2>&1 | head -c 300; echo
done
echo "e) Row count with the read-only user";  sf data query -q "SELECT COUNT() FROM Case" -o "$PROD" --json | head -c 200; echo
echo "Record: which Tooling objects the read-only user can query (View Setup and Configuration enough?), describe field count, timings."
