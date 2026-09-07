# .claude-plugin — pinned marketplace

`marketplace.json` registers **one** third-party plugin, `salesforce-development` from
[forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills), pinned to an exact commit.

Install (once, in a Claude Code session inside this repo):

```
/plugin marketplace add .
/plugin install salesforce-development@sfsmiths-pinned
/salesforce-development:setup        # the plugin's own setup (human runs it)
```

`sfsmiths-human doctor` only checks that the plugin is present; it never installs or updates it.

## Bumping the pin (human, deliberate)

1. Read the upstream diff between the current `sha` and the candidate commit (skills, `hooks/`, `agents/`, the 4 hard-denied commands list).
2. Run the Spike 1 kit (`spikes/1-sf-skills-coexistence/run.sh`) against the candidate on a scratch clone.
3. Update `sha` + `version` here, commit with the diff summary, run `/plugin update salesforce-development@sfsmiths-pinned`, then `sfsmiths-human doctor`.
4. Note the bump in `docs/DECISIONS.md`.

Why not the vendor marketplace or `claude-plugins-official`? Both track `main` (auto-update). SFsmiths' gates and prompts are tuned against a specific plugin behaviour; a silent plugin change must not change what agents do.
