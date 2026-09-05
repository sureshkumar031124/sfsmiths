# docker/hercules/Dockerfile — TestZeus Hercules (AGPL-3.0) in an ISOLATED container. Phase 3, optional.
# Isolation is deliberate: Hercules pins an older Playwright and is AGPL; it never links into SFsmiths code.
# Output is UNTRUSTED TEXT — verdicts always come from deterministic assertions (Playwright/Apex/SOQL), never from Hercules.
FROM testzeus/hercules:latest
WORKDIR /hercules
# throwaway sandbox credentials only — provided at run time via .env (never committed)
ENV HERCULES_OUTPUT=/hercules/output
VOLUME ["/hercules/input", "/hercules/output"]
