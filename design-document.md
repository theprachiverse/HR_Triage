# Design Document: LLM-Powered HR Case Triage (ServiceNow HRSD)

| | |
|---|---|
| **Platform** | ServiceNow HRSD, Personal Developer Instance |
| **Scope / Table** | Human Resources: Core (`sn_hr_core`) / HR Case (`sn_hr_core_case`) |
| **LLM** | `openai/gpt-oss-120b` on Groq, called over REST |
| **Code** | [`src/HRTriageAgent.js`](../src/HRTriageAgent.js) and [`src/business_rule_auto_triage.js`](../src/business_rule_auto_triage.js) |

**Design principle: the LLM recommends, the code decides.**

---

## 1. Purpose

Employees raise HR cases in free text. An HR agent normally has to read each one, work out the service, find the policy, write a reply and route it. This project automates that first pass: understand the case, find the relevant HR knowledge article, draft a grounded reply, then either auto-resolve or route to the right team with a recommendation attached.

It is a fixed pipeline with one LLM call per case, not a free-roaming agent. Sensitive matters are always routed to humans.

---

## 2. Flow

```
Case is created, then short description / description are edited and saved
        |
Async Business Rule fires (condition: AI Outcome is empty)
        |
HRTriageAgent.process()
   1. Read case text and employee profile
   2. Search the HR knowledge base
   3. Call the LLM -> JSON recommendation
   4. Apply guardrails in code
        |
   +----+---------------------------+
   |                                |
All checks pass                Any check fails
   |                                |
AUTO-RESOLVE                    ESCALATE
- reply + KB reference          - routed to the right HR team
- state: Closed Complete        - reasons + draft reply in work note
                                - state: Ready
```

---

## 3. Trigger

An async Business Rule on the HR Case table, set to run on **update** when **AI Outcome is empty**.

- **Update, not insert:** cases are created first and the text is edited afterwards, so an insert trigger would triage placeholder text.
- **Async:** the LLM call takes seconds and should not hold up the save.
- **AI Outcome is empty:** a run-once guard. Once the agent sets an outcome, later updates, including the agent's own, do not re-trigger it.

---

## 4. Components

| Component | Purpose |
|---|---|
| Script Include `HRTriageAgent` | Orchestration and tools: employee profile, knowledge search, LLM call, decision logic, case update, work notes |
| Business Rule | Starts the agent (section 3) |
| Custom fields | `AI Outcome` (auto resolved, escalated, needs review, error) and `AI Confidence` (0 to 1) |
| System properties | Groq API key, HR knowledge base sys_id |
| HR services | Leave of Absence, General Benefits Inquiry, General Inquiry, Employee Payroll Setup Request, Employment Verification |
| Assignment groups | HR Benefits Team, HR Payroll Team, HR Leave & Verification Team |
| HR knowledge base | Published HR articles (payroll, direct deposit, PTO, leave, health insurance, 401(k), holidays, employment verification, tuition reimbursement and others) |

Service to group: Benefits and General Inquiry go to HR Benefits Team; Payroll goes to HR Payroll Team; Leave and Employment Verification go to HR Leave & Verification Team.

---

## 5. Knowledge retrieval

1. Search only published articles in the HR knowledge base.
2. Expand the question with synonyms (for example payday also searches pay, paid, payroll, paycheck).
3. Rank by keyword matches, with title matches scoring higher than body matches.
4. Send at most 5 trimmed articles to the LLM.
5. If nothing matches, send nothing and the case escalates.

The LLM must return no article unless one explicitly answers the exact question asked.

---

## 6. Decision logic and guardrails

The LLM returns service, priority, confidence, a sensitive flag, an article number, a draft reply and reasoning. **A case is auto-resolved only if every check passes.**

| Check | Escalates when |
|---|---|
| Sensitive topic | A keyword list matches the case text, or the LLM flags it (harassment, legal, medical, compensation, discipline, termination) |
| Confidence | Score is below 0.9 |
| KB grounding | No valid article from those retrieved, or no draft reply |
| Service classification | Service resolves to General Inquiry |

**Confidence rubric (in the prompt):** 0.9 to 1.0 fully answered; 0.7 to 0.89 mostly answered with a detail missing; 0.4 to 0.69 related articles only; below 0.4 vague or no article.

**Outcomes:**

| Outcome | State | Notes |
|---|---|---|
| Auto-resolved | Closed Complete, then Awaiting Acceptance | The agent sets Closed Complete. The HRSD acceptance process then moves the case to Awaiting Acceptance so the employee can accept or reject the answer |
| Escalated | Ready | Routed to the service's team; confidence 0.7 to 0.89 cases carry the draft reply for the HR agent to finish |

---

## 7. Audit trail

Every triaged case has AI Outcome and AI Confidence set and a work note starting `[HR Triage Agent]` with the outcome, service, article, confidence and reasoning. Escalations also list the reasons and include the draft reply. Auto-resolved cases carry the reply in comments with the article reference.

---

## 8. Test results

| Case | Result | Confidence | What it shows |
|---|---|---|---|
| Employment verification letter | Auto-resolved | 0.99 | Standard path |
| When is the next payday? | Auto-resolved | 0.95 | Correct service, team and article |
| Tuition reimbursement for an MBA | Auto-resolved | 0.99 | Answer from the tuition policy with reference |
| Report harassment by my manager | Escalated | 0.98 | Sensitive guardrail overrides high confidence |
| Question about my account (vague) | Escalated | 0.3 | Low confidence on a vague request |
| Can I use PTO while on leave of absence? | Escalated | 0.4 | Related articles, none answers |
| What time does my paycheck hit my bank account? | Escalated | 0.55 | Article lacks the deposit time; draft attached, nothing invented |
| Does tuition cover an online MBA abroad? | Escalated | 0.82 | Mid-band partial answer |
| What is my notice period? | Escalated | 0.98 | No article, so not answered (run predates the confidence rubric) |
| Part-time employee tuition eligibility | Auto-resolved | 0.95 | Reply checked: the article explicitly limits eligibility to full-time employees, so the answer was grounded |

---

## 9. What AI achieves that cannot be done manually

A person can do every step by hand, and a keyword rule engine can do part of it. The LLM adds free-text understanding, at the moment the case is saved, without anyone reading it first.

| Capability | Manual or rule-based | With the LLM triage |
|---|---|---|
| Understanding free text | Keyword rules fail on unseen phrasing | Maps varied wording to the right service |
| Instant first response | Cases wait in a queue | Routine questions answered when the case is saved, at any hour |
| Tailored replies from policy | Agent writes a reply or sends a generic link | Reply written for the specific question, from the article only, with reference |
| Knowing when not to answer | Rules cannot judge whether an article truly answers | Model rates how fully the article answers; low scores go to a person |
| Partial answers | Rules match or do not | Recognises "covers most of this, not the deposit time" and escalates with the gap stated |
| Prepared handoff | Escalations arrive raw | Arrive classified, routed, with reasoning and an editable draft |
| Consistent notes | Quality varies by agent | Same structured reasoning on every case |

Sensitive cases, policy exceptions and final accountability stay with HR.

---

## 10. Limitations

- Confidence is self-reported by the model and is not calibrated, so grounding, sensitive-topic and classification checks do not depend on it.
- An auto-resolved reply can extrapolate slightly beyond its article. Employee confirmation and spot-checks are the controls.
- Retrieval is keyword and synonym based, so new topics need new synonym groups.
- Not built yet: the AI Outcome metrics report, human-review sampling and the Flow Designer approval step.

See the [setup guide](setup-guide.md) for troubleshooting.
