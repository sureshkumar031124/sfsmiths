---
paths:
  - "org/force-app/**/*.flow-meta.xml"
  - "org/force-app/**/*.flowtest-meta.xml"
  - "Example/Flows/**"
---

# Flow metadata in this repo

- `<description>` on the flow and on non-obvious elements (comment-lint). Name: `Object_Context_WhatItDoes` unless `config/naming.yaml` says otherwise.
- Before-save for same-record field logic; after-save for related records/notifications; Apex for complex or bulk-heavy work. Never duplicate a trigger's behaviour in a flow (`std-flow-standards`).
- Entry conditions present; fault paths on every DML/Action; no Get/DML inside loops; API version = `org/sfdx-project.json`.
- Start from `Example/Flows/*.flow-meta.xml` for known-good XML shape. Deactivate by metadata status, never delete history.
