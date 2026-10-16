'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { locate, uniqueVisible } = require('./recipes.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ROLES = ['search', 'results', 'detail'];
const MODES = ['popup', 'same-page', 'reuse-target', 'iframe'];

function installTransitions(Session, { stamp, normalize, hash, httpURL, domainMatches }) {
  const p = Session.prototype;

  p.recipe = function (id) { return this.recipeStore.recipe(id); };
  p.findRecipes = function (selection) { return this.recipeStore.find(selection); };
  p.locator = function (page, descriptor) { return locate(page, descriptor); };

  p.activateQuestion = function (id, attempt) {
    if (this.activeQuestion?.id !== id || this.activeQuestion?.attempt !== attempt) {
      for (const operation of this.activeTransitions.values()) operation.cancelled = true;
    }
    this.activeQuestion = { id, attempt };
  };

  // A deliberate, verified entry navigation changes a task page back to an
  // unbound source/help page. It does not release other or delayed popup pages.
  p.clearPageRole = function (page) {
    for (const roles of this.rolePages.values()) for (const [role, bound] of roles) if (bound === page) roles.delete(role);
    for (const [key, state] of this.transitionStates) if (state.page === page) this.transitionStates.delete(key);
    this.life(page).binding = null;
    this.life(page).uncertainPopupEpoch = undefined;
  };

  p.life = function (page) {
    if (!this.pageLife.has(page)) this.pageLife.set(page, { at: Date.now(), protected: false, completed: false, binding: null });
    return this.pageLife.get(page);
  };

  p.rolePage = function (sourceId, role) {
    if (!ROLES.includes(role)) throw new Error('Unknown page role.');
    if (role === 'search') return this.pages.get(sourceId);
    const page = this.rolePages.get(sourceId)?.get(role);
    const binding = page && this.life(page).binding;
    if (!page || page.isClosed() || !binding || binding.role !== role || binding.question_id !== this.activeQuestion?.id || binding.attempt !== this.activeQuestion?.attempt || binding.document_epoch !== this.documentEpochs.get(page)) throw new Error('No current question page is bound to this role.');
    return page;
  };

  p.bindRole = function (sourceId, role, page, binding) {
    if (!this.rolePages.has(sourceId)) this.rolePages.set(sourceId, new Map());
    for (const [otherId, roles] of this.rolePages) {
      for (const [otherRole, bound] of roles) if (bound === page && (otherId !== sourceId || otherRole !== role)) roles.delete(otherRole);
    }
    this.rolePages.get(sourceId).set(role, page);
    const life = this.life(page);
    Object.assign(life, { at: Date.now(), completed: false, binding });
    if (this.parkingPage === page) this.parkingPage = undefined;
  };

  p.forgetPage = function (page) {
    for (const [id, bound] of this.pages) if (bound === page) this.pages.delete(id);
    for (const roles of this.rolePages.values()) for (const [role, bound] of roles) if (bound === page) roles.delete(role);
    if (this.parkingPage === page) this.parkingPage = undefined;
    for (const [id, bound] of this.preparationPages || []) if (bound === page) this.preparationPages.delete(id);
    this.pageLife.delete(page);
  };

  p.taskPages = function () {
    return this.context.pages().filter(page => !page.isClosed() && !this.life(page).preparation);
  };

  p.enforceUnboundPopupLimit = async function (page) {
    const opener = await page.opener();
    if (opener && this.life(opener).preparation) {
      this.life(page).preparation = true;
      return;
    }
    if (opener && ![...this.activeTransitions.values()].some(operation => operation.fromPage === opener)) {
      // Outside a tool-owned transition this can be a human's SSO/login window.
      this.life(page).preparation = true;
      return;
    }
    if (!opener || page.isClosed() || this.life(page).preparation || this.taskPages().length <= this.maxPages) return;
    // A current operation owns its candidates until query identity is checked.
    // Later unsolicited pages remain quarantined and cannot accumulate tabs.
    const life = this.life(page);
    if (life.binding || life.pendingOperation || life.protected) return;
    await page.close();
    this.log('extra_unbound_popup_closed', { opener_url: opener.isClosed() ? null : opener.url() });
  };

  p.reservePageSlot = async function ({ protect = [], needed = 1 } = {}) {
    const previous = this.slotLock || Promise.resolve();
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.slotLock = queued;
    await previous.catch(() => {});
    try {
    const protectedPages = new Set([...protect, ...[...this.activeTransitions.values()].map(operation => operation.fromPage)]);
    while (this.taskPages().length + [...this.slotReservations.values()].reduce((a, b) => a + b, 0) + needed > this.maxPages) {
      const candidates = this.taskPages().filter(page => !protectedPages.has(page) && !this.life(page).protected)
        .filter(page => { const life = this.life(page); return !life.busy && !life.pendingOperation && !life.unfinished; })
        .filter(page => { const life = this.life(page); return !life.binding || life.completed || life.binding.question_id !== this.activeQuestion?.id || life.binding.attempt !== this.activeQuestion?.attempt; })
        .sort((a, b) => Number(this.life(b).completed) - Number(this.life(a).completed) || Number(this.life(b).binding?.role === 'detail') - Number(this.life(a).binding?.role === 'detail') || this.life(a).at - this.life(b).at);
      let disposable;
      for (const page of candidates) {
        if (/^https?:/i.test(page.url())) {
          const observed = await this.observe(page, { name: 'tab-release-check', compact: true, maintenance: true });
          const classification = this.classify({ url: observed.url }, this.observations.get(page).observed, observed.http_status);
          if (classification.authorization !== 'not_observed') { this.life(page).protected = true; continue; }
        }
        disposable = page; break;
      }
      if (!disposable) throw new Error(`${this.maxPages} pages are protected or contain unfinished evidence. Finish verification before opening another page.`);
      await disposable.close(); this.forgetPage(disposable);
    }
    const token = crypto.randomUUID();
    this.slotReservations.set(token, needed);
    return () => this.slotReservations.delete(token);
    } finally { unlock(); if (this.slotLock === queued) this.slotLock = undefined; }
  };

  p.resolveTarget = async function (page, specification) {
    if (typeof specification === 'function') {
      const result = await specification(page);
      if (typeof result === 'boolean') return result;
      return result ? uniqueVisible(page, result) : null;
    }
    return specification ? uniqueVisible(page, specification) : null;
  };

  p.matchesTransition = async function (page, specification, operation) {
    if (typeof specification === 'function') return await specification(page) === true;
    const locator = await uniqueVisible(page, specification);
    if (!locator) return false;
    const actual = normalize(await locator.innerText().catch(() => ''));
    const expected = typeof operation.expected === 'string' && operation.expected.trim() ? operation.expected : specification.expected;
    if (typeof expected !== 'string' || !expected.trim()) return false;
    // Matching must include the actual query/record identity, not merely an
    // existing result container from an earlier question.
    return specification.match === 'contains' ? actual.includes(normalize(expected)) : actual === normalize(expected);
  };

  p.assertOperation = function (operation) {
    if (operation.cancelled || this.activeQuestion?.id !== operation.questionId || this.activeQuestion?.attempt !== operation.attempt) throw new Error('This transition belongs to an older question or attempt.');
  };

  p.watchMutations = async function (page, container) {
    const key = '__ailiteracy_' + crypto.randomUUID().replaceAll('-', '');
    let selector, ownerFrame;
    if (container && typeof container !== 'function') {
      const fallback = container.frame ? { frame: container.frame, css: 'body' } : { css: 'body' };
      const target = await uniqueVisible(page, container).catch(() => null) || await uniqueVisible(page, fallback).catch(() => null);
      if (target) {
        const handle = await target.elementHandle();
        if (handle) try {
          ownerFrame = await handle.ownerFrame();
          await handle.evaluate((element, key) => {
            const state = { changed: false, revision: 0 };
            state.observer = new MutationObserver(records => {
              state.revision++;
              if (!element.isConnected || records.some(record => record.target === element || element.contains(record.target))) state.changed = true;
            });
            state.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
            window[key] = state;
          }, key);
          selector = key;
        } finally { await handle.dispose(); }
      }
    }
    const read = async () => selector && ownerFrame ? await ownerFrame.evaluate(key => {
      const state = window[key];
      return state ? { changed: state.changed, revision: state.revision } : null;
    }, selector).catch(() => null) : null;
    return {
      read,
      changed: async () => (await read())?.changed === true,
      close: async () => { if (selector && ownerFrame && !page.isClosed()) await ownerFrame.evaluate(key => { window[key]?.observer.disconnect(); delete window[key]; }, selector).catch(() => {}); },
    };
  };

  p.transition = async function (sourceId, options) {
    const source = this.source(sourceId);
    return this.serial(source, async () => {
      const { questionId, fromPage, toRole, recipeId, trigger } = options;
      if (!['results', 'detail'].includes(toRole) || typeof trigger !== 'function' || !fromPage || fromPage.context() !== this.context || fromPage.isClosed()) throw new Error('Transition needs an owned fromPage, results/detail role and a real Playwright trigger.');
      const attempt = this.questionRecords.findLast(item => item.question_id === questionId);
      if (!attempt || attempt.completed || this.activeQuestion?.id !== questionId) throw new Error('Begin the current question before transitioning pages.');
      const recipe = recipeId ? this.recipe(recipeId) : null;
      if (recipe && recipe.source_id !== sourceId) throw new Error('Recipe belongs to another source.');
      const profile = recipe?.transitions?.[toRole] || {};
      const mode = options.mode ?? profile.mode;
      const container = options.container ?? profile.container;
      const ready = options.ready ?? profile.ready ?? container;
      const match = options.match ?? profile.match;
      const empty = options.empty ?? profile.empty;
      if (!MODES.includes(mode) || !container || !ready || !match) throw new Error('Observe this transition first: mode, unique container, ready and query/record match are required.');
      // Reuse only a descriptor's result within this poll, never custom checks or
      // native Locators that happen to have similar private implementation state.
      const sharedTarget = typeof ready !== 'function' && typeof container !== 'function'
        && (ready === container || typeof ready.count !== 'function' && typeof container.count !== 'function' && isDeepStrictEqual(ready, container));
      const query = options.query ?? options.expected ?? '';
      const expected = options.expected ?? options.recordId ?? query;
      if (typeof match !== 'function' && (typeof expected !== 'string' || !expected.trim()) && !match.expected) throw new Error('Supply the real query or record identity for the transition.');
      const operation = { questionId, attempt: attempt.attempt, fromPage, toRole, sourceId, actionId: crypto.randomUUID(), expected,
        query, filters: structuredClone(options.filters || {}), cancelled: false, options: { ...options, mode, container, ready, match, empty } };
      const old = this.activeTransitions.get(sourceId);
      if (old) old.cancelled = true;
      this.activeTransitions.set(sourceId, operation);
      const priorTarget = this.rolePages.get(sourceId)?.get(toRole);
      const existingTarget = mode === 'reuse-target' && priorTarget && !priorTarget.isClosed() ? priorTarget : null;
      const createsPage = mode === 'popup' || mode === 'reuse-target' && !existingTarget;
      if (createsPage && this.life(fromPage).uncertainPopupEpoch === this.documentEpochs.get(fromPage)) throw new Error('An earlier popup action did not settle. Reload and observe the search entry before submitting another query.');
      const releaseSlot = await this.reservePageSlot({ protect: [fromPage, ...(existingTarget ? [existingTarget] : [])], needed: createsPage ? 1 : 0 });
      const candidates = new Set(createsPage ? [] : [existingTarget || fromPage]);
      operation.candidates = candidates;
      const epochs = new Map([...candidates].map(page => [page, { document: this.documentEpochs.get(page), frame: this.frameEpochs.get(page) }]));
      const fresh = await this.watchMutations(existingTarget || fromPage, container);
      const listener = page => { this.trackPage(page); this.life(page).pendingOperation = operation.actionId; candidates.add(page); releaseSlot(); };
      // The opener event is attached before the click; no latest-tab heuristic.
      if (createsPage) fromPage.on('popup', listener);
      const startedAt = stamp();
      let completed = false;
      try {
        this.assertOperation(operation);
        await trigger(fromPage);
        this.assertOperation(operation);
        const deadline = Date.now() + (options.timeoutMs ?? this.options.navigationTimeoutMs);
        const quickChecks = new Map();
        while (Date.now() < deadline) {
          this.assertOperation(operation);
          for (const page of candidates) {
            if (page.isClosed() || !/^https?:/i.test(page.url())) continue;
            if (createsPage && await page.opener() !== fromPage) continue;
            const domains = source.domains?.length ? source.domains : [httpURL(source.url).hostname];
            if (!domainMatches(httpURL(page.url()).hostname, domains)) continue;
            const previous = epochs.get(page);
            const mutation = page === (existingTarget || fromPage) ? await fresh.read() : null;
            const documentEpoch = this.documentEpochs.get(page), frameEpoch = this.frameEpochs.get(page);
            const changed = !previous || previous.document !== documentEpoch || previous.frame !== frameEpoch || mutation?.changed;
            if (!changed) continue;
            const document = this.documentState(page);
            const revision = await this.observationRevision(page);
            const cached = quickChecks.get(page);
            // Continue polling completion and identity even with no DOM change:
            // CSS animations and custom checks can change readiness. Recheck the
            // full authorization text at least every 250 ms, and on any stamp
            // change. Missing frame/revision stamps disable this small cache.
            const reusable = revision && (!(mode === 'iframe' || container.frame) || mutation)
              && cached && Date.now() - cached.at < 250 && cached.url === page.url()
              && cached.documentEpoch === documentEpoch && cached.frameEpoch === frameEpoch
              && cached.status === document.status && cached.error === document.error
              && cached.mutationRevision === mutation?.revision && isDeepStrictEqual(cached.revision, revision);
            let classification = reusable ? cached.classification : null;
            if (!classification) {
              const quick = { url: page.url(), title: await page.title().catch(() => ''), text: await page.locator('body').innerText({ timeout: 1000 }).catch(() => ''), aria: '',
                controls: await page.locator('input[type="password"]').count() ? [{ type: 'password' }] : [], navigation_error: document.error };
              classification = this.classify(source, quick, document.status);
              quickChecks.set(page, { classification, revision, mutationRevision: mutation?.revision, documentEpoch, frameEpoch,
                url: quick.url, status: document.status, error: document.error, at: Date.now() });
            }
            if (classification.authorization !== 'not_observed') { const result = await this.finishTransition(operation, page, 'blocked'); completed = true; return result; }
            if (classification.availability !== 'reachable') continue;
            const matched = await this.matchesTransition(page, match, operation).catch(() => false);
            if (!matched) continue;
            const readyTarget = await this.resolveTarget(page, ready).catch(() => false);
            if (!readyTarget || !sharedTarget && !await this.resolveTarget(page, container).catch(() => null)) continue;
            const finished = await this.finishTransition(operation, page, 'ready');
            completed = true;
            this.log('transition_completed', { source_id: sourceId, question_id: questionId, action_id: operation.actionId, role: toRole, mode, started_at: startedAt, url: page.url() });
            return finished;
          }
          await pause(75);
        }
        throw new Error('No fresh result/detail page matched this question; observe the actual page and repair the flow.');
      } finally {
        if (createsPage) fromPage.off('popup', listener);
        releaseSlot();
        for (const page of candidates) this.life(page).pendingOperation = null;
        if (createsPage && !completed) this.life(fromPage).uncertainPopupEpoch = this.documentEpochs.get(fromPage);
        await fresh.close();
        if (this.activeTransitions.get(sourceId) === operation) this.activeTransitions.delete(sourceId);
      }
    });
  };

  p.finishTransition = async function (operation, page, status) {
    this.assertOperation(operation);
    const observation = await this.observe(page, { name: `${operation.toRole}-${operation.questionId}`, compact: true,
      focus: [String(operation.expected)], detail: operation.options.observationDetail ?? 'full' });
    this.assertOperation(operation);
    const full = this.observations.get(page).observed;
    const classification = this.classify(this.source(operation.sourceId), full, full.http_status);
    if (classification.authorization !== 'not_observed') status = 'blocked';
    else if (classification.availability !== 'reachable') throw new Error('Result/detail page is an error page.');
    let container = null;
    let outcome = status === 'ready' ? 'results' : 'failed';
    if (status === 'ready') {
      if (!await this.matchesTransition(page, operation.options.match, operation)) throw new Error('Result identity changed while observing the page.');
      container = await this.resolveTarget(page, operation.options.container);
      if (!container || container === true) throw new Error('A unique visible native result container is required.');
      if (operation.toRole === 'results' && operation.options.empty && await this.resolveTarget(page, operation.options.empty)) outcome = 'empty';
    }
    const binding = { source_id: operation.sourceId, question_id: operation.questionId, attempt: operation.attempt,
      action_id: operation.actionId, role: operation.toRole, mode: operation.options.mode, query_fingerprint: hash(JSON.stringify({ query: operation.query, filters: operation.filters, expected: operation.expected })),
      url: page.url(), document_epoch: this.documentEpochs.get(page), doc_epoch: this.documentEpochs.get(page), frame_epoch: this.frameEpochs.get(page),
      frame_scoped: operation.options.mode === 'iframe' || !!operation.options.container?.frame, status, outcome, bound_at: stamp() };
    this.bindRole(operation.sourceId, operation.toRole, page, binding);
    this.life(page).protected = status === 'blocked';
    this.transitionStates.set(`${operation.sourceId}:${operation.toRole}`, { operation, page });
    for (const extra of operation.candidates || []) {
      if (extra === page || extra === operation.fromPage || extra.isClosed()) continue;
      const life = this.life(extra);
      if (!life.binding && !life.protected && !life.preparation && await extra.opener() === operation.fromPage
        && !await this.preserveVerificationPage(extra)) await extra.close();
    }
    this.log('role_page_bound', binding);
    return { page, container, observation, binding: structuredClone(binding), status, outcome };
  };

  p.resumeTransition = async function (sourceId, { role = 'results', questionId, ...overrides } = {}) {
    const state = this.transitionStates.get(`${sourceId}:${role}`);
    if (!state || state.page.isClosed() || questionId && state.operation.questionId !== questionId) throw new Error('No matching transition checkpoint is available.');
    const operation = { ...state.operation, cancelled: false, options: { ...state.operation.options, ...overrides } };
    this.assertOperation(operation);
    const observed = await this.observe(state.page, { name: `resume-${sourceId}-${role}` });
    const classification = this.classify(this.source(sourceId), observed, observed.http_status);
    if (classification.authorization !== 'not_observed') return this.finishTransition(operation, state.page, 'blocked');
    if (!await this.resolveTarget(state.page, operation.options.ready) || !await this.matchesTransition(state.page, operation.options.match, operation)) throw new Error('After verification the page still does not match the current query or record.');
    return this.finishTransition(operation, state.page, 'ready');
  };

  p.assertTransitionEvidence = async function (page, questionId) {
    const binding = this.life(page).binding;
    if (!binding) {
      if (await page.opener()) throw new Error('An unbound popup is quarantined until its current query or record is verified.');
      return; // Direct owned pages with no opener retain the existing API.
    }
    if (binding.status !== 'ready' || binding.question_id !== questionId || this.activeQuestion?.id !== questionId || binding.attempt !== this.activeQuestion?.attempt || binding.document_epoch !== this.documentEpochs.get(page) || binding.frame_scoped && binding.frame_epoch !== this.frameEpochs.get(page)) throw new Error('This role page is blocked, stale or belongs to another question.');
    const state = this.transitionStates.get(`${binding.source_id}:${binding.role}`);
    if (!state || !await this.matchesTransition(page, state.operation.options.match, state.operation)) throw new Error('The current result identity no longer matches its question.');
  };

  p.completeQuestionPages = function (questionId) {
    for (const life of this.pageLife.values()) if (life.binding?.question_id === questionId || life.question_id === questionId) { life.completed = true; life.unfinished = false; }
  };
}

module.exports = { installTransitions, ROLES, MODES };
