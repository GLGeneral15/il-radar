'use strict';

const { uniqueVisible } = require('./recipes.cjs');

function installSearchRunner(Session, { normalize, questionIdentity, siteKey }) {
  const p = Session.prototype;
  const text = value => String(value ?? '');
  const problem = reason => ({ status: 'needs_observation', outcome: 'failed', reason, page: null, container: null,
    observation: null, binding: null, data: null, sources: [], artifact: null });

  function validate(question, recipe, execution, parameters, quotes, expected) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || !quotes || typeof quotes !== 'object' || Array.isArray(quotes)) throw new Error('Supply current parameters and their question-stem parameterQuotes.');
    const schema = execution.parameters;
    let professionalTerms = [];
    if (!schema || Object.keys(parameters).some(key => !Object.hasOwn(schema, key)) || Object.keys(quotes).some(key => !Object.hasOwn(parameters, key))) throw new Error('Unknown parameter or extra condition.');
    for (const [key, spec] of Object.entries(schema)) {
      const value = parameters[key];
      if (value === undefined) { if (spec.required) throw new Error('Missing required parameter: ' + key); continue; }
      if (spec.type && typeof value !== spec.type || typeof value === 'string' && !value.trim() || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid parameter: ' + key);
      if (spec.values && !spec.values.includes(value)) throw new Error('Parameter is outside the verified choices: ' + key);
      const quote = quotes[key];
      if (typeof quote !== 'string' || !quote.trim() || !normalize(question.question).includes(normalize(quote))) throw new Error('Parameter quote does not occur in this question stem: ' + key);
      if (key === 'query' && execution.queryMode === 'professional') {
        const fields = recipe.syntax?.fields || {};
        let rest = text(value).trim(), terms = [], depth = 0, needsOperand = true;
        const operators = recipe.syntax?.operators || [];
        // Validate grouping and operand order as well as the observed fields.
        while (rest) {
          rest = rest.trimStart();
          if (!rest) break;
          if (!needsOperand) {
            if (rest[0] === ')' && depth > 0) { depth--; rest = rest.slice(1); continue; }
            const operator = rest.match(/^(AND|OR|NOT)(?=\s|\()/);
            if (!operator || !operators.includes(operator[1])) throw new Error('Malformed or unsupported professional query operator.');
            rest = rest.slice(operator[0].length); needsOperand = true; continue;
          }
          if (rest[0] === '(') { depth++; rest = rest.slice(1); continue; }
          const clause = rest.match(/^([A-Z][A-Z0-9]*)\s*=\s*(?:"([^"]+)"|([^()"]+?)(?=\s+(?:AND|OR|NOT)\b|\)|$))/);
          if (!clause || !Object.hasOwn(fields, clause[1])) throw new Error('Use this site\'s verified professional syntax.');
          const term = (clause[2] || clause[3]).trim();
          if (!clause[2] && /\b[A-Z][A-Z0-9]*\s*=/.test(term)) throw new Error('Separate professional clauses with an observed Boolean operator.');
          if (!term || !normalize(quote).includes(normalize(term))) throw new Error('Professional query includes a term absent from its current question quote.');
          terms.push(term); rest = rest.slice(clause[0].length); needsOperand = false;
        }
        if (needsOperand || depth !== 0) throw new Error('Professional query has an incomplete clause or unbalanced grouping.');
        if (!terms.length || !terms.some(term => normalize(term).includes(normalize(expected)) || normalize(expected).includes(normalize(term)))) throw new Error('Expected query identity does not match the supplied professional terms.');
        professionalTerms = terms;
      } else {
        const valueText = spec.evidenceValues?.[value] ?? text(value);
        if (!normalize(quote).includes(normalize(valueText))) throw new Error('Parameter value does not occur in its current question quote: ' + key);
      }
    }
    if (typeof expected !== 'string' || !expected.trim() || !normalize(question.question).includes(normalize(expected))) throw new Error('Expected result identity must come from this question stem.');
    if (!['literal', 'professional', undefined].includes(execution.queryMode)) throw new Error('Unsupported query mode.');
    return professionalTerms;
  }

  async function control(session, page, descriptor) {
    const found = await uniqueVisible(page, descriptor);
    if (!found) throw new Error('A prepared control is missing, hidden or not unique; observe the changed page.');
    return found;
  }

  async function action(session, page, step, parameters) {
    if (step.when && parameters[step.when.parameter] !== step.when.value) return;
    if (step.ifHidden && await uniqueVisible(page, step.ifHidden)) return;
    const parameter = step.parameter;
    const provided = parameter === undefined || Object.hasOwn(parameters, parameter);
    if (!provided && !step.omit) return;
    const locator = await control(session, page, step.locator);
    if (!provided) {
      if (step.omit === 'clear') await locator.fill('');
      else if (step.omit === 'uncheck') await locator.setChecked(false);
      else if (step.omit === 'empty-option') await locator.selectOption('');
      else throw new Error('No verified reset action for omitted condition.');
      return;
    }
    const value = parameter === undefined ? step.value : parameters[parameter];
    if (step.action === 'fill') { await locator.fill(text(value)); if (await locator.inputValue() !== text(value)) throw new Error('Input did not retain the current value.'); }
    else if (step.action === 'select') { await locator.selectOption(text(value)); if (await locator.inputValue() !== text(value)) throw new Error('Selection did not retain the current value.'); }
    else if (step.action === 'check') await locator.setChecked(value === undefined ? true : Boolean(value));
    else if (step.action === 'click') await locator.click();
    else throw new Error('Unsupported prepared action.');
  }

  p.runSearch = async function (question, options = {}) {
    const identity = questionIdentity(question);
    const recipe = this.recipe(options.recipeId);
    const execution = recipe.execution;
    if (!execution || execution.version !== 1 || recipe.status !== 'query_verified') return problem('This task has no verified executable recipe; use its observed manual flow.');
    const parameters = options.parameters;
    const expected = options.expected ?? parameters?.query;
    const professionalTerms = validate(question, recipe, execution, parameters, options.parameterQuotes, expected);
    const extract = options.extract || {};
    const limit = extract.limit ?? 20, maxChars = extract.maxChars ?? 9000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20000) throw new Error('Use bounded result extraction.');
    const { attempt } = this.beginQuestion(question);
    this.runLocks ||= new Map();
    const key = siteKey(this.source(recipe.source_id));
    const previous = this.runLocks.get(key) || Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      // A queued request remains part of the attempt that submitted it. A
      // later retry must not adopt this older request when the site lock opens.
      const assertCurrent = () => {
        const record = this.questionRecords.findLast(item => item.question_id === identity.id);
        if (this.activeQuestion?.id !== identity.id || this.activeQuestion?.attempt !== attempt || record?.attempt !== attempt || record.completed || record.fingerprint !== identity.fingerprint) throw new Error('This execution belongs to an older question or attempt.');
      };
      let page, currentResult;
      try {
        assertCurrent();
        const opened = await this.page(recipe.source_id, { recipeId: recipe.id, resetEntry: execution.resetEntry === true,
          withObservation: true, compact: true, focus: [expected], detail: 'status' });
        page = opened.page;
        const observed = await this.currentObservation(page, { name: 'runner-entry-' + question.id, compact: true, focus: [expected], detail: 'status' });
        const fullEntry = this.observations.get(page).observed;
        const classification = this.classify(this.source(recipe.source_id), fullEntry, fullEntry.http_status);
        if (classification.authorization !== 'not_observed') return { ...problem(classification.authorization), status: 'blocked', page, observation: observed };
        if (classification.availability !== 'reachable' || classification.identity !== 'matched') return { ...problem(classification.availability), page, observation: observed };
        assertCurrent();
        for (const guard of execution.guards || []) {
          const locator = await control(this, page, guard.locator);
          const value = guard.property === 'value' ? await locator.inputValue() : await locator.innerText();
          if (normalize(value) !== normalize(guard.equals)) throw new Error('Residual filters or an unexpected mode require observation.');
        }
        for (const step of execution.prepare || []) { assertCurrent(); await action(this, page, step, parameters); }
        const submit = execution.submit;
        if (!submit || !['click', 'press'].includes(submit.action)) throw new Error('No verified submit action.');
        const submitLocator = await control(this, page, submit.locator);
        const result = await this.transition(recipe.source_id, { questionId: question.id, fromPage: page, toRole: 'results', recipeId: recipe.id,
          query: text(parameters.query), filters: parameters, expected, observationDetail: 'status',
          trigger: async () => { assertCurrent(); if (submit.action === 'press') await submitLocator.press(submit.key); else await submitLocator.click(); } });
        currentResult = result;
        if (result.status !== 'ready') return { ...result, data: null, sources: [], artifact: null, reason: 'Complete authorization on this result page, then resume the transition.' };
        assertCurrent();
        await this.recordSearch(recipe.source_id, { page: result.page, query: text(parameters.query), filters: parameters, outcome: result.outcome });
        const resultText = await result.container.innerText();
        const matchDescriptor = recipe.transitions.results.match;
        const match = typeof matchDescriptor === 'object' ? await uniqueVisible(result.page, matchDescriptor) : null;
        if (!match) throw new Error('No unique visible current query echo is available; observe the result page.');
        const conditions = await match.innerText();
        if (professionalTerms.some(term => !normalize(conditions).includes(normalize(term)))) throw new Error('Result does not echo every current professional query term.');
        for (const parameter of execution.echoParameters || []) {
          if (parameters[parameter] !== undefined && !normalize(conditions).includes(normalize(text(parameters[parameter])))) throw new Error('Result does not echo a requested condition: ' + parameter);
        }
        const links = await result.container.locator('a[href]').evaluateAll((elements, limit) => elements.filter(element => element.getClientRects().length)
          .slice(0, limit).map(element => ({ text: element.innerText, url: element.href, target: element.getAttribute('target') || '' })), limit);
        const data = { text: resultText.slice(0, maxChars), truncated: resultText.length > maxChars, links, conditions };
        let captured = { sources: [], artifact: null };
        if (options.capture !== false) {
          const handle = await result.container.elementHandle();
          let ownerFrame;
          try { ownerFrame = handle && await handle.ownerFrame(); } finally { await handle?.dispose(); }
          const target = ownerFrame && ownerFrame !== result.page.mainFrame() ? ownerFrame.locator('body') : undefined;
          const targetText = target ? await target.innerText() : null;
          const includeConditions = !targetText || normalize(targetText).includes(normalize(conditions));
          const excerpts = [...new Set([resultText.slice(0, maxChars), includeConditions ? conditions : ''].filter(value => value.trim()))];
          if (excerpts.length) captured = await this.captureEvidenceBatch(result.page, { questionId: question.id, name: this.source(recipe.source_id).name,
            query: text(parameters.query), field: '当前检索结果及条件回显', locator: target ? '已确认结果iframe内的body' : 'body；记录读取限定于已确认结果容器', excerpts, target });
          if (!includeConditions && conditions.trim()) {
            const conditionEvidence = await this.captureEvidence(result.page, { questionId: question.id, name: this.source(recipe.source_id).name,
              query: text(parameters.query), field: '当前检索条件回显', locator: '当前页面body中的已确认查询回显', evidence: conditions });
            captured.sources.push(conditionEvidence.source);
          }
        }
        this.log('search_recipe_executed', { question_id: question.id, attempt, recipe_id: recipe.id, outcome: result.outcome, parameter_names: Object.keys(parameters), evidence_count: captured.sources.length });
        return { ...result, data, ...captured };
      } catch (error) {
        this.log('search_recipe_needs_observation', { question_id: question.id, recipe_id: recipe.id, reason: error.message });
        return { ...problem(error.message), page: currentResult?.page || page || null,
          container: currentResult?.container || null, binding: currentResult?.binding || null,
          observation: currentResult?.observation || null };
      }
    });
    this.runLocks.set(key, running);
    try { return await running; } finally { if (this.runLocks.get(key) === running) this.runLocks.delete(key); }
  };
}

module.exports = { installSearchRunner };
