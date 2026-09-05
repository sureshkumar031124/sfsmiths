#!/usr/bin/env bash
# Spike 5 — email canary: prove the sandbox cannot send mail, and learn the exact result shape.
# Sends ONE email to YOUR address (SFSMITHS_CANARY_EMAIL) with allOrNothing=false. Expected in a locked sandbox: NO_MASS_MAIL_PERMISSION.
set -euo pipefail
: "${SFSMITHS_CANARY_EMAIL:?set SFSMITHS_CANARY_EMAIL to YOUR OWN address}"
DEV="${DEV:-DevSandbox}"
echo "1) toolkit canary against $DEV"; sfsmiths agent canary --org "$DEV" || true
echo "2) raw result shape (for the record)"
cat > /tmp/sfsmiths-canary.apex <<APEX
Messaging.SingleEmailMessage m = new Messaging.SingleEmailMessage();
m.setToAddresses(new String[]{ '$SFSMITHS_CANARY_EMAIL' });
m.setSubject('[SFsmiths canary] deliverability probe'); m.setPlainTextBody('If you receive this, deliverability is ON — turn it OFF (Setup → Email → Deliverability → No access / System email only).');
Messaging.SendEmailResult[] r = Messaging.sendEmail(new Messaging.SingleEmailMessage[]{ m }, false);
System.debug('SFSMITHS_CANARY ' + JSON.serialize(r));
APEX
sf apex run --file /tmp/sfsmiths-canary.apex -o "$DEV" --json | head -c 1500; echo
echo "3) Repeat for preprod WITH the engine keychain:  HOME=\$HOME/.sfsmiths/engine sf apex run --file /tmp/sfsmiths-canary.apex -o PartialUAT --json"
echo "4) Screenshot Setup → Email → Deliverability in both orgs → spikes/5-email-canary/ (gitignored findings)."
