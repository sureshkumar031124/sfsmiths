#!/usr/bin/env bash
# Spike 4 — baseline sync by hand: how much do dev and preprod really differ for a typical scope?
# Requires: engine keychain login for preprod (sfsmiths-human org login --alias PartialUAT --keychain engine), dev in the agent keychain.
set -euo pipefail
DEV="${DEV:-DevSandbox}"; PRE="${PRE:-PartialUAT}"; META="${META:-ApexClass:CaseTriggerHandler,ApexTrigger:CaseTrigger,Flow:Case_AfterSave_Example}"
ENGINE_HOME="${SFSMITHS_ENGINE_HOME:-$HOME/.sfsmiths/engine}"
out=spikes/4-baseline-by-hand/out; rm -rf "$out"; mkdir -p "$out/dev" "$out/pre"
echo "retrieve dev (agent keychain)";  ( cd org && time sf project retrieve start --metadata ${META//,/ --metadata } -o "$DEV" --output-dir "../$out/dev" --json > "../$out/dev.json" )
echo "retrieve preprod (ENGINE keychain)"; ( cd org && HOME="$ENGINE_HOME" time sf project retrieve start --metadata ${META//,/ --metadata } -o "$PRE" --output-dir "../$out/pre" --json > "../$out/pre.json" )
echo "diff"; diff -r "$out/dev" "$out/pre" > "$out/diff.txt" || true; wc -l "$out/diff.txt"
echo "classify: identical / uat-newer / dev-newer / both — compare LastModifiedDate via Tooling in both orgs:"
for o in "$DEV" "$PRE"; do echo "  $o"; if [ "$o" = "$PRE" ]; then HOME="$ENGINE_HOME" sf data query -q "SELECT Name, LastModifiedDate FROM ApexClass WHERE Name IN ('CaseTriggerHandler')" -o "$o" --use-tooling-api --json | head -c 300; else sf data query -q "SELECT Name, LastModifiedDate FROM ApexClass WHERE Name IN ('CaseTriggerHandler')" -o "$o" --use-tooling-api --json | head -c 300; fi; echo; done
echo "Then run the toolkit on a demo ticket: sfsmiths agent baseline DEMO-101 --check   and compare its classification with yours."
