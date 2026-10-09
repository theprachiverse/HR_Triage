# Setup Guide

How to reproduce the project on a ServiceNow Personal Developer Instance (PDI) with HR Service Delivery (HRSD).

## Prerequisites

- A PDI with the HRSD plugin active (HR Case table `sn_hr_core_case`).
- A Groq account and API key. The model used is `openai/gpt-oss-120b`. The REST call runs from the ServiceNow instance, so the machine you use for the browser does not need access to Groq.
- A few test users with HR profiles.

> **Never commit the API key.** Keep it in a system property (mark it Private) for a demo. For production, use a Credential record and a connection alias.

## 1. Custom fields on the HR Case table

Add two fields to `sn_hr_core_case`:

| Label | Name | Type | Values |
|---|---|---|---|
| AI Outcome | `u_ai_outcome` | Choice | `auto_resolved`, `escalated`, `needs_review`, `error` |
| AI Confidence | `u_ai_confidence` | Decimal | 0 to 1 |

Add both to the case form and list so results are visible.

## 2. HR services and assignment groups

Create or confirm the five services and three groups listed in [`sample-data/services-and-groups.md`](../sample-data/services-and-groups.md). The group names and service names must match `SERVICE_GROUP` in `src/HRTriageAgent.js` exactly.

## 3. Knowledge base

1. Create a knowledge base for HR content, or use an existing one.
2. Create and **publish** the sample articles from [`sample-data/knowledge-articles/`](../sample-data/knowledge-articles/README.md). Add any other HR articles you want the agent to use to the same knowledge base.
3. Open `kb_knowledge_base.list`, open your HR knowledge base and copy its sys_id.

## 4. System properties

Create these properties (scope: Human Resources: Core):

| Name | Value |
|---|---|
| `sn_hr_core.groq_api_key` | Your Groq API key (mark Private) |
| `sn_hr_core.hr_kb_sys_id` | sys_id of the HR knowledge base from step 3 |

If `sn_hr_core.hr_kb_sys_id` is missing, the agent logs a warning and searches every published article on the instance. That is not what you want, because unrelated articles can push the HR articles out of the results.

## 5. Script Include

1. Switch the application scope to **Human Resources: Core**.
2. Create a Script Include named `HRTriageAgent` and paste the contents of [`src/HRTriageAgent.js`](../src/HRTriageAgent.js).

The agent sets two case states, using the values on the HR Case table (`sn_hr_core_case`) in this project:

| Label | Value | Used by the agent |
|---|---|---|
| Draft | 1 | |
| Ready | 10 | Escalated cases |
| Awaiting Approval | 11 | |
| Work in Progress | 18 | |
| Awaiting Acceptance | 20 | Set by the HRSD acceptance process after an auto-resolve |
| Suspended | 24 | |
| Closed Complete | 3 | Auto-resolved cases |
| Closed Incomplete | 4 | |
| Cancelled | 7 | |

These differ from the state values of generic case tables, so confirm them on your own instance (Dictionary Entry for the State field, Choices). If your values differ, adjust the state numbers in `_act`. Also adjust `SERVICE_GROUP` if your service or group names differ.

**Why auto-resolved cases show Awaiting Acceptance:** the agent sets Closed Complete (3). The HRSD acceptance process, driven by business rules, then moves the case to Awaiting Acceptance so the employee can accept or reject the resolution. According to ServiceNow's documentation, accepting closes the case as Closed Complete, rejecting returns it to Work in Progress, and no response within two business days closes it automatically.

## 6. Business Rule

In the same scope, create a Business Rule on `sn_hr_core_case` using the settings and script in [`src/business_rule_auto_triage.js`](../src/business_rule_auto_triage.js):

- **When:** async
- **Update:** checked (insert unchecked)
- **Condition:** AI Outcome is empty

## 7. Test it

1. Create an HR case in the UI for a test user.
2. Edit the short description (for example `When is the next payday?`) and save.
3. Wait up to a minute (async rules run through the scheduler), then refresh the case.
4. Check AI Outcome, AI Confidence, the HR service, the assignment group and the work notes.

A suggested set of test cases and the results from this project are in [`test-results.md`](test-results.md).

To re-run on the same case, clear AI Outcome and save.

## Testing from a Fix Script

Scripts in the `sn_hr_core` scope must use `gs.info`, not `gs.print`. Background scripts in the global scope cannot create HR cases because of Restricted Caller Access, so create test cases in the UI. To run the agent manually, create a **Fix Script in the sn_hr_core scope**:

```javascript
var id = 'PASTE_CASE_SYS_ID';
try {
  new HRTriageAgent().process(id);
  gs.info('HR Triage Agent finished for case: ' + id);
} catch (e) {
  gs.error('HR Triage Agent FAILED: ' + e.message);
}
```

## Troubleshooting

| Symptom | Likely cause | What to check |
|---|---|---|
| No output on a new case | Rule inactive, scheduler delay, or the case was never updated while AI Outcome was empty | Rule is Active, When = async, Update checked, condition correct. Wait a minute. Look in the System Log for `HRTriageAgent`. |
| AI Outcome = Error | The LLM call failed | The work note shows the reason. HTTP 429 is the Groq rate limit; 401 is a missing or wrong API key. |
| Agent ran but nothing was saved | A platform Business Rule (such as Assignment validation) aborted the update | Read that rule's condition and script. Check Assigned to and group membership. |
| "Unreachable code reached" or `__ref__.isNewRecord` in the log | Activity stream (form history feed), not the agent | Check AI Outcome in the list view instead of the form. |
| Agent does not find an article | The article is a draft after an edit, or sits outside the HR knowledge base | Publish the new version. Confirm `sn_hr_core.hr_kb_sys_id`. |
| The same case will not re-run | Run-once guard | Clear AI Outcome and save. |
