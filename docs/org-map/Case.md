# Case

Fields (202) from describe on devsbx, 2026-09-08T07:16:45.498Z. Record types: Bug, Feature_Request, Idea, Standard, Task, Master

| API name | Type | Writable | Custom | Picklist values |
|---|---|---|---|---|
| Account_Name__c | string | writable | custom |  |
| AccountId | reference | writable | std |  |
| AES_Rating__c | double | writable | custom |  |
| Age_Bucket__c | string | formula/rollup | custom |  |
| Age_Days__c | double | formula/rollup | custom |  |
| Agent_Effort_Notes__c | textarea | writable | custom |  |
| AirfocusURL__c | url | writable | custom |  |
| ask_devin_URL__c | url | writable | custom |  |
| Assisting_DE__c | picklist | writable | custom | Anneleissa Coen, Brandon Campbel, Brooke Thompson, Carlos Prada, Chris Fadell, Cynthia Oliveira, Darcy McCusker, Evelyn Tomada, Francisco Amaral, George Baldini, Heitor Temp, Jane Klaus … |
| Awaiting_Reply_Notice_Given__c | boolean | writable | custom |  |
| bizible2__Ad_Campaign_Name_FT__c | string | writable | custom |  |
| bizible2__Ad_Campaign_Name_LC__c | string | writable | custom |  |
| bizible2__Landing_Page_FT__c | string | writable | custom |  |
| bizible2__Landing_Page_LC__c | string | writable | custom |  |
| bizible2__Marketing_Channel_FT__c | string | writable | custom |  |
| bizible2__Marketing_Channel_LC__c | string | writable | custom |  |
| bizible2__Touchpoint_Date_FT__c | datetime | writable | custom |  |
| bizible2__Touchpoint_Date_LC__c | datetime | writable | custom |  |
| bizible2__Touchpoint_Source_FT__c | string | writable | custom |  |
| bizible2__Touchpoint_Source_LC__c | string | writable | custom |  |
| Block_Jira_Sync__c | boolean | writable | custom |  |
| Bug_Rejection_Reason__c | picklist | writable | custom | Cannot Reproduce, Duplicate, Data Issue |
| Bug_Steps_to_Reproduce_Recording__c | url | writable | custom |  |
| Bug_Workaround__c | textarea | writable | custom |  |
| Case_Id_18__c | string | formula/rollup | custom |  |
| Case_Owner_Email__c | string | formula/rollup | custom |  |
| Case_Owner_Name__c | string | writable | custom |  |
| CaseNumber | string | read-only | std |  |
| CC_emails__c | textarea | writable | custom |  |
| Client_Reported_Impact__c | picklist | writable | custom | Low impact to business process, Some impact to business process, High impact to business process, Business Process Halted |
| ClosedDate | datetime | read-only | std |  |
| Coaching_Scope__c | picklist | writable | custom | Individual, Pod, Team-Wide |
| Comments | textarea | writable | std |  |
| Complexity__c | picklist | writable | custom | 1 - No Complexity, 2 - Minimal Complexity, 3 - Medium Complexity, 5 - Significant Complexity, 8 - Extreme Complexity |
| Contact_Email__c | string | formula/rollup | custom |  |
| Contact_Email_Name__c | string | formula/rollup | custom |  |
| ContactEmail | email | read-only | std |  |
| ContactFax | phone | read-only | std |  |
| ContactId | reference | writable | std |  |
| ContactMobile | phone | read-only | std |  |
| ContactPhone | phone | read-only | std |  |
| Coursedog_School_Environment_Id__c | string | formula/rollup | custom |  |
| CreatedById | reference | read-only | std |  |
| CreatedDate | datetime | read-only | std |  |
| CSAT__c | double | writable | custom |  |
| CSAT_Comments__c | textarea | writable | custom |  |
| CSAT_Send_Eligible__c | boolean | writable | custom |  |
| Customer_Health__c | string | formula/rollup | custom |  |
| Customer_Idea_Status__c | string | formula/rollup | custom |  |
| Customer_Idea_Status_Description__c | string | formula/rollup | custom |  |
| Customer_Self_Reported_Upstream_Solution__c | picklist | writable | custom | Submitted in Error, Resolved Myself, No Longer Needed, Creating New Ticket |
| Date_First_On_Hold__c | datetime | writable | custom |  |
| Date_First_Resolved__c | datetime | writable | custom |  |
| Date_First_Working__c | datetime | writable | custom |  |
| Date_Last_Resolved__c | datetime | writable | custom |  |
| Date_Last_Working__c | datetime | writable | custom |  |
| Date_Left_On_Hold__c | datetime | writable | custom |  |
| Date_Problem_First_Occurred__c | date | writable | custom |  |
| Date_Time_Case_Assigned_via_RR__c | datetime | writable | custom |  |
| Date_Time_CSAT_Sent__c | datetime | writable | custom |  |
| Date_Time_Escalated__c | datetime | writable | custom |  |
| Date_Time_Escalated_to_High__c | datetime | writable | custom |  |
| Date_Time_of_Last_Customer_Thread_Reply__c | datetime | writable | custom |  |
| Date_Time_Priority_Escalated_to_Urgent__c | datetime | writable | custom |  |
| Date_Time_sent_to_Airfocus__c | datetime | writable | custom |  |
| Days_Since_Modified__c | double | formula/rollup | custom |  |
| Describe_Current_Behavior__c | textarea | writable | custom |  |
| Describe_Expected_Behavior__c | textarea | writable | custom |  |
| Description | textarea | writable | std |  |
| EntitlementId | reference | writable | std |  |
| Environment__c | picklist | writable | custom | Production, Staging, Both |
| Escalated_By__c | reference | writable | custom |  |
| Escalated_To__c | string | writable | custom |  |
| Escalation_Explanation__c | textarea | writable | custom |  |
| Escalation_Reason__c | picklist | writable | custom | Data/Integration Issue, Reopened Escalation, Customer Sensitivity / High Impact, Blocked / No Path Forward, Multi-Team Coordination Needed, Advanced/Custom Configuration, Knowledge Gap, Other Reason |
| First_Response_Actual_Complete__c | boolean | writable | custom |  |
| First_Response_Due__c | datetime | writable | custom |  |
| First_Response_Field_Populated__c | boolean | formula/rollup | custom |  |
| First_Response_Time__c | datetime | writable | custom |  |
| First_Response_Time_calc__c | double | formula/rollup | custom |  |
| Freshdesk_Ticket_Id__c | string | writable | custom |  |
| FreshdeskBugEscalationURL__c | string | writable | custom |  |
| FreshdeskStatus__c | picklist | writable | custom | Closed, Open, Pending, On-hold, Pending CD Resource, Waiting for Customer, Resolved, Review |
| Has_Jira_Link__c | boolean | formula/rollup | custom |  |
| Helper_Field_Jira_Issue_Type__c | picklist | writable | custom | Bug, Feature Request, Task, General Support Request |
| High_Resolution_3_Days__c | double | formula/rollup | custom |  |
| High_SLA__c | double | formula/rollup | custom |  |
| Id | id | read-only | std |  |
| IdeaBusinessContext__c | textarea | writable | custom |  |
| IdeaIntegrationContext__c | textarea | writable | custom |  |
| IdeaUserContext__c | textarea | writable | custom |  |
| IdeaWorkArounds__c | textarea | writable | custom |  |
| Implementation_Project__c | reference | writable | custom |  |
| Initial_Analysis__c | textarea | writable | custom |  |
| Integration_Adjustments_Needed__c | picklist | writable | custom | Yes, No |
| Is_First_Response_Active__c | boolean | writable | custom |  |
| Is_Resolution_Active__c | boolean | writable | custom |  |
| Is_Stale__c | boolean | formula/rollup | custom |  |
| IsClosed | boolean | read-only | std |  |
| IsDeleted | boolean | read-only | std |  |
| IsEscalated | boolean | writable | std |  |
| Jira_Account_Name__c | string | writable | custom |  |
| Jira_Closed_SF_Open__c | boolean | formula/rollup | custom |  |
| Jira_Description__c | textarea | writable | custom |  |
| Jira_Issue_Created_Time__c | datetime | writable | custom |  |
| Jira_Issue_Key__c | string | writable | custom |  |
| Jira_Issue_URL__c | url | writable | custom |  |
| Jira_Project__c | string | formula/rollup | custom |  |
| Jira_Status__c | picklist | writable | custom | Discovery, Received, Open, Sent to Engineering, Work in Progress, Waiting for Customer, Deployed to Staging, Deployed to Production, Released, Considering, Later, Next … |
| Jira_Summary__c | string | writable | custom |  |
| Language | picklist | writable | std | en_US, de, es, fr, it, ja, sv, ko, zh_TW, zh_CN, pt_BR, nl_NL … |
| Last_Coursedog_Reply_Content__c | textarea | writable | custom |  |
| Last_Coursedog_Reply_Time__c | datetime | writable | custom |  |
| Last_Customer_Reply_Time__c | datetime | writable | custom |  |
| Last_Tier_Slack_Notified_At__c | datetime | writable | custom |  |
| Last_Tier_Slack_Recipient__c | string | writable | custom |  |
| LastModifiedById | reference | read-only | std |  |
| LastModifiedDate | datetime | read-only | std |  |
| LastReferencedDate | datetime | read-only | std |  |
| LastViewedDate | datetime | read-only | std |  |
| Low_Resolution_4_Days__c | double | formula/rollup | custom |  |
| Low_SLA__c | double | formula/rollup | custom |  |
| MasterRecordId | reference | read-only | std |  |
| Medium_Resolution_4_Days__c | double | formula/rollup | custom |  |
| Medium_SLA__c | double | formula/rollup | custom |  |
| Merge_Report_Id__c | string | writable | custom |  |
| Merge_Report_URL__c | string | writable | custom |  |
| Message_to_Engineering__c | textarea | writable | custom |  |
| MilestoneTimer | string | read-only | std |  |
| My_Cases_Filter__c | boolean | formula/rollup | custom |  |
| Need_by_Date__c | date | writable | custom |  |
| Number_of_Impacted_Entities__c | picklist | writable | custom | One, A few (less than 5), Many (more than 5), All, I'm not sure |
| Open_Reason__c | picklist | writable | custom | Aassigned, Escalated, Engineering Resolved, Customer Respondeed, Engineering Resolved in Production, Re-Opened Ticket, Engineering Rejected |
| Origin | picklist | writable | std | Email, Phone, Web, Coursedog Application, Internal Submission |
| OwnerId | reference | writable | std |  |
| ParentId | reference | writable | std |  |
| Pre_Close_Status__c | string | writable | custom |  |
| Pre_Existing_Jira_Issue__c | boolean | writable | custom |  |
| Pre_Existing_Ticket__c | boolean | writable | custom |  |
| PreGoLive__c | boolean | writable | custom |  |
| Previous_Case__c | reference | writable | custom |  |
| Priority | picklist | writable | std | Catastrophic Emergency, Urgent, High, Medium, Low |
| Problem_Frequency__c | picklist | writable | custom | Occurs often, Occurs occasionally, Occurred once, I'm not sure |
| Problem_Statement__c | textarea | writable | custom |  |
| Problem_Type__c | picklist | writable | custom | SIS integration Issue (Merges, Data, etc.), API Issue, Application Error / System Failure / Error Message or Code, Behavior / Functionality Issue, Configuration Settings/Behavior Issue, User Education and Knowledge Base Feedback, Login/Single-Sign-On/User Management Issue, Navigating to / identifying a needed feature or functionality issue, Application Performance/Responsiveness Issue, Other, CSV Upload, Production to Staging Clone … |
| Product__c | picklist | writable | custom | Academic Scheduling, Admin Panel, Catalog and Handbook, Course Demand Projections, Curriculum Management, Event Scheduling, Faculty Workload Management, Integrations Hub, Syllabus Management, Artificial Intelligence, Assessment Management, Coursedog Intelligence … |
| Product_Area__c | picklist | writable | custom | Activity Log, Admin, Admin Panel User Activity Log, Agendas, Analytics Configuration, Blackout Dates, Buildings, Campus Documents, Catalog Data Checkup Report, Catalog Page(s), Catalog PDF, Catalog Settings … |
| Promote_Case_to_Jira__c | boolean | writable | custom |  |
| Queue_Name__c | string | writable | custom |  |
| Reason | picklist | writable | std | User didn't attend training, Complex functionality, Existing problem, Instructions not clear, New problem |
| RecordTypeId | reference | writable | std |  |
| RelevantLinks__c | textarea | writable | custom |  |
| Reported_by_Email__c | string | writable | custom |  |
| Requirements__c | textarea | writable | custom |  |
| Resolution__c | textarea | writable | custom |  |
| Resolution_Actual_Complete__c | boolean | writable | custom |  |
| Resolution_Due__c | datetime | writable | custom |  |
| Resolution_Time__c | double | formula/rollup | custom |  |
| RootCause__c | textarea | writable | custom |  |
| Round_Robin_Date_Time__c | datetime | writable | custom |  |
| Scheduling_Term__c | string | writable | custom |  |
| SLA_Exempt__c | boolean | writable | custom |  |
| SLA_Met__c | double | formula/rollup | custom |  |
| SLA_Milestone_Active__c | boolean | writable | custom |  |
| SLA_Milestone_Time_Remaining_Display__c | string | writable | custom |  |
| SLA_Milestone_Time_Remaining_Min__c | double | writable | custom |  |
| SLA_Milestone_Violation__c | boolean | writable | custom |  |
| SLA_Status_First_Response__c | string | formula/rollup | custom |  |
| SLA_Status_Resolution__c | string | formula/rollup | custom |  |
| SLA_Urgency__c | string | formula/rollup | custom |  |
| Sr_TSA_Involved__c | picklist | writable | custom | Yes, No |
| Sr_TSA_Involvement_Type__c | multipicklist | writable | custom | Escalation Rejected / Returned, Troubleshooting Guidance, Root Cause Identified, Product Behavior Clarification, Configuration Validation, Data / Integration Review, Process / SOP Gap Identified, Training Opportunity Identified, Other |
| Sr_TSA_Review_Summary__c | textarea | writable | custom |  |
| Sr_TSA_Trend_Tag__c | multipicklist | writable | custom | Product Knowledge Gap, Configuration Knowledge Gap, Integration / SIS Knowledge Gap, Data Model Understanding Gap, Expected vs. Actual Behavior Gap, Incomplete Troubleshooting, Poor Reproduction Steps, Missing Required Fields, Incorrect Escalation Timing, Slack-First vs SFDC-First Behavior, Ownership Confusion, Improper Case Splitting … |
| Status | picklist | writable | std | New, Received (SFDC), Received (Jira), Open, Working, Awaiting Customer, On Hold, Considering, Later, Next, Now, Parking Lot … |
| Steps_to_Reproduce_Text__c | textarea | writable | custom |  |
| Student_Information_System__c | string | formula/rollup | custom |  |
| Subject | string | writable | std |  |
| Submitted_by_Un_Authenticated_User__c | boolean | writable | custom |  |
| SuppliedCompany | string | writable | std |  |
| SuppliedEmail | email | writable | std |  |
| SuppliedName | string | writable | std |  |
| SuppliedPhone | string | writable | std |  |
| support_escalations__c | boolean | writable | custom |  |
| Support_Tag__c | multipicklist | writable | custom | #support-escalations, Bug Rejected: Revisit, Integrations: Grey Area, Integrations: Handoff, Logging Request, Pendo Replay Concern, Pendo Replay Success, Pendo Replay Used, Support Signal, Unfriendly Error, Vague Details to Move Forward, White Glove … |
| Support_Team__c | string | formula/rollup | custom |  |
| SystemModstamp | datetime | read-only | std |  |
| Task_Type__c | picklist | writable | custom | Production to Staging Clone, CSV Upload, Not Applicable |
| Test_Tag__c | string | writable | custom |  |
| Time_Tracking__c | double | writable | custom |  |
| Trigger_Round_Robin_Assignment__c | boolean | writable | custom |  |
| Type | picklist | writable | std | Problem, Question, Bug, Task, Feature Request, Idea |
| typeform__Typeform_Form_Mapping__c | reference | writable | custom |  |
| Updated_by_Flow__c | boolean | writable | custom |  |
| Updated_to_Resolved__c | boolean | writable | custom |  |
| Upstream_Solution__c | picklist | writable | custom | User Education & Training, Configuration Issues, Bug, Feature Request, Self Serve, Data Integrity, Documentation, User impersonation, Logging & Replication, General Connection Issue, New Term Start, Merge Issues … |
| Upstream_Solution_Sub_Category__c | picklist | writable | custom | System Admin Product Training, End-User Product Training, Integrations & Merge Setting Training, Knowledge Base Gap, In-App Tool Tip Gap, Customer Utilizing Knowledge Base, Template Setting Configuration, Merge Setting Configuration, Rule Configuration, Filter Configuration, Attribute Mapping Configuration, Workflow Configuration … |
| Urgent_Resolution_2_days__c | double | formula/rollup | custom |  |
| Urgent_SLA__c | double | formula/rollup | custom |  |
| Use_Case_Description__c | textarea | writable | custom |  |
| Waiting_On__c | picklist | writable | custom | Engineering, Product, 3rd Party, CS Resource, Customer, Other Coursedog Resource |
| Weekend_Second_No_Response_Warning__c | boolean | writable | custom |  |
