# config/ — two layers, one file name

| Path | Tracked in git? | Who writes it |
|---|---|---|
| `config/defaults/<name>.yaml` | **yes** — ships with the repository, must stay generic (hardcode-lint scans it) | maintainers |
| `config/<name>.yaml` | **no** — `.gitignore` has `config/*.yaml` | you: `sfsmiths-human setup`, `sfsmiths-human org add/remove`, the UI → Config |

The toolkit reads your copy when it exists and the default otherwise, file by file. A fresh clone therefore runs with the
defaults; the first `setup` creates your copies; `git status` never shows them. Tests always start from `config/defaults/`.

Machine-specific permission rules follow the same idea: `.claude/settings.json` (tracked) carries the static rules;
`.claude/settings.local.json` (gitignored, written by `sfsmiths-human sync`) carries the deny rules for *your* preprod/evidence
aliases and for every other org in your sf keychain.

`config/people/` — recipient profiles for the comms agent (see its README).
