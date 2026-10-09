var HRTriageAgent = Class.create();
HRTriageAgent.prototype = {
  initialize: function () {
    this.MODEL = 'openai/gpt-oss-120b';
    this.THRESHOLD = 0.9; // auto-resolve only at or above this; 0.7-0.89 escalates with draft reply attached
    this.SERVICE_GROUP = {
      'General Benefits Inquiry': 'HR Benefits Team',
      'Employee Payroll Setup Request': 'HR Payroll Team',
      'Leave of Absence': 'HR Leave & Verification Team',
      'Employment Verification': 'HR Leave & Verification Team',
      'General Inquiry': 'HR Benefits Team'
    };
    // Guardrail: never auto-resolve these topics
    this.SENSITIVE = /harass|discriminat|complain|grievance|lawsuit|legal|terminat|fired|layoff|disciplin|investigat|salary|raise|compensation|bonus|medical|disabilit|pregnan|accommodat|retaliat/i;

    // Retrieval config: synonym groups. If the case text hits any word in a
    // group, the whole group is used as search terms.
    this.SYNONYM_GROUPS = [
      ['pay', 'paid', 'payday', 'payroll', 'paycheck', 'paychecks', 'wage', 'wages'],
      ['deposit', 'bank', 'direct', 'account'],
      ['leave', 'loa', 'absence', 'maternity', 'paternity', 'fmla'],
      ['pto', 'vacation', 'holiday', 'holidays', 'time', 'off'],
      ['insurance', 'health', 'medical', 'dental', 'benefit', 'benefits'],
      ['401k', '401', 'retirement'],
      ['verification', 'verify', 'employment', 'letter', 'proof']
    ];
    this.STOP_WORDS = ['the', 'when', 'what', 'that', 'this', 'with', 'have', 'how', 'can', 'for',
      'and', 'next', 'who', 'where', 'was', 'are', 'my', 'does', 'need', 'want', 'please',
      'would', 'about', 'from', 'help', 'you', 'your', 'our', 'will', 'is', 'to', 'of', 'in'];
    this.MAX_ARTICLES = 5;
  },

  // ---------- Orchestrator ----------
  process: function (caseId) {
    var c = new GlideRecord('sn_hr_core_case');
    if (!c.get(caseId)) return;
    if (c.getValue('u_ai_outcome')) return; // already triaged, don't run twice
    try {
      var text = c.getValue('short_description') + '\n' + (c.getValue('description') || '');
      var profile = this.getEmployeeProfile(c.getValue('opened_for'));
      var articles = this.searchHRKnowledge(text);
      var d = this._callLLM(text, profile, articles);
      this._act(c, d, text, articles);
    } catch (e) {
      c.setValue('u_ai_outcome', 'error');
      c.update();
      this.addWorkNote(c, 'Agent error: ' + e.message + '. Routed to human review.');
    }
  },

  // ---------- Tools ----------
  getEmployeeProfile: function (userId) {
    var p = { name: '', title: '', department: '', location: '', employment_type: 'unknown' };
    var u = new GlideRecord('sys_user');
    if (u.get(userId)) {
      p.name = u.getDisplayValue('name');
      p.title = u.getValue('title') || '';
      p.department = u.department.getDisplayValue();
      p.location = u.location.getDisplayValue();
    }
    var h = new GlideRecord('sn_hr_core_profile');
    h.addQuery('user', userId);
    h.setLimit(1);
    h.query();
    if (h.next() && h.isValidField('employment_type'))
      p.employment_type = h.getDisplayValue('employment_type') || 'unknown';
    return p;
  },

  // Two-stage retrieval:
  //   1) Scope to the HR knowledge base (property sn_hr_core.hr_kb_sys_id) + published only
  //   2) Expand the question with synonyms, then rank: title match = 3 pts, body match = 1 pt
  // Returns [] when nothing matches, so the guardrail escalates ("no matching KB article").
  searchHRKnowledge: function (text) {
    var self = this;
    var kbId = gs.getProperty('sn_hr_core.hr_kb_sys_id');

    // Build search terms
    var tokens = (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (t) {
      return t.length >= 3 && self.STOP_WORDS.indexOf(t) < 0;
    });
    var terms = tokens.slice();
    this.SYNONYM_GROUPS.forEach(function (g) {
      var hit = g.some(function (w) { return tokens.indexOf(w) >= 0; });
      if (hit) g.forEach(function (w) { if (terms.indexOf(w) < 0) terms.push(w); });
    });

    // Query only published articles from the HR knowledge base
    var kb = new GlideRecord('kb_knowledge');
    kb.addQuery('workflow_state', 'published');
    if (kbId) {
      kb.addQuery('kb_knowledge_base', kbId);
    } else {
      gs.warn('[HRTriageAgent] Property sn_hr_core.hr_kb_sys_id is not set; searching ALL knowledge bases.');
    }
    kb.query();

    var results = [];
    while (kb.next()) {
      var title = (kb.getValue('short_description') || '').toLowerCase();
      var body = (kb.getValue('text') || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      var bodyLower = body.toLowerCase();
      var score = 0;
      terms.forEach(function (t) {
        if (title.indexOf(t) > -1) score += 3;
        if (bodyLower.indexOf(t) > -1) score += 1;
      });
      if (score > 0) {
        results.push({
          sys_id: kb.getUniqueValue(),
          number: kb.getValue('number'),
          title: kb.getValue('short_description'),
          body: body.substring(0, 1200),
          score: score
        });
      }
    }
    results.sort(function (a, b) { return b.score - a.score; });
    return results.slice(0, this.MAX_ARTICLES);
  },

  updateCase: function (c, serviceName, priority, groupName) {
    var s = new GlideRecord('sn_hr_core_service');
    s.addQuery('name', serviceName);
    s.setLimit(1);
    s.query();
    if (s.next()) c.setValue('hr_service', s.getUniqueValue());
    var g = new GlideRecord('sys_user_group');
    g.addQuery('name', groupName);
    g.setLimit(1);
    g.query();
    if (g.next()) c.setValue('assignment_group', g.getUniqueValue());
    if (priority >= 1 && priority <= 4) c.setValue('priority', priority);
  },

  addWorkNote: function (c, msg) {
    c.work_notes = '[HR Triage Agent] ' + msg;
    c.update();
  },

  // ---------- LLM ----------
  _callLLM: function (text, profile, articles) {
    var services = Object.keys(this.SERVICE_GROUP);
    var system =
      'You are an HR case triage agent. Respond with ONLY a JSON object, no prose, with keys: ' +
      '"service" (exactly one of: ' + services.join(' | ') + '. ' +
        'Use Employee Payroll Setup Request for anything about pay, payday, paychecks, direct deposit or payroll schedule. ' +
        'Use General Benefits Inquiry for health insurance, 401(k), PTO and holiday questions. ' +
        'Use Leave of Absence for leave requests. ' +
        'Use Employment Verification for employment letters or proof of employment. ' +
        'Use General Inquiry ONLY if none of the others fit), ' +
      '"priority" (integer 1-4, 1=critical, 4=low), ' +
      '"confidence" (0-1: how confident you are that the provided article fully answers this specific request AND the service is correct. ' +
        'Rubric: 0.9-1.0 = an article directly and fully answers the request; ' +
        '0.7-0.89 = an article answers most of it but a detail the person asked about is missing; ' +
        '0.4-0.69 = related articles exist but none clearly answers; ' +
        'below 0.4 = vague request or no relevant article), ' +
      '"sensitive" (true if the case involves complaints, compensation, legal, medical, discipline, or termination), ' +
      '"article_number" (the KB number that fully answers the request, or null), ' +
      '"draft_reply" (a short, polite reply to the employee based ONLY on the provided article; empty string if no article applies), ' +
      '"reasoning" (one or two sentences). ' +
      '"article_number" must be copied exactly from the "number" field of one provided article, and must be null unless that article explicitly answers the specific question asked. ' +
      'An article on a related topic is NOT enough; if you would have to guess or extrapolate, use null. ' +
      'Never invent policy details that are not in the articles.';

    // Strip internal fields (score, sys_id) before sending to the LLM
    var articlesForLLM = articles.map(function (a) {
      return { number: a.number, title: a.title, body: a.body };
    });

    var user = 'CASE:\n' + text +
      '\n\nEMPLOYEE PROFILE:\n' + JSON.stringify(profile) +
      '\n\nKNOWLEDGE ARTICLES:\n' + JSON.stringify(articlesForLLM);

    var r = new sn_ws.RESTMessageV2();
    r.setEndpoint('https://api.groq.com/openai/v1/chat/completions');
    r.setHttpMethod('POST');
    r.setRequestHeader('Authorization', 'Bearer ' + gs.getProperty('sn_hr_core.groq_api_key'));
    r.setRequestHeader('Content-Type', 'application/json');
    r.setRequestBody(JSON.stringify({
      model: this.MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 1500
    }));
    var resp = r.execute();
    if (resp.getStatusCode() != 200) throw new Error('LLM HTTP ' + resp.getStatusCode());
    var content = JSON.parse(resp.getBody()).choices[0].message.content;
    return JSON.parse(content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1));
  },

  // ---------- Decision + guardrails ----------
  _act: function (c, d, text, articles) {
    var service = this.SERVICE_GROUP[d.service] ? d.service : 'General Inquiry';
    var group = this.SERVICE_GROUP[service];
    var conf = parseFloat(d.confidence) || 0;
    var article = null;
    articles.forEach(function (a) { if (a.number == d.article_number) article = a; });

    var reasons = [];
    if (this.SENSITIVE.test(text)) reasons.push('sensitive topic (keyword)');
    else if (d.sensitive === true) reasons.push('sensitive topic (LLM flag)');
    if (conf < this.THRESHOLD) reasons.push('low confidence (' + conf + ')');
    if (!article || !d.draft_reply) reasons.push('no matching KB article');
    if (service == 'General Inquiry') reasons.push('unclassified service');

    this.updateCase(c, service, parseInt(d.priority, 10), group);
    c.setValue('u_ai_confidence', conf);

    if (reasons.length == 0) {
      c.setValue('u_ai_outcome', 'auto_resolved');
      c.comments = d.draft_reply + '\n\nReference: ' + article.number + ' - ' + article.title;
      c.work_notes = '[HR Triage Agent] AUTO-RESOLVED and closed. Service: ' + service +
        '. Article: ' + article.number + '. Confidence: ' + conf + '. Reasoning: ' + d.reasoning;
      c.setValue('state', 3); // Closed Complete
      c.update();
    } else {
      c.setValue('u_ai_outcome', 'escalated');
      c.work_notes = '[HR Triage Agent] ESCALATED to ' + group + '. Reasons: ' + reasons.join(', ') +
        '. Service: ' + service + '. Confidence: ' + conf + '. Reasoning: ' + d.reasoning +
        (article ? ' Suggested article: ' + article.number : '') +
        (d.draft_reply ? '\n\nDRAFT REPLY (for HR review, not sent to employee):\n' + d.draft_reply : '');
      c.setValue('state', 10); // Ready, so the assignment group sees it
      c.update();
    }
  },

  type: 'HRTriageAgent'
};
