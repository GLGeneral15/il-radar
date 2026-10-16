'use strict';

/*
 * DSH adapter client for the ai-literacy-search skill.
 *
 * Usage (all commands print one JSON object on stdout):
 *   node ailit.cjs health
 *   node ailit.cjs bank-status
 *   node ailit.cjs lookup --question-file <q.json>
 *   node ailit.cjs prepare [--sources id1,id2] [--none]
 *   node ailit.cjs search --question-file <q.json> --recipe <id> [--params p.json]
 *   node ailit.cjs pages
 *   node ailit.cjs open --url <url>
 *   node ailit.cjs call --method observe [--args a.json]
 *   node ailit.cjs close | shutdown
 *
 * The client starts the daemon on first use if it is not already listening.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

// The skill bundle holding scripts/browser.cjs sits beside this adapter directory.
const root = path.resolve(process.env.AI_LITERACY_SKILL_ROOT ||
  path.join(__dirname, '..', 'ai-literacy-search'));
const daemonScript = path.join(__dirname, 'daemon.cjs');

// paths.json, written by setup-dsh.ps1, keeps the runtime and daemon-state locations stable
// for installations that live outside the default user-profile layout.
function readPathsConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(__dirname, 'paths.json'), 'utf8'));
    const resolve = item => (typeof item === 'string' && item ? path.resolve(__dirname, item) : undefined);
    return { runtimeDir: resolve(value.runtimeDir), daemonDir: resolve(value.daemonDir) };
  } catch { return {}; }
}
const paths = readPathsConfig();
const daemonDir = path.resolve(process.env.AI_LITERACY_DAEMON_DIR || paths.daemonDir ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ai-literacy-search'));
const stateFile = path.join(daemonDir, 'daemon.json');
const logFile = path.join(daemonDir, 'daemon.log');

// Keep the Playwright runtime resolution identical to the pwsh wrapper's: an explicit
// override, then paths.json, then the path recorded at setup.
function runtimeOverride() {
  if (process.env.AI_LITERACY_RUNTIME_DIR) return process.env.AI_LITERACY_RUNTIME_DIR;
  if (paths.runtimeDir && fs.existsSync(path.join(paths.runtimeDir, 'node_modules'))) return paths.runtimeDir;
  const recorded = path.join(__dirname, 'runtime-path.txt');
  if (fs.existsSync(recorded)) {
    const value = fs.readFileSync(recorded, 'utf8').trim();
    if (value && fs.existsSync(path.join(value, 'node_modules'))) return value;
  }
  return undefined;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return { command: positional[0] || 'health', positional, flags };
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state || !Number.isInteger(state.port)) return null;
    return state;
  } catch { return null; }
}

function readJSONFile(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
}

function request(port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length },
      timeout: timeoutMs,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(new Error('Daemon returned invalid JSON: ' + error.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out after ' + timeoutMs + ' ms.')); });
    req.on('error', reject);
    req.end(body);
  });
}

function processAlive(pid, port) {
  // Probe with a raw TCP connect. An HTTP health request would queue behind a long-running
  // daemon operation (a prepare, a search) and make a healthy daemon look dead, which would
  // spawn a second daemon and fight over the daemon.json port file and the Chrome profile.
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(2000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

async function ensureDaemon() {
  const state = readState();
  if (state && await processAlive(state.pid, state.port)) return state;

  fs.mkdirSync(daemonDir, { recursive: true });
  try { fs.rmSync(stateFile, { force: true }); } catch { /* a stale file is replaced by the daemon */ }

  const log = fs.openSync(logFile, 'a');
  const runtimeDir = runtimeOverride();
  const daemonArgs = [daemonScript, '--root', root];
  if (runtimeDir) daemonArgs.push('--runtimeDir', runtimeDir);
  const child = spawn(process.execPath, daemonArgs, {
    detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const fresh = readState();
    if (fresh && fresh.port && await processAlive(fresh.pid, fresh.port)) return fresh;
  }
  throw new Error('The ai-literacy-search daemon did not start within 20 s. See ' + logFile);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const isLifecycle = command === 'health' || command === 'start';
  const state = await ensureDaemon();
  const timeoutMs = Number(flags.timeoutMs || (isLifecycle ? 30000 : 180000));

  let payload;
  switch (command) {
    case 'health': payload = { command: 'health' }; break;
    case 'start': payload = { command: 'start' }; break;
    case 'close': payload = { command: 'close' }; break;
    case 'shutdown': payload = { command: 'shutdown' }; break;
    case 'pages': payload = { command: 'pages' }; break;
    case 'bank-status': payload = { command: 'bankStatus' }; break;
    case 'open': payload = { command: 'open', args: { url: flags.url, waitUntil: flags.waitUntil, timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined } }; break;
    case 'lookup': payload = { command: 'lookup', args: { question: readJSONFile(flags['question-file']), options: { limit: Number(flags.limit || 3) } } }; break;
    case 'prepare': payload = { command: 'prepare', args: { sourceIds: flags.none ? [] : flags.sources ? String(flags.sources).split(',').map(item => item.trim()).filter(Boolean) : undefined } }; break;
    case 'search': payload = { command: 'runSearch', args: { question: readJSONFile(flags['question-file']), options: Object.assign({ recipeId: flags.recipe }, flags.params ? readJSONFile(flags.params) : {}) } }; break;
    case 'call': payload = { command: 'call', args: { method: flags.method, args: flags.args ? readJSONFile(flags.args) : {} } }; break;
    default: throw new Error('Unknown command: ' + command + ' (see the header of ailit.cjs)');
  }

  const reply = await request(state.port, payload, timeoutMs);
  process.stdout.write(JSON.stringify(reply, null, 2) + '\n');
  if (!reply.ok) process.exitCode = 2;
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }, null, 2) + '\n');
  process.exitCode = 1;
});
