/*
 * Business Rule: HR Triage Agent - Auto Triage
 *
 * Application scope : Human Resources: Core (sn_hr_core)
 * Table             : HR Case [sn_hr_core_case]
 * Active            : true
 * Advanced          : true
 *
 * When to run
 *   When      : async
 *   Insert    : false
 *   Update    : true   (cases are created first; the short description and
 *                       description are edited afterwards, so the rule runs on update)
 *   Condition : AI Outcome [u_ai_outcome] is empty
 *
 * The "AI Outcome is empty" condition is the run-once guard. Once the agent sets
 * an outcome, later updates (including the agent's own) no longer match, so the
 * rule does not loop or call the LLM twice for the same case. HRTriageAgent.process()
 * also checks the outcome itself.
 *
 * To re-triage a case, clear AI Outcome and save the case.
 */
(function executeRule(current, previous /* null when async */) {
  try {
    new HRTriageAgent().process(current.getUniqueValue());
  } catch (e) {
    gs.error('[HRTriageAgent] Business Rule failed for ' + current.getValue('number') + ': ' + e.message);
  }
})(current, previous);
