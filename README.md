# LLM-Powered HR Case Triage for ServiceNow HRSD

When an HR case is saved, this project classifies it, finds the relevant HR knowledge article, drafts a reply grounded in that article, and either auto-resolves the case or routes it to the right HR team with the reasoning and a draft reply attached.

**The LLM recommends, the code decides.** Sensitive topics, low confidence and missing articles always go to a human.

## How it works

```
Case is created, then short description / description are edited and saved
        |
Async Business Rule fires (condition: AI Outcome is empty)
        |
HRTriageAgent.process()
   1. Read case text and employee profile
   2. Search the HR knowledge base (scoped, synonym-expanded, ranked)
   3. Call the LLM (Groq, openai/gpt-oss-120b) -> JSON recommendation
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

The LLM returns a service, priority, confidence, a sensitive flag, an article number, a draft reply and reasoning. The code then decides. **A case is auto-resolved only if every check passes:**

| Check | Escalates when |
|---|---|
| Sensitive topic | A keyword list matches, or the LLM flags it (harassment, legal, medical, compensation, discipline, termination) |
| Confidence | Score is below 0.9 |
| KB grounding | No valid article from those retrieved, or no draft reply |
| Service classification | The service resolves to General Inquiry |

On auto-resolve the agent sets the case to **Closed Complete**. The HRSD acceptance process then places it in **Awaiting Acceptance**, so the employee can accept the answer or reject it. According to ServiceNow's documentation, an accepted case closes, a rejected case goes back to Work in Progress, and a case with no response closes automatically after two business days. Every case gets an AI Outcome, an AI Confidence score and a work note with the reasoning.

## Results

Seven test cases covering the main paths all behaved as expected:

| Scenario | Outcome | Confidence |
|---|---|---|
| Employment verification letter | Auto resolved | 0.99 |
| When is the next payday? | Auto resolved | 0.95 |
| Part-time employee asks about tuition (the policy says full-time only) | Auto resolved | 0.95 |
| Tuition for an online MBA abroad (article does not cover it) | Escalated, draft attached | 0.82 |
| Paycheck deposit time (article has the schedule, not the time) | Escalated, draft attached | 0.55 |
| Vague request | Escalated | 0.3 |
| Harassment report | Escalated (sensitive topic) | 0.98 |

Full results, screenshots and the recorded work notes are in [`docs/test-results.md`](docs/test-results.md). These are hand-picked scenarios that show the paths work. They are not an accuracy measurement.

## Repository layout

```
src/
  HRTriageAgent.js                 Script Include (orchestration, retrieval, LLM call, guardrails)
  business_rule_auto_triage.js     Async Business Rule that starts the agent
docs/
  design-document.md               Design, guardrails, retrieval, limitations
  setup-guide.md                   Step-by-step setup and troubleshooting
  test-results.md                  Results, screenshots, recorded work notes
  screenshots/
sample-data/
  services-and-groups.md           HR services and the assignment group for each
  knowledge-articles/              Sample HR knowledge articles
```

## Getting started

See the [setup guide](docs/setup-guide.md). In short: add the two custom fields, create the services, groups and knowledge articles, set the two system properties (Groq API key and HR knowledge base sys_id), add the Script Include, then add the Business Rule.

## Design decisions

- **Async Business Rule on update.** Cases are created first and the text is edited afterwards, so an insert trigger would triage placeholder text. Async keeps the save fast while the LLM call runs.
- **Run-once guard.** The rule only fires while AI Outcome is empty, which prevents repeat runs and loops.
- **Scoped retrieval.** Only published articles in the HR knowledge base are searched, with synonym expansion and title-weighted ranking. An early version searched every article on the instance and the HR articles never reached the model.
- **Defined confidence rubric.** Without one, the model reported 0.9 or higher even on questions it could not answer. The rubric in the prompt made the score informative.
- **Answers only from retrieved articles.** The returned article number must match one that was actually retrieved, and an article on a related topic is not enough.

More detail is in the [design document](docs/design-document.md).

## Limitations

- This is a fixed pipeline with one LLM call per case. It is not a free-roaming agent, and it does not use ServiceNow AI Agent Studio, which was not available on the PDI.
- The confidence score is reported by the model and is not calibrated. That is why the sensitive-topic, grounding and classification checks do not depend on it.
- An auto-resolved reply can still go slightly beyond what its article says. The Awaiting Acceptance state lets the employee reject a wrong answer.
- Retrieval is keyword and synonym based, so new topics need new synonym groups.
- Case text and a few employee profile fields (name, title, department, location, employment type) are sent to an external LLM provider. That is fine for a PDI with test data. Real HR data would need an approved provider and minimized data.
- The API key is stored in a system property for the demo. Use a Credential record in production.
- Not built yet: an AI Outcome metrics report, human-review sampling of auto-resolved cases, and a Flow Designer approval step.

## License

MIT. See [LICENSE](LICENSE).
