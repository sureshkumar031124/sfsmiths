# Spike A findings — prod read-only user · <date>

SFsmiths reaches production **only** as this user, through the evidence server, masked. Its permissions ARE the
masking boundary (P1). Recipe (adapt names to your org):

1. **User**: `sfsmiths.readonly@<yourdomain>` (an email you control — for password resets, nothing else), profile:
   *Minimum Access - Salesforce* (or *Read Only*), API Enabled.
2. **Permission set** `SFsmiths_Read_Only_Evidence` with: **View Setup and Configuration**, **API Enabled**,
   **View All Data**? — **No.** Grant object **Read** only on the allowlisted objects (`config/masking.yaml`) and
   **field-level Read** only on the allowlisted fields. Do **not** grant Modify All / Edit / Delete / Create anywhere.
   For Tooling metadata facts: *View Setup and Configuration* is enough for ApexClass/Flow/ValidationRule; test with Spike 2.
3. **Login IP ranges** on the profile: your office/VPN only. **Session**: API-only user if your edition supports it.
4. **Login** into the agent keychain: `sfsmiths-human org login --alias Production --keychain agent` as this user.
   Your own admin login must **not** be in the default sf keychain on this machine (`sf org list`; `sf org logout -o <admin alias>`).
5. Verify: `sfsmiths-human doctor --p1 --fls` → #5 identity (no create/edit/delete perms), #12 masking vs FLS (every
   allowlisted field readable; no non-allowlisted field readable).
6. Put `readonly_user` into `config/orgs.yaml` (evidence org) — the compiled policy maps it to the alias.

| Check | Result |
|---|---|
| doctor #5 identity | |
| doctor #12 FLS vs masking | |
| Tooling objects readable | |
| IP restriction active | |
