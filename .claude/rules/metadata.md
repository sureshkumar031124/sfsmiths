---
paths:
  - "org/force-app/**/*.field-meta.xml"
  - "org/force-app/**/*.validationRule-meta.xml"
  - "org/force-app/**/*.permissionset-meta.xml"
  - "org/force-app/**/*.object-meta.xml"
  - "org/force-app/**/lwc/**"
---

# Fields, validation rules, permission sets, objects, LWC

- Every one of these carries a `<description>` (LWC: a header comment in the `.js`) — comment-lint checks changed files.
- Field/object API names: meaningful words, no ticket keys (`Last_Customer_Reply_At__c`, not `Field1__c`).
- Permission set changes are minimal, named for the capability, and listed in the deploy brief's "by hand" section when they must be assigned manually.
- Validation rules: clear `errorMessage` in the user's language; formula documented in the description.
