'use strict';

// This module calls the official Playwright library; it does not start a CLI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { RecipeStore } = require('./recipes.cjs');
const { installTransitions } = require('./transitions.cjs');
const { installLocalEvidence } = require('./local-evidence.cjs');
const { installEvidenceReuse } = require('./evidence-reuse.cjs');
const { installSearchRunner } = require('./search-runner.cjs');
const { installPreparation } = require('./preparation.cjs');
const { installQuestionBank, lookupQuestionBank, preloadQuestionBank } = require('./question-bank.cjs');
const ROOT = path.resolve(__dirname, '..');
const VERSION = '2.9.0';
const ASSESSMENT = { single: 30, multiple: 15, judge: 10, total_questions: 55, total_points: 100, duration_seconds: 3600, average_seconds_per_question: 3600 / 55 };
const CONFIDENCE = {
  verified: { default: 95, max: 99, basis: '本题答案和全部选项已依据实际捕获的来源核验。' },
  partial: { default: 65, max: 79, basis: '证据或逐项核验仍有缺口，需结合待核验说明复查。' },
  unverified: { default: 30, max: 49, basis: '尚未取得足够的原始证据核验本题。' },
  blocked: { default: 20, max: 49, basis: '访问或授权障碍使本题证据核验未完成。' },
  conflict: { default: 40, max: 59, basis: '来源或结论存在尚未解决的冲突。' },
};
const confidenceLevel = score => score >= 90 ? 'high' : score >= 60 ? 'medium' : 'low';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const normalize = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
const fileKey = value => String(value).replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 55) + '-' + hash(String(value)).slice(0, 8);
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}
function inside(root, child) {
  const relative = path.relative(root, child);
  return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function httpURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) URL without credentials.');
  return url;
}
function domainMatches(host, domains) {
  return domains.some(domain => host === domain.toLowerCase() || host.endsWith('.' + domain.toLowerCase()));
}
function siteKey(source) {
  const host = httpURL(source.url).hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host === 'localhost') return host;
  const labels = host.split('.');
  const suffix = labels.slice(-2).join('.');
  return labels.slice(/^(?:com|org|gov|net|edu)\.(?:cn|uk|au|jp)$/.test(suffix) ? -3 : -2).join('.');
}
function loadPlaywright(runtimeDir) {
  const manifest = path.join(runtimeDir, 'package.json');
  if (!fs.existsSync(manifest)) throw new Error('Playwright runtime is missing. Run this package setup.ps1 once.');
  const runtimeRequire = createRequire(manifest);
  const expected = readJSON(path.join(ROOT, 'runtime', 'package.json')).dependencies.playwright;
  const actual = runtimeRequire('playwright/package.json').version;
  if (actual !== expected) throw new Error(`Playwright runtime version ${actual} differs from pinned ${expected}; run setup.ps1 again.`);
  return runtimeRequire('playwright');
}
function chromeExecutable() {
  if (process.platform !== 'win32') return undefined;
  const drive = process.env.SystemDrive || 'C:';
  return [
    process.env['ProgramFiles(x86)'], process.env.ProgramFiles,
    drive + '/Program Files (x86)', drive + '/Program Files',
    process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local'),
  ].filter(Boolean).map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(file => fs.existsSync(file));
}
function checkSchema(value, schema, location = '$') {
  const types = {
    object: v => v !== null && typeof v === 'object' && !Array.isArray(v), array: Array.isArray, string: v => typeof v === 'string',
    number: v => typeof v === 'number' && Number.isFinite(v), integer: Number.isInteger, boolean: v => typeof v === 'boolean', null: v => v === null,
  };
  const accepted = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !accepted.some(type => types[type]?.(value))) throw new Error(`${location}: expected ${accepted.join(' or ')}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location}: invalid enum value`);
  if ('const' in schema && value !== schema.const) throw new Error(`${location}: invalid constant`);
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${location}: outside allowed range`);
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${location}: string too short`);
  if (accepted.includes('object') && types.object(value)) {
    for (const name of schema.required || []) if (!(name in value)) throw new Error(`${location}.${name}: required`);
    for (const [name, item] of Object.entries(value)) {
      if (!(name in (schema.properties || {}))) {
        if (schema.additionalProperties === false) throw new Error(`${location}.${name}: unexpected property`);
      } else checkSchema(item, schema.properties[name], `${location}.${name}`);
    }
  }
  if (accepted.includes('array') && Array.isArray(value)) value.forEach((item, i) => checkSchema(item, schema.items, `${location}[${i}]`));
}

function questionIdentity(questionOrId) {
  const id = typeof questionOrId === 'string' ? questionOrId : questionOrId?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('Question needs a nonempty string id.');
  if (typeof questionOrId === 'string') return { id, fingerprint: null };
  if (typeof questionOrId.question !== 'string') throw new Error('Question needs a string question.');
  const options = questionOrId.options || {};
  if (Array.isArray(options) || typeof options !== 'object') throw new Error('options must be an object mapping labels to text.');
  return { id, fingerprint: hash(JSON.stringify({ question: questionOrId.question, options: Object.entries(options).sort(([a], [b]) => a.localeCompare(b)) })) };
}

function presentObservation(observed, { compact = false, focus = [] } = {}) {
  if (!compact) return { ...observed, controls: observed.controls.map(control => ({ ...control })) };
  if (!Array.isArray(focus) || focus.some(term => typeof term !== 'string')) throw new Error('Observation focus must be an array of text terms.');
  const budget = 5000;
  const ranges = focus.filter(term => term.trim()).slice(0, 12).map(term => {
    const position = observed.text.toLowerCase().indexOf(term.toLowerCase());
    return position < 0 ? null : [Math.max(0, position - 600), Math.min(observed.text.length, position + term.length + 600)];
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  const excerpt = merged.length ? merged.map(([start, end]) => observed.text.slice(start, end)).join('\n…\n').slice(0, budget) : observed.text.slice(0, budget);
  // Preserve visible form controls before navigation links in the short return.
  const controls = [...observed.controls.filter(item => item.tag !== 'a'), ...observed.controls.filter(item => item.tag === 'a')].slice(0, 80)
    .map(control => Object.fromEntries(Object.entries(control).filter(([, value]) => value !== '')));
  return { ...observed, text: excerpt, aria: observed.aria.slice(0, 3000), controls,
    full_text_length: observed.text.length, full_aria_length: observed.aria.length, full_controls_count: observed.controls.length,
    truncated: { text: excerpt !== observed.text, aria: observed.aria.length > 3000, controls: controls.length < observed.controls.length },
  };
}

class SearchSession {
  constructor(options) {
    if (!options.sessionId || !/^[a-zA-Z0-9_-]{1,100}$/.test(options.sessionId)) throw new Error('Use a stable sessionId containing letters, digits, _ or -.');
    this.sessionId = options.sessionId;
    this.archive = options.archive ?? false;
    this.screenshots = options.screenshots ?? false;
    if (typeof this.archive !== 'boolean' || typeof this.screenshots !== 'boolean' || this.screenshots && !this.archive) throw new Error('archive/screenshots must be booleans; stored screenshots require archive:true.');
    this.evidenceReceipts = new WeakMap();
    if (options.browser !== undefined && options.browser !== 'chrome') throw new Error('This skill uses Google Chrome; browser must be chrome.');
    this.browser = 'chrome';
    this.maxPages = options.maxPages === undefined ? 5 : options.maxPages;
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 5) throw new Error('maxPages must be an integer from 1 to 5.');
    this.outputDir = path.resolve(options.outputDir || path.join(process.cwd(), '搜题结果', this.sessionId));
    this.runtimeDir = path.resolve(options.runtimeDir || process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime'));
    this.profileDir = path.resolve(options.profileDir || path.join(this.runtimeDir, 'profiles', this.browser, this.sessionId));
    if (!inside(path.join(this.runtimeDir, 'profiles'), this.profileDir) && !inside(this.outputDir, this.profileDir)) throw new Error('A custom profile must be inside this session output directory.');
    const catalog = options.catalog || readJSON(path.join(ROOT, 'references', 'sources.json'));
    this.sources = structuredClone(Array.isArray(catalog) ? catalog : catalog.sources);
    if (!Array.isArray(this.sources) || !this.sources.length) throw new Error('Source catalog is empty.');
    const ids = new Set();
    for (const source of this.sources) {
      if (!source.id || ids.has(source.id) || !source.name) throw new Error('Source IDs must be unique and names nonempty.');
      ids.add(source.id);
      httpURL(source.url);
    }
    this.catalogHash = hash(JSON.stringify(this.sources));
    this.catalogTotal = this.sources.length;
    const preflightIds = options.preflightSourceIds ?? [];
    if (!Array.isArray(preflightIds) || preflightIds.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(preflightIds).size !== preflightIds.length) throw new Error('preflightSourceIds must contain unique source IDs from the catalog.');
    this.preflightSourceIds = [...preflightIds];
    this.preflightSources = this.preflightSourceIds.map(id => this.sources.find(source => source.id === id));
    this._baseCatalogSources = structuredClone(this.sources);
    this.recipeStore = new RecipeStore(ROOT, options);
    for (const prepared of this.recipeStore.sources) {
      if (this.sources.some(source => source.id === prepared.id)) continue;
      if (!prepared.name || !prepared.url) throw new Error('Prepared additional sources need names and URLs.');
      httpURL(prepared.url);
      this.sources.push({ id: prepared.id, name: prepared.name, url: prepared.url,
        domains: prepared.domains?.length ? prepared.domains : [httpURL(prepared.url).hostname], origin: 'prepared-site-profile' });
    }
    this.registryTotal = this.sources.length;
    const prepareIds = options.prepareSourceIds ?? catalog.profile?.preparation_source_ids ?? [];
    if (!Array.isArray(prepareIds) || prepareIds.some(id => typeof id !== 'string' || !this.sources.some(source => source.id === id)) || new Set(prepareIds).size !== prepareIds.length) throw new Error('prepareSourceIds must contain unique source IDs from the registry.');
    this.prepareSourceIds = [...prepareIds];
    this.preparationPages = new Map();
    this.options = { headless: false, navigationTimeoutMs: 15000, maxPages: this.maxPages, ...options };
    this.pages = new Map();
    this.rolePages = new Map();
    this.pageLife = new Map();
    this.slotReservations = new Map();
    this.activeTransitions = new Map();
    this.transitionStates = new Map();
    this.activeQuestion = null;
    this.documents = new WeakMap();
    this.documentEpochs = new WeakMap();
    this.frameEpochs = new WeakMap();
    this.observations = new WeakMap();
    this.observedURLs = new Set();
    this.entryBindings = new WeakMap();
    this.locks = new Map();
    this.evidence = [];
    this.reportPath = path.join(this.outputDir, 'preflight.json');
    this.eventsPath = path.join(this.outputDir, 'events.jsonl');
    if (this.archive) fs.mkdirSync(this.outputDir, { recursive: true });
    const binding = path.join(this.outputDir, 'session.json');
    const descriptor = { version: VERSION, session_id: this.sessionId, browser: this.browser, catalog_sha256: this.catalogHash, profile_dir: this.profileDir, assessment: ASSESSMENT };
    if (fs.existsSync(binding)) {
      const previous = readJSON(binding);
      if (previous.browser !== this.browser) throw new Error('This output directory belongs to an older/different browser. Use a new Chrome session and output directory; previous evidence is preserved.');
      if (previous.session_id !== descriptor.session_id || previous.catalog_sha256 !== descriptor.catalog_sha256 || previous.profile_dir !== this.profileDir) throw new Error('This output directory belongs to a different session/catalog/profile.');
    } else if (this.archive) writeJSON(binding, { ...descriptor, started_at: stamp() });
    if (fs.existsSync(this.reportPath)) {
      this.report = readJSON(this.reportPath);
      if (this.report.session_id !== this.sessionId || this.report.catalog_sha256 !== this.catalogHash || !Array.isArray(this.report.entries)) throw new Error('Preflight report belongs to another session/catalog or is invalid.');
    }
    else this.report = { version: VERSION, session_id: this.sessionId, catalog_sha256: this.catalogHash, started_at: stamp(), completed: false, entries: [] };
    this.additionalSourcesPath = path.join(this.outputDir, 'additional-sources.json');
    this.additionalSources = [];
    if (fs.existsSync(this.additionalSourcesPath)) {
      const persisted = readJSON(this.additionalSourcesPath);
      if (persisted.session_id !== this.sessionId || persisted.catalog_sha256 !== this.catalogHash || !Array.isArray(persisted.records)) throw new Error('Additional sources belong to another session/catalog or are invalid.');
      for (const record of persisted.records) {
        const source = this.validateAdditionalSource(record.source);
        const existingSource = this.sources.find(item => item.id === source.id);
        if (existingSource && (existingSource.origin !== 'prepared-site-profile' || existingSource.name !== source.name || existingSource.url !== source.url || JSON.stringify([...(existingSource.domains || [])].sort()) !== JSON.stringify([...source.domains].sort()))) throw new Error('Additional source ID conflicts with an existing source.');
        if (typeof record.snapshot !== 'string' || !inside(this.outputDir, record.snapshot) || !fs.existsSync(record.snapshot)) throw new Error('Additional source has no saved observation from this session.');
        const observation = readJSON(record.snapshot);
        const classification = this.classify(source, observation, observation.http_status);
        if (observation.url !== source.url || classification.identity !== 'matched' || classification.availability !== 'reachable' || classification.authorization !== 'not_observed') throw new Error('Additional source observation does not verify its page identity.');
        if (!existingSource) this.sources.push(source);
        this.additionalSources.push({ ...record, source });
      }
    }
    this.refreshReportScope();
    const evidencePath = path.join(this.outputDir, 'evidence.jsonl');
    if (fs.existsSync(evidencePath)) this.evidence = fs.readFileSync(evidencePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    this.questionPath = path.join(this.outputDir, 'question-attempts.json');
    this.questionRecords = [];
    const legacyQuestionPath = path.join(this.outputDir, 'question-timers.json');
    const storedQuestions = fs.existsSync(this.questionPath) ? this.questionPath : legacyQuestionPath;
    if (fs.existsSync(storedQuestions)) {
      const persisted = readJSON(storedQuestions);
      if (persisted.session_id !== this.sessionId || !Array.isArray(persisted.records)) throw new Error('Question attempts belong to another session or are invalid.');
      this.questionRecords = persisted.records.map(item => ({ question_id: item.question_id, fingerprint: item.fingerprint,
        attempt: item.attempt, completed: item.completed ?? Boolean(item.finished_at) }));
    }
  }

  start() {
    try { this.assertCurrentCode(); } catch (error) { return Promise.reject(error); }
    if (this.isBrowserConnected()) return Promise.resolve(this);
    if (this._starting) return this._starting;
    const task = this._startBrowser();
    this._starting = task;
    task.finally(() => { if (this._starting === task) this._starting = null; }).catch(() => {});
    return task;
  }

  async _startBrowser() {
    const marker = path.join(this.profileDir, '.ailiteracy-profile.json');
    if (fs.existsSync(this.profileDir) && fs.readdirSync(this.profileDir).length && !fs.existsSync(marker)) throw new Error('Refusing to use an existing browser profile that is not owned by this skill.');
    if (fs.existsSync(marker)) {
      const owner = readJSON(marker);
      if (owner.session_id !== this.sessionId) throw new Error('Profile belongs to another search session.');
      if (owner.browser !== this.browser) throw new Error('Profile belongs to an older/different browser; create a separate Chrome profile.');
    }
    const executablePath = chromeExecutable();
    if (process.platform === 'win32' && !executablePath) throw new Error('Google Chrome is not installed in a standard location. Install Chrome before starting this skill.');
    fs.mkdirSync(this.profileDir, { recursive: true });
    writeJSON(marker, { session_id: this.sessionId, browser: this.browser, created_by: 'ai-literacy-search', version: VERSION });
    const { chromium } = loadPlaywright(this.runtimeDir);
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.browser, executablePath, headless: this.options.headless, viewport: { width: 1280, height: 900 }, acceptDownloads: true,
    });
    this._launchCount = (this._launchCount || 0) + 1;
    this.context.setDefaultTimeout(10000);
    this.context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    this.context.on('page', page => this.trackPage(page));
    // Restored working/login pages belong to the user. Only lend a blank page.
    const restored = this.context.pages();
    this.parkingPage = restored.find(page => page.url() === 'about:blank');
    if (!restored.length) this.parkingPage = await this.context.newPage();
    for (const page of this.context.pages()) {
      if (page !== this.parkingPage && page.url() !== 'about:blank') this.life(page).preparation = true;
      this.trackPage(page);
    }
    this.log('browser_started', { channel: this.browser, executable_path: executablePath || null, headless: this.options.headless });
    return this;
  }

  log(event, fields = {}) {
    if (this.archive) fs.appendFileSync(this.eventsPath, JSON.stringify({ at: stamp(), event, ...fields }) + '\n', 'utf8');
  }

  rememberEvidence(record, payload) {
    const saved = structuredClone(payload);
    this.evidenceReceipts.set(record, { payload: saved, digest: hash(JSON.stringify({ record, payload: saved })) });
  }

  evidencePayload(record) {
    const receipt = this.evidenceReceipts.get(record);
    if (!receipt || receipt.digest !== hash(JSON.stringify({ record, payload: receipt.payload }))) throw new Error('Evidence was not captured by this session or has changed.');
    return structuredClone(receipt.payload);
  }

  persistQuestions() {
    if (this.archive) writeJSON(this.questionPath, { version: VERSION, session_id: this.sessionId, records: this.questionRecords });
  }

  beginQuestion(questionOrId) {
    this.refreshReportScope();
    const { id, fingerprint } = questionIdentity(questionOrId);
    let record = this.questionRecords.findLast(item => item.question_id === id);
    if (record && !record.completed) {
      if (record.fingerprint && fingerprint && record.fingerprint !== fingerprint) throw new Error('The active question id belongs to different question text/options.');
      if (!record.fingerprint && fingerprint) { record.fingerprint = fingerprint; this.persistQuestions(); }
      this.activateQuestion(id, record.attempt);
      return { question_id: id, attempt: record.attempt, completed: false };
    }
    record = { question_id: id, fingerprint, attempt: (record?.attempt || 0) + 1, completed: false };
    this.questionRecords.push(record);
    this.activateQuestion(id, record.attempt);
    this.persistQuestions();
    this.log('question_started', { question_id: id, attempt: record.attempt });
    return { question_id: id, attempt: record.attempt, completed: false };
  }

  finishQuestion(question) {
    const { id, fingerprint } = questionIdentity(question);
    const record = this.questionRecords.findLast(item => item.question_id === id);
    if (record?.fingerprint && record.fingerprint !== fingerprint) throw new Error('Question text/options differ from this attempt; use a unique id or begin a new attempt.');
    if (record && !record.completed) {
      record.fingerprint ||= fingerprint;
      record.completed = true;
      this.persistQuestions();
    }
    return { question_id: id, attempt: record?.attempt ?? null, completed: true };
  }

  trackPage(page) {
    if (this.documents.has(page)) return;
    this.life(page);
    this.documents.set(page, { url: page.url(), status: null, error: null });
    this.documentEpochs.set(page, 0);
    this.frameEpochs.set(page, 0);
    page.on('framenavigated', frame => {
      this.frameEpochs.set(page, this.frameEpochs.get(page) + 1);
      if (frame === page.mainFrame()) this.documentEpochs.set(page, this.documentEpochs.get(page) + 1);
    });
    page.on('response', response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) this.documents.set(page, { url: response.url(), status: response.status(), error: null });
    });
    page.on('requestfailed', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) this.documents.set(page, { url: request.url(), status: null, error: request.failure()?.errorText || 'Navigation failed' });
    });
    page.on('close', () => this.forgetPage(page));
    this.enforceUnboundPopupLimit(page).catch(error => this.log('popup_limit_check_failed', { error: String(error.message) }));
  }

  documentState(page) {
    const state = this.documents.get(page);
    return state && state.url.split('#')[0] === page.url().split('#')[0] ? state : { url: page.url(), status: null, error: null };
  }

  async acquirePage() {
    if (this.parkingPage && !this.parkingPage.isClosed() && this.parkingPage.url() !== 'about:blank') {
      this.life(this.parkingPage).preparation = true;
      this.parkingPage = undefined;
    }
    if (this.parkingPage && !this.parkingPage.isClosed()) {
      const page = this.parkingPage; this.parkingPage = undefined; this.life(page).busy = true; return page;
    }
    const release = await this.reservePageSlot();
    try { const page = await this.context.newPage(); this.life(page).busy = true; return page; }
    finally { release(); }
  }

  async releasePage(page) {
    if (page.isClosed()) return;
    this.life(page).busy = false;
    if (await this.preserveVerificationPage(page)) return;
    if (!this.parkingPage || this.parkingPage.isClosed()) {
      this.parkingPage = page;
      await page.goto('about:blank').catch(() => {});
      Object.assign(this.life(page), { protected: false, completed: true, binding: null });
    } else await page.close().catch(() => {});
  }

  async preserveVerificationPage(page) {
    if (page.isClosed()) return false;
    const life = this.life(page);
    if (life.preparation || life.protected) {
      life.preparation = true;
      return true;
    }
    if (!/^https?:/i.test(page.url())) {
      if (page.url() === 'about:blank' && !await page.opener().catch(() => null)) return false;
      Object.assign(life, { preparation: true, protected: true });
      return true;
    }
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(5000, this.options.navigationTimeoutMs) });
      const observed = await this.currentObservation(page, { name: 'page-release-check', detail: 'status', maintenance: true });
      if (!observed.read_failed_fields?.length && observed.text?.trim()
        && this.classify({ url: observed.url }, observed, observed.http_status).authorization === 'not_observed') return false;
    } catch {
      // An unreadable page cannot be safely ruled out as a pending sign-in.
    }
    Object.assign(life, { preparation: true, protected: true });
    return true;
  }

  source(id) {
    this.refreshSourceRegistry();
    const source = this.sources.find(source => source.id === id);
    if (!source) throw new Error(`Unknown source ID: ${id}`);
    return source;
  }

  validateAdditionalSource(proposed) {
    if (!proposed || typeof proposed.id !== 'string' || !proposed.id.trim() || typeof proposed.name !== 'string' || !proposed.name.trim() || typeof proposed.url !== 'string') throw new Error('Additional source needs nonempty id, name and HTTP(S) URL.');
    const parsed = httpURL(proposed.url);
    const domains = proposed.domains === undefined ? [parsed.hostname] : proposed.domains;
    if (!Array.isArray(domains) || !domains.length || domains.some(domain => typeof domain !== 'string' || !domain || !/^[a-z0-9.-]+$/i.test(domain) || !(domain.includes('.') || domain === 'localhost'))) throw new Error('Additional source domains must be explicit hostnames.');
    const normalizedDomains = [...new Set(domains.map(domain => domain.toLowerCase()))];
    // A newly observed page proves only this host, not every publisher under a
    // parent domain or public suffix. Other hosts require their own observation.
    if (normalizedDomains.some(domain => domain !== parsed.hostname)) throw new Error('Each additional source domain must equal its observed URL hostname.');
    return { id: proposed.id, name: proposed.name, url: proposed.url, domains: normalizedDomains, origin: 'session-official' };
  }

  async addSource(proposed, { page } = {}) {
    const source = this.validateAdditionalSource(proposed);
    if (this.sources.some(item => item.id === source.id)) throw new Error('Additional source ID conflicts with an existing source.');
    if (!page || page.context() !== this.context || page.isClosed()) throw new Error('Register only a page owned by this session.');
    const recent = this.observations.get(page);
    if (!recent || recent.epoch !== this.documentEpochs.get(page) || recent.observed.url !== page.url() || page.url() !== source.url) throw new Error('Observe the actual current publisher page before registering its exact URL.');
    const observation = recent.observed;
    const classification = this.classify(source, observation, observation.http_status);
    if (classification.identity !== 'matched' || classification.availability !== 'reachable' || classification.authorization !== 'not_observed') throw new Error('Login/challenge/error or unrelated pages cannot register an official source.');
    const record = { source, snapshot: observation.artifact, observed_at: observation.observed_at };
    const records = [...this.additionalSources, record];
    if (this.archive) writeJSON(this.additionalSourcesPath, { version: VERSION, session_id: this.sessionId, catalog_sha256: this.catalogHash, records });
    this.additionalSources = records;
    this.sources.push(source);
    this.clearPageRole(page);
    this.entryBindings.set(page, { requested: source.url, final: observation.url });
    // Reuse the observed official page rather than navigating a second time.
    if (this.parkingPage === page) this.parkingPage = undefined;
    for (const [id, bound] of this.pages) if (bound === page) this.pages.delete(id);
    this.pages.set(source.id, page);
    this.updateEntry({ source_id: source.id, name: source.name, requested_url: source.url, final_url: observation.url,
      title: observation.title, http_status: observation.http_status, ...classification, search_status: 'untested',
      checked_at: observation.observed_at, attempts: 0, snapshot: observation.artifact, error: null });
    this.log('official_source_registered', { source_id: source.id, url: source.url, snapshot: observation.artifact });
    return source;
  }

  async serial(source, operation) {
    const key = siteKey(source);
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(key, current);
    try { return await current; }
    finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  async observe(page, { name = 'page', compact = false, focus = [], maintenance = false, detail = 'full' } = {}) {
    if (!page || page.context() !== this.context) throw new Error('Observe only pages owned by this session.');
    if (!['full', 'status'].includes(detail)) throw new Error('Observation detail must be full or status.');
    const started = performance.now();
    const before = await this.observationRevision(page);
    const readControls = () => page.locator('input,textarea,select,[role="searchbox"],[role="combobox"],button,a[href]').evaluateAll(elements => {
      const visible = elements.filter(element => {
        const style = getComputedStyle(element);
        return element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
      });
      // A large navigation menu must not push a visible login control outside
      // the bounded observation used for authorization checks.
      const password = element => (element.getAttribute('type') || '').toLowerCase() === 'password';
      return [...visible.filter(password), ...visible.filter(element => !password(element))].slice(0, 250).map(element => ({
        tag: element.tagName.toLowerCase(), type: (element.getAttribute('type') || '').toLowerCase(), role: element.getAttribute('role') || '',
        label: element.getAttribute('aria-label') || element.labels?.[0]?.innerText || '',
        placeholder: element.getAttribute('placeholder') || '', id: element.id || '', name: element.getAttribute('name') || '',
        text: ['A', 'BUTTON'].includes(element.tagName) ? (element.innerText || '').slice(0, 150) : '',
        href: element.tagName === 'A' ? element.href : '', disabled: !!element.disabled,
      }));
    });
    let title, text, aria = '', controls, headings = '', readFailures = [];
    if (detail === 'status') {
      try {
        // Known flows need current text, controls and blocking headings, not an
        // accessibility tree. Read them together from the same live document.
        const status = await page.evaluate(() => {
          if (!document.body) throw new Error('The current document has no body.');
          const visible = element => {
            const style = getComputedStyle(element);
            return element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const headingElements = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter(visible);
          const controlElements = Array.from(document.querySelectorAll('input,textarea,select,[role="searchbox"],[role="combobox"],button,a[href]')).filter(visible);
          const password = element => (element.getAttribute('type') || '').toLowerCase() === 'password';
          return {
            title: document.title, text: document.body.innerText,
            needsAria: headingElements.some(element => (element.getAttribute('aria-labelledby') || '').trim()
              || !(element.getAttribute('aria-label') || '').trim()
                && (!element.innerText?.trim() || element.matches('img,svg') || element.querySelector('img[alt],svg,[aria-label],[aria-labelledby]'))),
            headings: headingElements.map(element => {
                const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
                  .filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
                return labelledBy || element.getAttribute('aria-label') || element.innerText;
              }).join('\n'),
            controls: [...controlElements.filter(password), ...controlElements.filter(element => !password(element))]
              .slice(0, 250).map(element => ({
                tag: element.tagName.toLowerCase(), type: (element.getAttribute('type') || '').toLowerCase(), role: element.getAttribute('role') || '',
                label: element.getAttribute('aria-label') || element.labels?.[0]?.innerText || '',
                placeholder: element.getAttribute('placeholder') || '', id: element.id || '', name: element.getAttribute('name') || '',
                text: ['A', 'BUTTON'].includes(element.tagName) ? (element.innerText || '').slice(0, 150) : '',
                href: element.tagName === 'A' ? element.href : '', disabled: !!element.disabled,
              })),
          };
        });
        ({ title, text, controls, headings } = status);
        if (status.needsAria) detail = 'full';
      } catch {
        detail = 'full'; // Changed/loading documents retain the ordinary fallback.
      }
    }
    if (detail === 'full') {
      headings = ''; // Full ARIA resolves referenced and nested names itself.
      const fields = await Promise.allSettled([
        page.title(), page.locator('body').innerText({ timeout: 6000 }),
        page.locator('body').ariaSnapshot({ timeout: 6000 }), readControls(),
      ]);
      readFailures = fields.flatMap((field, index) => field.status === 'rejected' ? [['title', 'text', 'aria', 'controls'][index]] : []);
      [title, text, aria, controls] = fields.map((field, index) => field.status === 'fulfilled' ? field.value : index === 3 ? [] : '');
    }
    const artifact = this.archive ? path.join(this.outputDir, 'snapshots', `${fileKey(name)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`) : null;
    const document = this.documentState(page);
    const observed = { url: page.url(), title, text, aria, controls, headings, detail,
      http_status: document.status, navigation_error: document.error, observed_at: stamp(), artifact };
    if (readFailures.length) observed.read_failed_fields = readFailures;
    if (this.archive) writeJSON(artifact, observed);
    this.observedURLs.add(observed.url);
    for (const control of controls) if (/^https?:/i.test(control.href)) this.observedURLs.add(control.href);
    const after = await this.observationRevision(page);
    this.observations.set(page, { observed, epoch: this.documentEpochs.get(page), frameEpoch: this.frameEpochs.get(page),
      questionId: this.activeQuestion?.id ?? null, attempt: this.activeQuestion?.attempt ?? null,
      revision: after, stable: before?.token === after?.token && before?.revision === after?.revision
        && before?.controls === after?.controls && before?.title === after?.title && before?.url === after?.url
        && before?.renderedText === after?.renderedText && before?.renderedHeadings === after?.renderedHeadings });
    if (!maintenance && this.activeQuestion && !this.questionRecords.findLast(item => item.question_id === this.activeQuestion.id)?.completed) {
      Object.assign(this.life(page), { question_id: this.activeQuestion.id, attempt: this.activeQuestion.attempt, unfinished: true });
    }
    if (/^https?:/i.test(observed.url)) {
      const classification = this.classify({ url: observed.url }, observed, observed.http_status);
      this.life(page).protected = classification.authorization !== 'not_observed';
    }
    this.log('page_observed', { url: observed.url, title, artifact, duration_ms: Math.round((performance.now() - started) * 10) / 10 });
    return presentObservation(observed, { compact, focus });
  }

  async observationRevision(page) {
    return page.evaluate(() => {
      if (!document.documentElement) return null;
      const key = '__ailiteracyObservationRevision';
      let state = window[key];
      if (!state) {
        state = { token: String(performance.timeOrigin) + ':' + Math.random(), revision: 0 };
        const increment = () => state.revision++;
        state.observer = new MutationObserver(increment);
        state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        for (const event of ['input', 'change', 'resize']) window.addEventListener(event, increment, true);
        window[key] = state;
      }
      // Native control properties can change without a DOM mutation or event.
      // Keep the private stamp in memory; it is never written to evidence files.
      const controls = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]'))
        .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
        .map(element => [element.tagName, element.type, element.value ?? element.textContent,
          element.checked, element.selectedIndex, element.disabled, element.readOnly]);
      // CSS animations and stylesheet loading can change rendered evidence or
      // accessible heading names without a DOM mutation. The entire heading
      // subtree matters: a newly visible image/title/ARIA child can supply a
      // blocking name while the body's innerText remains exactly the same.
      const renderedHeadings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .map(element => {
          const pending = [element], visited = new Set(), rendered = [];
          for (const node of pending) {
            if (visited.has(node)) continue;
            visited.add(node);
            const style = getComputedStyle(node), before = getComputedStyle(node, '::before'), after = getComputedStyle(node, '::after');
            rendered.push([!!node.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none', node.innerText || '',
              before.content, before.visibility, before.display, after.content, after.visibility, after.display]);
            for (const child of node.children) pending.push(child);
            // Referenced accessible names can live outside the heading. Follow
            // their descendants and further references, with cycle protection.
            for (const id of (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
              const reference = document.getElementById(id);
              if (reference) pending.push(reference);
            }
          }
          return rendered;
        });
      return { token: state.token, revision: state.revision, title: document.title, url: location.href,
        controls: JSON.stringify(controls), renderedText: document.body?.innerText ?? '', renderedHeadings: JSON.stringify(renderedHeadings) };
    }).catch(() => null);
  }

  async currentObservation(page, options = {}) {
    if (!page || page.context() !== this.context || page.isClosed()) throw new Error('Read only pages owned by this session.');
    const detail = options.detail ?? 'full';
    if (!['full', 'status'].includes(detail)) throw new Error('Observation detail must be full or status.');
    const recent = this.observations.get(page);
    // These conditions already rule out reuse. Avoid a browser revision read
    // before observe() performs its own before/after checks on the live page.
    if (page.frames().length !== 1 || !recent?.stable || recent.observed.url !== page.url()
      || detail === 'full' && recent.observed.detail === 'status'
      || recent.epoch !== this.documentEpochs.get(page) || recent.frameEpoch !== this.frameEpochs.get(page)
      || recent.questionId !== (this.activeQuestion?.id ?? null) || recent.attempt !== (this.activeQuestion?.attempt ?? null)) {
      return this.observe(page, options);
    }
    const revision = await this.observationRevision(page);
    if (page.frames().length === 1 && recent?.stable && revision && recent.observed.url === page.url()
      && (detail === 'status' || recent.observed.detail !== 'status')
      && recent.epoch === this.documentEpochs.get(page) && recent.frameEpoch === this.frameEpochs.get(page)
      && recent.questionId === (this.activeQuestion?.id ?? null) && recent.attempt === (this.activeQuestion?.attempt ?? null)
      && recent.revision.token === revision.token && recent.revision.revision === revision.revision
      && recent.revision.title === revision.title && recent.revision.url === revision.url
      && recent.revision.controls === revision.controls
      && recent.revision.renderedText === revision.renderedText && recent.revision.renderedHeadings === revision.renderedHeadings) {
      this.log('observation_reused', { question_id: this.activeQuestion?.id ?? null, url: page.url(), artifact: recent.observed.artifact });
      return presentObservation(recent.observed, options);
    }
    return this.observe(page, options);
  }

  classify(source, observation, status) {
    const host = httpURL(observation.url).hostname;
    const domains = source.domains?.length ? source.domains : [httpURL(source.url).hostname];
    const matched = domainMatches(host, domains);
    const heading = [observation.headings || '', observation.aria.split('\n').filter(line => /heading/.test(line)).join('\n')].join('\n');
    const prominent = `${observation.title}\n${heading}\n${observation.text.length < 2000 ? observation.text : observation.text.slice(0, 300)}`;
    const challenge = /安全验证|人机验证|正在对访问请求进行人机识别检测|请完成.{0,15}(验证|拼图)|verify (?:that )?you are human|checking your browser|just a moment|access.*captcha/i.test(prominent);
    const password = observation.controls.some(control => control.type === 'password');
    const loginPage = /(?:^|\/)(?:login|signin|sso|passport)(?:[/.?]|$)/i.test(new URL(observation.url).pathname);
    const denied = status === 403 || /access denied|访问被拒绝|无权访问|没有访问权限|请求过于频繁|too many requests/i.test(prominent);
    const loginRequired = /请先登录(?:后|再)?(?:检索|搜索|查看|阅读|访问)|登录后(?:才可|方可|才能|查看全文|继续访问)|sign in (?:to continue|to access)|log in (?:to continue|to access)/i.test(prominent);
    const pageError = /502 bad gateway|503 service unavailable|检索服务错误|内部服务器错误|服务暂时不可用|无法访问此网站/i.test(`${observation.title}\n${heading}`);
    const authorization = challenge ? 'challenge' : denied ? 'access_denied' : password || loginPage || loginRequired || status === 401 ? 'login_required' : 'not_observed';
    const keyword = /搜索|检索|查询|查找|search|keyword|关键词|篇名|标准号|书名|专利号/i;
    const searchControls = observation.controls.filter(control => !control.disabled && control.type !== 'password' &&
      (['search', 'searchbox'].includes(control.type) || control.role === 'searchbox' ||
       (['input', 'textarea', 'select'].includes(control.tag) || control.role === 'combobox') && keyword.test(`${control.label} ${control.placeholder} ${control.name} ${control.id}`)));
    return {
      availability: observation.navigation_error ? 'network_error' : !matched ? 'unexpected_redirect' : status >= 400 || pageError ? 'http_error' : 'reachable',
      identity: matched ? 'matched' : 'mismatch', authorization,
      search_ready: searchControls.length > 0 && authorization === 'not_observed' && matched && !observation.navigation_error && !(status >= 400) && !pageError,
      search_controls: searchControls,
      search_links: observation.controls.filter(control => control.tag === 'a' && keyword.test(control.text)).map(({ text, href }) => ({ text, href })).slice(0, 20),
    };
  }

  async inspect(source, page, observationOptions = {}) {
    let response;
    let error;
    let attempts = 0;
    for (attempts = 1; attempts <= 3; attempts++) {
      const started = performance.now();
      try {
        response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs });
        this.log('navigation_completed', { source_id: source.id, attempt: attempts, url: page.url(), http_status: response?.status() || null, duration_ms: Math.round((performance.now() - started) * 10) / 10 });
        error = undefined;
        break;
      } catch (caught) {
        error = String(caught.message).slice(0, 1200);
        this.log('navigation_failed', { source_id: source.id, attempt: attempts, error, duration_ms: Math.round((performance.now() - started) * 10) / 10 });
        if (!/timeout|ERR_(?:CONNECTION|NAME|TIMED|NETWORK|EMPTY_RESPONSE)|ENOTFOUND|ECONN/i.test(error) || attempts === 3) break;
      }
    }
    await this.observe(page, { ...observationOptions, name: `preflight-${source.id}` });
    // Display trimming must not remove a late password/control or heading from
    // the entry's actual authorization classification.
    const observation = this.observations.get(page).observed;
    this.entryBindings.set(page, { requested: source.url, final: observation.url });
    const status = response?.status() || null;
    const classification = /^https?:/.test(observation.url) ? this.classify(source, observation, status) : { availability: 'network_error', identity: 'unconfirmed', authorization: 'not_observed', search_ready: false, search_controls: [], search_links: [] };
    if (error) Object.assign(classification, { availability: 'network_error', identity: 'unconfirmed', authorization: 'not_observed', search_ready: false, search_controls: [], search_links: [] });
    const previous = this.report.entries.find(entry => entry.source_id === source.id);
    return {
      source_id: source.id, name: source.name, requested_url: source.url, final_url: observation.url,
      title: observation.title, http_status: status, ...classification,
      search_status: error || classification.authorization !== 'not_observed' ? 'untested' : previous?.search_status || 'untested', checked_at: stamp(), attempts,
      snapshot: observation.artifact, error: error || null,
    };
  }

  refreshReportScope() {
    const targetIds = new Set(this.preflightSourceIds);
    for (const entry of this.report.entries) entry.startup_target = targetIds.has(entry.source_id);
    const checkedIds = new Set(this.report.entries.filter(entry => entry.startup_target).map(entry => entry.source_id));
    this.report.version = VERSION;
    this.report.initialization_source_ids = [...this.preflightSourceIds];
    this.report.catalog_total = this.catalogTotal;
    this.report.registry_source_total = this.registryTotal;
    this.report.max_pages = this.maxPages;
    this.report.max_parallel_sites = this.maxPages;
    this.report.recipe_sha256 = this.recipeStore.hash;
    this.report.additional_source_total = this.additionalSources.length;
    this.report.initialization_total = this.preflightSourceIds.length;
    this.report.initialization_checked = checkedIds.size;
    this.report.completed = this.preflightSourceIds.every(id => checkedIds.has(id));
    const summarize = entries => entries.reduce((counts, entry) => {
      counts[entry.availability] = (counts[entry.availability] || 0) + 1;
      if (entry.authorization !== 'not_observed') counts[entry.authorization] = (counts[entry.authorization] || 0) + 1;
      if (entry.search_ready) counts.search_ready = (counts.search_ready || 0) + 1;
      return counts;
    }, {});
    this.report.summary = summarize(this.report.entries);
    this.report.initialization_summary = summarize(this.report.entries.filter(entry => entry.startup_target));
  }

  persistReport() {
    this.refreshReportScope();
    this.report.entries.sort((a, b) => this.sources.findIndex(s => s.id === a.source_id) - this.sources.findIndex(s => s.id === b.source_id));
    this.report.updated_at = stamp();
    if (!this.archive) return;
    writeJSON(this.reportPath, this.report);
    const escape = text => String(text ?? '').replace(/[|\r\n]/g, ' ');
    const markdown = `# 网站初始化自检\n\n会话：${this.sessionId}；启动范围已检查：${this.report.initialization_checked}/${this.report.initialization_total}；启动检查完成：${this.report.completed}；更新：${this.report.updated_at}\n\n基础来源目录：${this.catalogTotal}条；准备站点目录：${this.registryTotal}条；本会话追加官方来源：${this.additionalSources.length}条。完成状态只针对指定启动范围，不代表全部来源可用或全部已检查。\n\n搜索入口就绪仅表示观察到了控件；搜索成功由真实题目查询另行验证。启动范围外的条目为按需或历史检查记录。\n\n|来源|范围|页面状态|授权状态|搜索入口|实际搜索|最终网址|\n|---|---|---|---|---|---|---|\n` + this.report.entries.map(entry => `|${escape(entry.name)}|${entry.startup_target ? '启动自检' : '按需/历史检查'}|${entry.availability}|${entry.authorization}|${entry.search_ready ? '就绪' : '待检查'}|${entry.search_status}|${escape(entry.final_url)}|`).join('\n') + '\n';
    fs.writeFileSync(path.join(this.outputDir, 'preflight.md'), markdown, 'utf8');
  }

  updateEntry(entry) {
    const index = this.report.entries.findIndex(item => item.source_id === entry.source_id);
    if (index === -1) this.report.entries.push(entry); else this.report.entries[index] = entry;
    this.persistReport();
  }

  async preflight({ onProgress, sourceIds } = {}) {
    if (this._preflight) return this._preflight;
    if (sourceIds !== undefined) {
      if (!Array.isArray(sourceIds) || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => typeof id !== 'string' || !this.sources.some(source => source.id === id))) throw new Error('Use unique sourceIds from this session for optional preflight.');
      this.preflightSourceIds = [...sourceIds];
      this.preflightSources = sourceIds.map(id => this.source(id));
    }
    this.refreshReportScope();
    if (this.report.completed) { this.persistReport(); return this.report; }
    await this.start();
    this._preflight = (async () => {
      // Group before assigning workers so waiting for one domain never occupies all workers.
      const groups = new Map();
      for (const source of this.preflightSources) {
        if (this.report.entries.some(entry => entry.source_id === source.id)) continue;
        const key = siteKey(source);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(source);
      }
      const queue = [...groups.values()];
      let cursor = 0;
      const worker = async () => {
        let page;
        try {
          while (cursor < queue.length) {
            const group = queue[cursor++];
            for (const source of group) {
              if (!page || this.life(page).protected || this.life(page).preparation) {
                if (page) await this.releasePage(page);
                page = await this.acquirePage();
              }
              const entry = await this.serial(source, () => this.inspect(source, page));
              this.updateEntry(entry);
              if (onProgress) await onProgress({ completed: this.report.initialization_checked, total: this.report.initialization_total, entry });
            }
          }
        } finally { if (page) await this.releasePage(page); }
      };
      await Promise.all(Array.from({ length: Math.min(this.maxPages, queue.length) }, worker));
      this.persistReport();
      this.log('preflight_completed', { count: this.report.initialization_checked, total: this.report.initialization_total, source_ids: this.preflightSourceIds, summary: this.report.initialization_summary });
      return this.report;
    })();
    try { return await this._preflight; } finally { this._preflight = undefined; }
  }

  checkedEntryURL(source, entryUrl) {
    const parsed = httpURL(entryUrl);
    if (!domainMatches(parsed.hostname, source.domains?.length ? source.domains : [httpURL(source.url).hostname])) throw new Error('The entry URL is outside this source domain.');
    if (entryUrl === source.url || this.observedURLs.has(entryUrl)) return entryUrl;
    const entry = this.report.entries.find(item => item.source_id === source.id);
    if (entry?.snapshot && fs.existsSync(entry.snapshot)) {
      const observed = readJSON(entry.snapshot);
      if (observed.url === entryUrl || observed.controls?.some(control => control.href === entryUrl) || entry.requested_url === entryUrl && observed.url === entry.final_url) {
        this.observedURLs.add(entryUrl);
        return entryUrl;
      }
    }
    throw new Error('The entry URL has not been observed in this session; read the actual source page first.');
  }

  async pageResult(page, sourceId, { withObservation, compact, focus, detail }, reuseObservation) {
    if (!withObservation) return page;
    const recent = this.observations.get(page);
    const observation = reuseObservation && recent && recent.observed.url === page.url() && recent.epoch === this.documentEpochs.get(page)
      && (detail === 'status' || recent.observed.detail !== 'status')
      ? presentObservation(recent.observed, { compact, focus }) : await this.currentObservation(page, { name: `source-${sourceId}`, compact, focus, detail });
    return { page, observation };
  }

  async page(sourceId, { role = 'search', recipeId, entryUrl, withObservation = false, compact = false, focus = [], resetEntry = false, detail = 'full' } = {}) {
    if (!['search', 'results', 'detail'].includes(role)) throw new Error('Unknown page role.');
    if (typeof resetEntry !== 'boolean' || !['full', 'status'].includes(detail)) throw new Error('Use a boolean resetEntry and full/status observation detail.');
    if (role !== 'search') return this.pageResult(this.rolePage(sourceId, role), sourceId, { withObservation, compact, focus, detail }, false);
    const source = this.source(sourceId);
    if (recipeId) {
      const recipe = this.recipe(recipeId);
      if (recipe.source_id !== sourceId) throw new Error('Recipe belongs to another source.');
      if (!['query_verified', 'entry_verified', 'entry_observed'].includes(recipe.status)) throw new Error('Prepared entry is blocked or not verified; inspect its official source first.');
      if (!recipe.entry_url) throw new Error('Recipe has no verified entry URL.');
      if (entryUrl !== undefined && entryUrl !== recipe.entry_url) throw new Error('Do not override a prepared recipe with an unrelated entry URL.');
      const parsed = httpURL(recipe.entry_url);
      if (!domainMatches(parsed.hostname, source.domains?.length ? source.domains : [httpURL(source.url).hostname])) throw new Error('Prepared entry is outside its verified source domains.');
      entryUrl = recipe.entry_url;
    }
    const inspectionSource = entryUrl === undefined ? source : { ...source, url: recipeId ? entryUrl : this.checkedEntryURL(source, entryUrl) };
    const observationOptions = { withObservation, compact, focus, detail };
    if (this.pages.has(sourceId) && !this.pages.get(sourceId).isClosed()) {
      const existing = this.pages.get(sourceId); this.pages.delete(sourceId); this.pages.set(sourceId, existing);
      const binding = this.entryBindings.get(existing);
      const uncertainPopup = this.life(existing).uncertainPopupEpoch === this.documentEpochs.get(existing);
      const alreadyAtEntry = existing.url() === entryUrl || binding?.requested === entryUrl && binding.final === existing.url();
      if (resetEntry || entryUrl !== undefined && (!alreadyAtEntry || uncertainPopup)) {
        // Do not navigate away from a live login/challenge, including one that
        // appeared since the last saved observation. Completed verification is
        // checked again here rather than trusting the old protected flag.
        if (/^https?:/i.test(existing.url())) {
          const current = await this.currentObservation(existing, { name: `entry-check-${sourceId}`, detail: 'status' });
          if (this.classify(inspectionSource, current, current.http_status).authorization !== 'not_observed') {
            return this.pageResult(existing, sourceId, observationOptions, true);
          }
        }
        const entry = await this.serial(source, () => this.inspect(inspectionSource, existing, observationOptions));
        this.updateEntry(entry);
        if (entry.identity === 'matched' && entry.availability === 'reachable' && entry.authorization === 'not_observed') this.clearPageRole(existing);
        return this.pageResult(existing, sourceId, observationOptions, true);
      }
      return this.pageResult(existing, sourceId, observationOptions, false);
    }
    for (const [id, old] of this.pages) if (old.isClosed()) this.pages.delete(id);
    const page = await this.acquirePage();
    this.pages.set(sourceId, page);
    const entry = await this.serial(source, () => this.inspect(inspectionSource, page, observationOptions));
    this.life(page).busy = false;
    this.updateEntry(entry);
    if (entry.identity === 'matched' && entry.availability === 'reachable' && entry.authorization === 'not_observed') this.clearPageRole(page);
    return this.pageResult(page, sourceId, observationOptions, true);
  }

  async recheck(sourceId, { role = 'search' } = {}) {
    const source = this.source(sourceId);
    const page = role === 'search' ? this.pages.get(sourceId) : this.rolePages.get(sourceId)?.get(role);
    return this.serial(source, async () => {
      // Keep the user-verified page and cookies; refresh the actual current page state.
      if (page && !page.isClosed()) {
        const observation = await this.observe(page, { name: `recheck-${sourceId}` });
        const old = this.report.entries.find(entry => entry.source_id === sourceId) || {};
        const entry = { ...old, source_id: source.id, name: source.name, requested_url: source.url, final_url: observation.url, title: observation.title,
          ...this.classify(source, observation, observation.http_status), http_status: observation.http_status, search_status: 'untested', checked_at: stamp(), snapshot: observation.artifact, error: observation.navigation_error };
        this.updateEntry(entry);
        if (role !== 'search' && this.transitionStates.has(`${sourceId}:${role}`)) {
          const resumed = await this.resumeTransition(sourceId, { role }).catch(() => null);
          entry.transition_status = resumed?.status || 'needs_observation';
          entry.binding = resumed?.binding || null;
          this.persistReport();
        }
        return entry;
      }
      const temporary = await this.acquirePage();
      try { const entry = await this.inspect(source, temporary); this.updateEntry(entry); return entry; }
      finally { await this.releasePage(temporary); }
    });
  }

  async recordSearch(sourceId, { page, query, filters = {}, outcome, detail = '' }) {
    this.source(sourceId);
    if (!['results', 'empty', 'failed'].includes(outcome) || !String(query).trim()) throw new Error('Record a real query and results/empty/failed outcome.');
    if (outcome !== 'failed') await this.assertTransitionEvidence(page, this.activeQuestion?.id);
    const observation = await this.currentObservation(page, { name: `search-${sourceId}`, detail: 'status' });
    const existing = this.report.entries.find(entry => entry.source_id === sourceId);
    if (!existing) throw new Error('Check this source before recording searches.');
    const classification = this.classify(this.source(sourceId), observation, observation.http_status);
    if (outcome !== 'failed' && (classification.authorization !== 'not_observed' || classification.availability !== 'reachable' || classification.identity !== 'matched')) throw new Error('Login, challenge, error or unrelated pages cannot be recorded as successful search results.');
    const entry = { ...existing, ...classification, final_url: observation.url, title: observation.title,
      search_status: outcome, last_search: { query, filters, detail, at: stamp(), snapshot: observation.artifact } };
    this.updateEntry(entry);
    this.log('search_observed', { source_id: sourceId, query, filters, outcome, detail, snapshot: observation.artifact });
    return entry;
  }

  async captureEvidence(page, { evidence, ...options }) {
    const captured = await this.captureEvidenceBatch(page, { ...options, excerpts: [evidence] });
    return { source: captured.sources[0], artifact: captured.artifact };
  }

  async captureEvidenceBatch(page, { questionId, name, query, field, locator, excerpts, target, screenshot = this.screenshots }) {
    const started = performance.now();
    for (const value of [questionId, name, query, field, locator]) if (typeof value !== 'string' || !value.trim()) throw new Error('Evidence requires questionId/name/query/field/locator.');
    if (!Array.isArray(excerpts) || !excerpts.length || excerpts.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Evidence requires a nonempty array of real text excerpts.');
    if (typeof screenshot !== 'boolean' || screenshot && !this.archive) throw new Error('Stored screenshots require archive:true.');
    const attempt = this.questionRecords.findLast(item => item.question_id === questionId);
    if (!attempt?.fingerprint || attempt.completed || this.activeQuestion?.id !== questionId || this.activeQuestion?.attempt !== attempt.attempt) throw new Error('Begin the complete current question before collecting evidence.');
    httpURL(page.url());
    if (target && target.page() !== page) throw new Error('The evidence locator belongs to another page.');
    await this.assertTransitionEvidence(page, questionId);
    const initialURL = page.url();
    const initialEpoch = this.documentEpochs.get(page);
    const initialFrameEpoch = this.frameEpochs.get(page);
    const ensureSameDocument = () => {
      if (page.url() !== initialURL || this.documentEpochs.get(page) !== initialEpoch || target && this.frameEpochs.get(page) !== initialFrameEpoch) throw new Error('The page or evidence frame navigated during evidence capture; observe the current document and retry.');
    };
    const initialRevision = await this.observationRevision(page);
    const observation = await this.currentObservation(page, { name: `evidence-${questionId}`, detail: 'status' });
    const visibleText = target ? await target.innerText() : observation.text;
    ensureSameDocument();
    const normalizedText = normalize(visibleText);
    // Validate the whole batch before recording any of its sources.
    if (excerpts.some(excerpt => !normalizedText.includes(normalize(excerpt)))) throw new Error('An evidence excerpt was not found in the observed page/locator.');
    const known = this.sources.find(source => domainMatches(new URL(initialURL).hostname, source.domains || [new URL(source.url).hostname]));
    const classification = this.classify(known || { url: initialURL }, observation, observation.http_status);
    if (classification.authorization !== 'not_observed' || classification.availability !== 'reachable') throw new Error('Login/challenge/error pages are not factual evidence.');
    const captureId = crypto.randomUUID();
    const capturePath = this.archive ? observation.artifact.replace(/\.json$/, '.' + captureId) : null;
    const screenshotPath = screenshot ? capturePath + '.png' : null;
    if (screenshot) await page.screenshot({ path: screenshotPath, caret: 'initial' });
    ensureSameDocument();
    const capturedRevision = await this.observationRevision(page);
    if (!initialRevision || !capturedRevision || initialRevision.token !== capturedRevision.token
      || initialRevision.controls !== capturedRevision.controls
      || initialRevision.title !== capturedRevision.title || initialRevision.url !== capturedRevision.url
      ) {
      throw new Error('The page or evidence text changed during capture; re-read the current result before saving evidence.');
    }
    // Screenshot styles, adverts and clocks may change unrelated rendered
    // content. Recheck excerpts and current authorization for DOM or CSS
    // changes instead of rejecting an unchanged factual excerpt.
    const renderedChanged = initialRevision.renderedText !== capturedRevision.renderedText
      || initialRevision.renderedHeadings !== capturedRevision.renderedHeadings;
    const pageChanged = initialRevision.revision !== capturedRevision.revision || renderedChanged;
    if (target || pageChanged) {
      const current = pageChanged ? await this.currentObservation(page, { name: `evidence-recheck-${questionId}`, detail: 'status' }) : observation;
      const currentText = target ? await target.innerText() : current.text;
      if (excerpts.some(excerpt => !normalize(currentText).includes(normalize(excerpt)))) throw new Error('The cited evidence changed during capture; re-read the current result.');
      const currentBody = target && !pageChanged ? await page.locator('body').innerText() : current.text;
      const currentClass = this.classify(known || { url: initialURL }, { ...current, text: currentBody }, current.http_status);
      if (currentClass.authorization !== 'not_observed' || currentClass.availability !== 'reachable') throw new Error('The page became blocked during capture; resume after authorization.');
    }
    ensureSameDocument();
    await this.assertTransitionEvidence(page, questionId);
    const retrievedAt = stamp();
    const sources = excerpts.map(evidence => ({ name, url: initialURL, query, field, evidence, locator, retrieved_at: retrievedAt }));
    const targetText = { url: initialURL, locator, text: visibleText, captured_at: retrievedAt };
    const targetTextPath = this.archive ? capturePath + '.target.json' : null;
    if (this.archive) writeJSON(targetTextPath, targetText);
    const artifact = this.archive
      ? { storage: 'archive', snapshot: observation.artifact, screenshot: screenshotPath, target_text: targetTextPath, text_sha256: hash(visibleText) }
      : { storage: 'memory', id: captureId, text_sha256: hash(visibleText) };
    const provenance = { session_id: this.sessionId, question_fingerprint: attempt.fingerprint, attempt: attempt.attempt };
    const records = sources.map(source => ({ kind: 'web', question_id: questionId, provenance, source, artifact }));
    for (const record of records) this.rememberEvidence(record, { observation, targetText });
    if (this.archive) fs.appendFileSync(path.join(this.outputDir, 'evidence.jsonl'), records.map(record => JSON.stringify(record) + '\n').join(''), 'utf8');
    this.evidence.push(...records);
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    for (const source of sources) this.log('evidence_captured', { question_id: questionId, url: source.url, artifact });
    this.log('evidence_batch_captured', { question_id: questionId, url: initialURL, count: sources.length, artifact, duration_ms: durationMs });
    return { sources, artifact };
  }

  validateWebEvidence(record, question) {
    try {
      const identity = questionIdentity(question);
      const attempt = this.questionRecords.findLast(item => item.question_id === identity.id);
      if (record?.kind !== 'web' || record.question_id !== identity.id || record.provenance?.session_id !== this.sessionId
        || record.provenance.question_fingerprint !== identity.fingerprint || record.provenance.attempt !== attempt?.attempt) throw new Error('Website evidence belongs to a different question or attempt.');
      let payload;
      if (record.artifact?.storage === 'memory') payload = this.evidencePayload(record);
      else {
        const artifact = record.artifact;
        for (const key of ['snapshot', 'target_text', ...(artifact?.screenshot ? ['screenshot'] : [])]) {
          const file = artifact?.[key];
          if (typeof file !== 'string' || !inside(this.outputDir, file) || !fs.existsSync(file)
            || !inside(fs.realpathSync(this.outputDir), fs.realpathSync(file))) throw new Error('Archived evidence is missing or outside this session.');
        }
        payload = { observation: readJSON(artifact.snapshot), targetText: readJSON(artifact.target_text) };
      }
      const target = payload.targetText;
      if (payload.observation.url !== record.source.url || target.url !== record.source.url || target.locator !== record.source.locator
        || target.captured_at !== record.source.retrieved_at || hash(target.text) !== record.artifact.text_sha256
        || !normalize(target.text).includes(normalize(record.source.evidence))) throw new Error('Evidence excerpt or provenance is inconsistent.');
      return { payload };
    } catch (error) { return { warning: '网站证据无效：' + error.message }; }
  }

  saveAnswer(question, proposed) {
    if (!question || typeof question.id !== 'string' || typeof question.question !== 'string') throw new Error('Question needs string id and question.');
    questionIdentity(question);
    const answer = structuredClone(proposed);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Answer must be an object.');
    const schema = readJSON(path.join(ROOT, 'references', 'answer.schema.json'));
    const candidateConfidence = answer.confidence;
    if (Object.hasOwn(answer, 'confidence')) {
      checkSchema(candidateConfidence, { ...schema.properties.confidence, required: ['score', 'basis'] }, '$.confidence');
      if (!candidateConfidence.basis.trim()) throw new Error('$.confidence.basis: requires an evidence-based reason');
    }
    const preliminary = CONFIDENCE[answer.status] || CONFIDENCE.unverified;
    const preliminaryScore = candidateConfidence?.score ?? preliminary.default;
    answer.confidence = { score: preliminaryScore, level: confidenceLevel(preliminaryScore), basis: candidateConfidence?.basis || preliminary.basis };
    // Old callers may still supply timing. Timing was removed in 2.5.0.
    delete answer.timing;
    checkSchema(answer, schema);
    const warnings = [];
    if (answer.id !== question.id || answer.question !== question.question) warnings.push('题号或题干与输入不一致，已恢复原文。');
    answer.id = question.id; answer.question = question.question;
    if (question.type && question.type !== 'unknown' && question.type !== answer.type) warnings.push('返回题型与输入不一致。');
    if (answer.type === 'unknown') warnings.push('题型尚未识别，需确认题意。');
    const options = question.options || {};
    if (Array.isArray(options) || typeof options !== 'object') throw new Error('options must be an object mapping labels to text.');
    const labels = Object.keys(options);
    if (!labels.length && ['single', 'multiple'].includes(answer.type)) warnings.push('选择题缺少完整选项，不能标记为已核验。');
    if (labels.length) {
      const evaluations = answer.option_evaluations;
      const reviewed = evaluations.map(item => item.label);
      if (new Set(reviewed).size !== reviewed.length || labels.length !== reviewed.length || labels.some(label => !reviewed.includes(label))) warnings.push('没有逐项、唯一地核验全部选项。');
      for (const item of evaluations) if (options[item.label] !== item.text) warnings.push(`选项 ${item.label} 的文字不一致。`);
      const chosen = answer.answer_labels;
      if (new Set(chosen).size !== chosen.length || chosen.some(label => !labels.includes(label))) warnings.push('答案字母无效或重复。');
      if (JSON.stringify(chosen.map(label => options[label])) !== JSON.stringify(answer.answer)) warnings.push('答案字母与选项文字未一一对应。');
      if (answer.type === 'single' && chosen.length !== 1) warnings.push('单选必须恰好选择一个选项。');
      if (answer.type === 'multiple' && chosen.length === 0) warnings.push('多选尚未确定任何选项。');
      if (answer.type === 'judge' && chosen.length !== 1) warnings.push('判断题必须确定唯一判断。');
      for (const label of labels) if (evaluations.find(item => item.label === label)?.verdict !== (chosen.includes(label) ? 'supported' : 'refuted')) warnings.push(`选项 ${label} 尚未完成选择或排除。`);
    } else {
      if (answer.answer_labels.length) warnings.push('原题没有选项，不能填写答案字母。');
      if (answer.type === 'judge' && (answer.answer.length !== 1 || !['正确', '错误', '对', '错'].includes(answer.answer[0]))) warnings.push('判断题需给出唯一的正确/错误结论。');
    }
    if (answer.status === 'verified' && (!answer.answer.length || !answer.sources.length)) warnings.push('已核验结果缺少答案或证据。');
    const calculationProofs = [];
    let nonCalculationSources = 0;
    for (const source of answer.sources) {
      try { httpURL(source.url); } catch { warnings.push('来源不是有效的无凭据HTTP(S)网址。'); }
      if (Object.values(source).some(value => !value.trim())) warnings.push('来源字段不完整。');
      const captured = this.evidence.findLast(record => record.question_id === question.id && Object.entries(source).every(([key, value]) => record.source[key] === value));
      if (captured?.kind?.startsWith('local_')) {
        const local = this.validateLocalEvidence(captured, question);
        if (local.warning) warnings.push(local.warning);
        else if (captured.kind === 'local_calculation') calculationProofs.push(local.proof);
        else nonCalculationSources++;
        continue;
      }
      nonCalculationSources++;
      if (captured?.kind === 'reused_web') {
        const reused = this.validateReusedEvidence(captured, question);
        if (reused.warning) warnings.push(reused.warning);
      } else {
        const web = this.validateWebEvidence(captured, question);
        if (web.warning) warnings.push(web.warning);
      }
    }
    if (calculationProofs.length && !nonCalculationSources) warnings.push(...this.validateCalculationAnswer(question, answer, calculationProofs));
    answer.needs_review = [...new Set([...answer.needs_review, ...warnings])];
    if (answer.status === 'verified' && answer.needs_review.length) answer.status = 'partial';
    const rating = CONFIDENCE[answer.status];
    const requestedScore = candidateConfidence?.score ?? rating.default;
    const score = Math.min(requestedScore, rating.max);
    let basis = candidateConfidence?.basis || rating.basis;
    if (!candidateConfidence && answer.sources.some(source => source.locator.startsWith('local-proof:'))) basis += ' 本地证明使用备赛时核验的有限规则，未将其标作本题实时网站查询。';
    if (score < requestedScore) basis += ` 最终核验状态为 ${answer.status}，置信度上限为 ${rating.max}%。`;
    if (answer.status !== proposed.status) basis += ' 已按保存时发现的核验缺口降低评级。';
    answer.confidence = { score, level: confidenceLevel(score), basis };
    const key = fileKey(question.id) + '-' + hash(JSON.stringify(question)).slice(0, 12);
    const directory = path.join(this.outputDir, 'questions', key);
    const jsonPath = path.join(directory, 'answer.json');
    const markdownPath = path.join(directory, 'answer.md');
    this.finishQuestion(question);
    this.completeQuestionPages(question.id);
    checkSchema(answer, schema);
    const chosen = answer.answer_labels.length ? `${answer.answer_labels.join('、')}（${answer.answer.join('；')}）` : answer.answer.join('；');
    const levelText = { high: '高', medium: '中', low: '低' }[answer.confidence.level];
    const citations = [...new Map(answer.sources.map(source => [source.url + source.name, source])).values()]
      .map(source => `[${source.name.replace(/[\[\]]/g, '')}](${source.url})`).join('；');
    const markdown = `答案：${chosen || '待核验'}。\n\n${answer.explanation}` + (citations ? `\n\n来源：${citations}` : '')
      + (answer.needs_review.length ? '\n\n待核验：' + answer.needs_review.join('；') : '') + `\n\n置信度：${score}%（${levelText}）\n`;
    if (this.archive) {
      writeJSON(jsonPath, answer);
      fs.writeFileSync(markdownPath, markdown, 'utf8');
      writeJSON(path.join(this.outputDir, 'latest-answer.json'), { json: jsonPath, markdown: markdownPath });
    }
    this.log('answer_saved', { question_id: question.id, status: answer.status, confidence: answer.confidence, json: jsonPath, markdown: markdownPath });
    return { answer, jsonPath: this.archive ? jsonPath : null, markdownPath: this.archive ? markdownPath : null };
  }

  async close() {
    await this.context?.close();
    this.pages.clear();
    this.rolePages.clear();
    this.pageLife.clear();
    this.log('browser_closed');
  }
}

installTransitions(SearchSession, { stamp, normalize, hash, httpURL, domainMatches });
installLocalEvidence(SearchSession, { root: ROOT, stamp, hash, normalize, questionIdentity, writeJSON, inside });
installEvidenceReuse(SearchSession, { stamp, hash, normalize, questionIdentity, inside });
installSearchRunner(SearchSession, { normalize, questionIdentity, siteKey });
installQuestionBank(SearchSession, { root: ROOT });
installPreparation(SearchSession, { root: ROOT, version: VERSION, httpURL, hash });

async function createSession(options = {}) {
  return new SearchSession(options).start();
}

module.exports = { createSession, SearchSession, VERSION, lookupQuestionBank, preloadQuestionBank };
