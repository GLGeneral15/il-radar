'use strict';

// Program-memory warmup and persistent visible login tabs; no search preflight.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function signature(file) {
  const real = fs.realpathSync(file);
  const stat = fs.statSync(real, { bigint: true });
  if (!stat.isFile()) throw new Error('Managed asset is not a file: ' + file);
  return [real, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':');
}

function installPreparation(Session, { root, version, httpURL, hash }) {
  const p = Session.prototype;
  const manifest = path.join(root, 'runtime', 'package.json');
  const codeFiles = ['scripts/browser.cjs', 'scripts/preparation.cjs', 'scripts/asset-cache.cjs',
    'scripts/question-bank.cjs',
    'scripts/recipes.cjs', 'scripts/local-evidence.cjs', 'scripts/evidence-reuse.cjs',
    'scripts/search-runner.cjs', 'scripts/transitions.cjs', 'runtime/package.json', 'runtime/package-lock.json'];
  const loaded = new Map(codeFiles.map(relative => {
    const file = path.join(root, relative);
    const raw = fs.readFileSync(file);
    return [relative, { signature: signature(file), digest: digest(raw) }];
  }));
  let installedVersion = json(manifest).version;

  p.isBrowserConnected = function () {
    try { return Boolean(this.context?.browser()?.isConnected()); } catch { return false; }
  };

  p.codeStatus = function () {
    let reason = null;
    try {
      for (const [relative, original] of loaded) {
        const file = path.join(root, relative);
        const current = signature(file);
        if (current !== original.signature) {
          const raw = fs.readFileSync(file);
          if (relative === 'runtime/package.json') installedVersion = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')).version;
          if (digest(raw) !== original.digest) reason ||= 'Loaded helper differs from the installed file: ' + relative;
          else original.signature = current;
        }
      }
      if (installedVersion !== version) reason ||= 'Loaded helper and installed release versions differ.';
    } catch (error) { reason = 'Cannot verify the installed helper: ' + error.message; }
    return { status: reason ? 'reload_required' : 'current', helper_version: version,
      installed_version: installedVersion, reason };
  };

  p.assertCurrentCode = function () {
    const state = this.codeStatus();
    if (state.status === 'reload_required') {
      const error = new Error('需要刷新运行时：' + state.reason + '；当前浏览器和登录页面已保留。');
      error.code = 'RELOAD_REQUIRED';
      throw error;
    }
  };

  p.refreshSourceRegistry = function () {
    this.recipeStore.refresh();
    let base = this._baseCatalogSources;
    let catalogRevision = 'custom';
    if (!this.options.catalog) {
      const file = path.join(root, 'references', 'sources.json');
      catalogRevision = signature(file);
      if (this._sourceCatalogCache?.signature !== catalogRevision) {
        const value = json(file);
        const sources = Array.isArray(value) ? value : value.sources;
        if (!Array.isArray(sources) || !sources.length) throw new Error('Source catalog is empty.');
        this._sourceCatalogCache = { signature: catalogRevision, sources: clone(sources) };
      }
      base = this._sourceCatalogCache.sources;
    }
    const revision = catalogRevision + ':' + this.recipeStore.hash + ':' + this.additionalSources.length;
    if (revision === this._registryRevision) return;
    const sources = clone(base);
    const ids = new Set();
    for (const source of sources) {
      if (typeof source.id !== 'string' || !source.id || ids.has(source.id) || !source.name) throw new Error('Source IDs must be unique and names nonempty.');
      ids.add(source.id); httpURL(source.url);
    }
    for (const prepared of this.recipeStore.sources) {
      if (ids.has(prepared.id)) continue;
      if (!prepared.name || !prepared.url) throw new Error('Prepared additional sources need names and URLs.');
      const url = httpURL(prepared.url);
      sources.push({ id: prepared.id, name: prepared.name, url: prepared.url,
        domains: prepared.domains?.length ? [...prepared.domains] : [url.hostname], origin: 'prepared-site-profile' });
      ids.add(prepared.id);
    }
    for (const record of this.additionalSources) {
      const existing = sources.find(source => source.id === record.source.id);
      if (existing && hash(JSON.stringify({ name: existing.name, url: existing.url, domains: existing.domains })) !==
          hash(JSON.stringify({ name: record.source.name, url: record.source.url, domains: record.source.domains }))) {
        throw new Error('Additional source conflicts with the changed source registry.');
      }
      if (!existing) sources.push(clone(record.source));
    }
    this.sources = sources;
    this.registryTotal = sources.length;
    this._registryRevision = revision;
  };

  p.openPreparationSites = async function (sourceIds) {
    this.preparationPages ||= new Map();
    const results = new Array(sourceIds.length);
    let cursor = 0;
    const matches = (page, source) => {
      try {
        const hostname = httpURL(page.url()).hostname.toLowerCase();
        return (source.domains?.length ? source.domains : [httpURL(source.url).hostname])
          .some(domain => hostname === domain.toLowerCase() || hostname.endsWith('.' + domain.toLowerCase()));
      } catch { return false; }
    };
    const open = async sourceId => {
      const source = this.source(sourceId);
      return this.serial(source, async () => {
        let page = this.preparationPages.get(sourceId);
        if (!page || page.isClosed()) {
          const assigned = new Set(this.preparationPages.values());
          page = this.context.pages().find(candidate => !candidate.isClosed() && this.life(candidate).preparation
            && !assigned.has(candidate) && matches(candidate, source));
        }
        const result = { source_id: sourceId, name: source.name, requested_url: source.url };
        if (page && !page.isClosed()) {
          this.preparationPages.set(sourceId, page);
          return { ...result, status: 'reused', url: page.url() };
        }
        try {
          if (this.parkingPage && !this.parkingPage.isClosed() && this.parkingPage.url() === 'about:blank' && !this.life(this.parkingPage).busy) {
            page = this.parkingPage;
            this.parkingPage = undefined;
          } else page = await this.context.newPage();
          this.life(page).preparation = true;
          this.trackPage(page);
          this.preparationPages.set(sourceId, page);
          const response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs });
          if (response?.status() >= 400) throw new Error('HTTP ' + response.status());
          return { ...result, status: 'opened', url: page.url() };
        } catch (error) {
          // Keep the page so the user can sign in, refresh, or finish verification.
          return { ...result, status: 'failed', url: page && !page.isClosed() ? page.url() : null, message: error.message };
        }
      });
    };
    const worker = async () => {
      while (cursor < sourceIds.length) {
        const index = cursor++;
        try { results[index] = await open(sourceIds[index]); }
        catch (error) { results[index] = { source_id: sourceIds[index], status: 'failed', message: error.message }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, sourceIds.length) }, worker));
    return results;
  };

  p.prepare = function ({ sourceIds = this.prepareSourceIds ?? [] } = {}) {
    if (this._preparing) return this._preparing;
    if (!Array.isArray(sourceIds) || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => typeof id !== 'string' || !this.sources.some(source => source.id === id))) {
      return Promise.reject(new Error('Use unique sourceIds from the registry for preparation.'));
    }
    const selected = [...sourceIds];
    const task = (async () => {
      const code = this.codeStatus();
      const reused = this.isBrowserConnected();
      const summary = { session_id: this.sessionId, helper_version: code.helper_version, installed_version: code.installed_version,
        status: 'ready', browser_connected: reused, reused_live_session: reused,
        profiles_total: 0, profiles_loaded: 0, rules_total: 0, rules_loaded: 0,
        bank_total: 0, bank_eligible: 0, bank_review_required: 0,
        failures: [], preflight_ran: false, sites_total: selected.length,
        sites_opened: 0, sites_reused: 0, sites_failed: 0, sites: [] };
      if (code.status === 'reload_required') {
        summary.status = 'reload_required';
        summary.failures.push({ kind: 'runtime', message: code.reason });
        return summary;
      }
      // Start Chrome before reading local assets; both tasks complete in this call.
      const browser = this.start();
      const assets = Promise.resolve().then(() => {
        try { this.refreshSourceRegistry(); } catch (error) { summary.failures.push({ kind: 'sources', message: error.message }); }
        try {
          const profiles = this.recipeStore.preload();
          summary.profiles_total = profiles.indexed;
          summary.profiles_loaded = profiles.loaded;
          summary.failures.push(...profiles.failures.map(item => ({ kind: 'profile', ...item })));
        } catch (error) { summary.failures.push({ kind: 'profiles', message: error.message }); }
        try {
          const rules = this.preloadRules();
          summary.rules_total = rules.eligible;
          summary.rules_loaded = rules.loaded;
          summary.failures.push(...rules.failures.map(item => ({ kind: 'rule', ...item })));
        } catch (error) { summary.failures.push({ kind: 'rules', message: error.message }); }
        try {
          const bank = this.preloadQuestionBank();
          summary.bank_total = bank.total;
          summary.bank_eligible = bank.eligible;
          summary.bank_review_required = bank.review_required;
          summary.failures.push(...bank.failures.map(message => ({ kind: 'question_bank', message })));
        } catch (error) { summary.failures.push({ kind: 'question_bank', message: error.message }); }
      });
      const outcomes = await Promise.allSettled([browser, assets]);
      if (outcomes[0].status === 'rejected') summary.failures.push({ kind: 'browser', message: outcomes[0].reason.message });
      if (outcomes[1].status === 'rejected') summary.failures.push({ kind: 'assets', message: outcomes[1].reason.message });
      summary.browser_connected = this.isBrowserConnected();
      if (summary.browser_connected) {
        summary.sites = await this.openPreparationSites(selected);
        summary.sites_opened = summary.sites.filter(site => site.status === 'opened').length;
        summary.sites_reused = summary.sites.filter(site => site.status === 'reused').length;
        summary.sites_failed = summary.sites.filter(site => site.status === 'failed').length;
        summary.failures.push(...summary.sites.filter(site => site.status === 'failed')
          .map(site => ({ kind: 'site', source_id: site.source_id, message: site.message })));
      }
      summary.browser_connected = this.isBrowserConnected();
      summary.status = !summary.browser_connected ? 'blocked' : summary.failures.length ? 'partial' : 'ready';
      this.prepared = clone(summary);
      return summary;
    })();
    this._preparing = task;
    task.finally(() => { if (this._preparing === task) this._preparing = null; }).catch(() => {});
    return task;
  };
}

module.exports = { installPreparation };
