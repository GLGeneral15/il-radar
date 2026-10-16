'use strict';

/*
 * DSH adapter daemon for the ai-literacy-search skill.
 *
 * The Codex skill assumes a persistent Node tool whose globals survive between
 * turns. DSH has no such tool: every pwsh call is a fresh process. This daemon
 * restores the missing property by owning one long-lived SearchSession and its
 * visible Chrome context, and answering one JSON request per HTTP call.
 *
 * Start:  node daemon.cjs --root <skill bundle> [--port N] [--daemon-dir DIR]
 * It prints one line: AILITERACY_DAEMON {"port":N,"pid":N,"session_id":"..."}
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || path.join(__dirname, '..'));

// paths.json (written by setup-dsh.ps1) keeps runtime and state locations stable when the
// package is installed outside the default user-profile layout.
function readPathsConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(__dirname, 'paths.json'), 'utf8'));
    const resolve = item => (typeof item === 'string' && item ? path.resolve(__dirname, item) : undefined);
    return { runtimeDir: resolve(value.runtimeDir), daemonDir: resolve(value.daemonDir) };
  } catch { return {}; }
}
const paths = readPathsConfig();
const daemonDir = path.resolve(args.daemonDir || process.env.AI_LITERACY_DAEMON_DIR || paths.daemonDir ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ai-literacy-search'));
// The Playwright runtime lives outside the skill bundle (npm material). Prefer an explicit
// override, then paths.json, then the Codex installer's canonical location, then a
// bundle-relative directory.
function resolveRuntimeDir() {
  if (args.runtimeDir) return path.resolve(args.runtimeDir);
  if (process.env.AI_LITERACY_RUNTIME_DIR) return path.resolve(process.env.AI_LITERACY_RUNTIME_DIR);
  if (paths.runtimeDir && fs.existsSync(path.join(paths.runtimeDir, 'node_modules'))) return paths.runtimeDir;
  const canonical = path.join(os.homedir(), '.ailiteracy-runtime');
  if (fs.existsSync(path.join(canonical, 'package.json')) && fs.existsSync(path.join(canonical, 'node_modules'))) return canonical;
  return path.join(root, 'runtime');
}
const runtimeDir = resolveRuntimeDir();
const outputRoot = path.resolve(args.outputDir || path.join(daemonDir, 'sessions'));

if (!fs.existsSync(path.join(root, 'scripts', 'browser.cjs'))) {
  throw new Error('Not a skill bundle (scripts/browser.cjs missing): ' + root);
}

function loadSkill() {
  const entry = path.join(root, 'scripts', 'browser.cjs');
  const skill = require(entry);
  const installed = fs.readFileSync(entry, 'utf8').match(/\bconst\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  const installedVersion = installed ? installed[1] : null;
  if (!installedVersion || skill.VERSION !== installedVersion) {
    throw new Error('RELOAD_REQUIRED: loaded helper ' + skill.VERSION + ' differs from installed ' + installedVersion + '.');
  }
  return skill;
}

const skill = loadSkill();

function sessionFiles() {
  return {
    id: path.join(daemonDir, 'session-id.txt'),
    port: path.join(daemonDir, 'daemon.json'),
  };
}

function readSessionId() {
  const file = sessionFiles().id;
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (/^ailiteracy-[A-Za-z0-9][A-Za-z0-9_-]{7,89}$/.test(value)) return value;
  }
  const created = 'ailiteracy-' + require('node:crypto').randomUUID().slice(0, 8);
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(file, created, 'utf8');
  return created;
}

const sessionId = readSessionId();

// One session object for the whole daemon lifetime; Chrome and logins persist.
const session = new skill.SearchSession({
  sessionId,
  outputDir: path.join(outputRoot, sessionId),
  runtimeDir,
  browser: 'chrome',
});

let starting = null;
let lastError = null;

function ensureStarted() {
  if (session.isBrowserConnected()) return Promise.resolve();
  if (!starting) {
    starting = session.start().catch(error => { lastError = error.message; throw error; })
      .finally(() => { starting = null; });
  }
  return starting;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return String(item);
    if (typeof item === 'function') return undefined;
    return item;
  }));
}

// Method names the daemon is willing to call on the session, mapped to argument
// builders. Unknown names are refused so a typo cannot silently reach internals.
const CALLABLE = {
  observe: (session, args) => session.observe(resolvePage(session, args), args.options || args),
  currentObservation: (session, args) => session.currentObservation(resolvePage(session, args), args.options || args),
  inspect: (session, args) => session.inspect(args.source, resolvePage(session, args), args.options || {}),
  captureEvidence: (session, args) => session.captureEvidence(resolvePage(session, args), args.options || args),
  pageResult: (session, args) => session.pageResult(resolvePage(session, args), args.sourceId, args.options || {}, args.reuseObservation),
  acquirePage: (session) => session.acquirePage(),
  beginQuestion: (session, args) => session.beginQuestion(args.question),
  finishQuestion: (session, args) => session.finishQuestion(args.question),
  saveAnswer: (session, args) => session.saveAnswer(args.question, args.proposed),
  findRecipes: (session, args) => session.findRecipes(args.question, args.options || {}),
  recipe: (session, args) => session.recipe(args.recipeId),
  source: (session, args) => session.source(args.sourceId),
  taskPages: (session) => session.taskPages(),
  evidencePayload: (session, args) => session.evidencePayload(args.record),
  reuseEvidence: (session, args) => session.reuseEvidence(args.question, args.options || {}),
};

function resolvePage(session, args) {
  if (args && args.url) {
    const wanted = String(args.url);
    const page = session.context && session.context.pages().find(item => item.url().startsWith(wanted));
    if (!page) throw new Error('No open page matches url: ' + wanted);
    return page;
  }
  if (args && Number.isInteger(args.pageIndex)) {
    const pages = session.context ? session.context.pages() : [];
    const page = pages[args.pageIndex];
    if (!page) throw new Error('No open page at index ' + args.pageIndex + '; open pages: ' + pages.length);
    return page;
  }
  // Prefer the last page that actually holds a document: the extension's parking page is
  // often the last one, and observing about:blank would return an empty document.
  const open = session.context ? session.context.pages().filter(item => !item.isClosed()) : [];
  const content = open.filter(item => item.url() !== 'about:blank');
  if (content.length) return content[content.length - 1];
  if (open.length) return open[open.length - 1];
  throw new Error('No open page to inspect; open one first or pass url/pageIndex.');
}

async function dispatch(command, args = {}) {
  switch (command) {
    case 'health': {
      const status = session.codeStatus();
      return {
        ok: true, pid: process.pid, session_id: session.sessionId, helper_version: skill.VERSION,
        installed_version: status.installed_version, code_status: status.status, code_reason: status.reason,
        browser_connected: session.isBrowserConnected(), last_error: lastError,
        runtime_dir: runtimeDir, output_dir: session.outputDir, daemon_dir: daemonDir,
      };
    }
    case 'prepare': {
      await ensureStarted();
      return session.prepare(args.sourceIds === undefined ? {} : { sourceIds: args.sourceIds });
    }
    case 'lookup': {
      return session.lookupQuestionBank(args.question, args.options || { limit: 3 });
    }
    case 'bankStatus': {
      return session.preloadQuestionBank();
    }
    case 'preloadRules': {
      await ensureStarted();
      return session.preloadRules();
    }
    case 'ruleCard': {
      await ensureStarted();
      return session.ruleCard(args.ruleId);
    }
    case 'calculate': {
      await ensureStarted();
      // SearchSession.calculate(question, {operation, inputs, inputQuotes}). The first argument
      // is the bound question, not a rule id: this call previously passed args.ruleId and
      // args.parameters, so every calculation failed with a mismatched question object.
      return session.calculate(args.question, {
        operation: args.operation,
        inputs: args.inputs,
        inputQuotes: args.inputQuotes,
      });
    }
    case 'runSearch': {
      await ensureStarted();
      return session.runSearch(args.question, args.options || {});
    }
    case 'pages': {
      const pages = session.context ? session.context.pages().map((page, index) => ({
        index, url: page.url(), title: null, closed: page.isClosed(),
      })) : [];
      return { count: pages.length, pages, browser_connected: session.isBrowserConnected() };
    }
    case 'open': {
      await ensureStarted();
      const page = await session.context.newPage();
      const response = await page.goto(args.url, { waitUntil: args.waitUntil || 'domcontentloaded', timeout: args.timeoutMs || 20000 });
      return { url: page.url(), status: response ? response.status() : null };
    }
    case 'start': {
      await ensureStarted();
      return { browser_connected: session.isBrowserConnected(), session_id: session.sessionId };
    }
    case 'call': {
      await ensureStarted();
      const builder = CALLABLE[args.method];
      if (!builder) throw new Error('Method not exposed by the DSH adapter: ' + args.method +
        '; exposed: ' + Object.keys(CALLABLE).sort().join(', '));
      return builder(session, args.args || {});
    }
    case 'close': {
      await session.close();
      return { browser_connected: session.isBrowserConnected() };
    }
    case 'shutdown': {
      try { await session.close(); } catch { /* the process is ending anyway */ }
      setTimeout(() => process.exit(0), 50);
      return { ok: true, shutting_down: true };
    }
    default:
      throw new Error('Unknown command: ' + command);
  }
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', async () => {
    const send = (code, payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
      response.end(body);
    };
    if (request.method !== 'POST') { send(405, { ok: false, error: 'Use POST.' }); return; }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (error) { send(400, { ok: false, error: 'Invalid JSON body: ' + error.message }); return; }
    try {
      const result = await dispatch(payload.command, payload.args || {});
      send(200, { ok: true, result: jsonSafe(result) });
    } catch (error) {
      lastError = error.message;
      send(200, { ok: false, error: error.message, code: error.code || null });
    }
  });
});

// Preparing opens sites and can legitimately run for minutes; Node's 300 s default request
// timeout would cut such a request off. Keep a generous bound instead of an unlimited one so
// a stalled client cannot hold the daemon forever.
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 60 * 1000;

server.listen(Number(args.port || 0), '127.0.0.1', () => {
  const port = server.address().port;
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(sessionFiles().port, JSON.stringify({
    port, pid: process.pid, session_id: session.sessionId, root, runtime_dir: runtimeDir,
    output_dir: session.outputDir, started_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  process.stdout.write('AILITERACY_DAEMON ' + JSON.stringify({ port, pid: process.pid, session_id: session.sessionId }) + '\n');
});

process.on('SIGTERM', () => { session.close().catch(() => {}).finally(() => process.exit(0)); });
process.on('SIGINT', () => { session.close().catch(() => {}).finally(() => process.exit(0)); });
