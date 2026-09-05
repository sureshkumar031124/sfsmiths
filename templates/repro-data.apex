/**
 * repro-data.apex — TEMPLATE for reproduction data (run via: sfsmiths agent privileged apex-run <KEY> --file <this>)
 *
 * Rules enforced by the toolkit before this runs: email canary PASS for the dev org, every email in this file
 * matches config/safety.yaml allowed_test_emails, target = development sandbox only.
 * Rules enforced by gates afterwards: meaningful names (naming-lint), tag on every record (naming-lint), email-guard.
 *
 * Replace the scenario below. Keep: TAG constant, allowlisted domain, bulk size, final System.debug of ids.
 */
final String TAG = '[SFSMITHS KEY-000]';                 // ← the {{TAG}} from your stage prompt
final String DOMAIN = 'example.com';                     // ← must be in allowed_test_emails
final Integer BULK = 200;                                // triggers/flows must be exercised in bulk

// 1. Parent record(s) — scenario-true names
Account escalationAccount = new Account(
    Name = 'Northwind Escalation Rollout',               // says what the scenario is; never "Test1"
    Test_Tag__c = TAG                                    // ← test_tag_field from config/safety.yaml
);
insert escalationAccount;

Contact reporter = new Contact(
    FirstName = 'Rollout', LastName = 'Manager',
    Email = 'rollout.manager@' + DOMAIN,                 // allowlisted domain only
    AccountId = escalationAccount.Id,
    Test_Tag__c = TAG
);
insert reporter;

// 2. Bulk child records reproducing the SHAPE seen in production evidence (masked counts/distribution)
List<Case> cases = new List<Case>();
for (Integer i = 0; i < BULK; i++) {
    cases.add(new Case(
        Subject = 'Portal login fails after password reset #' + i,
        AccountId = escalationAccount.Id,
        ContactId = reporter.Id,
        Origin = 'Web',
        Priority = 'High',
        Status = 'New',
        Test_Tag__c = TAG
    ));
}
insert cases;

// 3. Print ids for 02-repro.md (the toolkit captures debug output into validations/)
System.debug('SFSMITHS_IDS ' + JSON.serialize(new Map<String, Object>{
    'account' => escalationAccount.Id, 'contact' => reporter.Id, 'cases' => cases.size(), 'tag' => TAG
}));
