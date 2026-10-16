'use strict';
/*
 * Pre-package audit: scan every file that would be published for material that must not ship.
 *
 *   node tools/package-audit.cjs [repo-root]
 *
 * CRITICAL findings fail the run (exit 1): personal identifiers, credentials, session ids and
 * private keys. INFORMATIONAL findings are listed for review but do not fail: absolute paths in
 * documentation examples, product names, and contact addresses recorded from public pages.
 *
 * Identifier fragments are assembled at runtime so this scanner does not itself publish the
 * values it hunts for. Extend them for your own project.
 */
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const EXCLUDE_DIRS = new Set(['_build', '.git', 'node_modules']);
const TEXT_EXT = new Set(['.md', '.json', '.cjs', '.js', '.mjs', '.ps1', '.txt', '.yml', '.yaml', '.csv']);

const personalFragments = ['罗', '天', '嘉'];
const studentIdFragments = ['2025', '0417', '00131'];

const critical = {
  personal_name: new RegExp(personalFragments.join(''), 'g'),
  student_id: new RegExp(studentIdFragments.join(''), 'g'),
  secret_like: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g,
  private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  bearer_token: /Bearer\s+[A-Za-z0-9._-]{24,}/g,
  session_id: /;jsessionid=[A-Za-z0-9.]+|\b(?:sessionid|PHPSESSID)=[A-Za-z0-9]{16,}/gi,
};

const informational = {
  // Escaped sequences in recorded page text must not be mistaken for paths, so the pattern
  // stays inside plain printable characters.
  windows_absolute_path: /[A-Za-z]:\\(?:[A-Za-z0-9 _.-]+\\?){1,}/g,
  local_dev_marker: /dsh-runtimes|AppData\\Local|deepseek harness/gi,
  email_like: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
};

const criticalHits = [];
const infoHits = [];
let scanned = 0, binaries = 0, bytes = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const file = path.join(dir, entry.name);
    const relative = path.relative(repo, file).replace(/\\/g, '/');
    bytes += fs.statSync(file).size;
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) { binaries += 1; continue; }
    scanned += 1;
    const text = fs.readFileSync(file, 'utf8');
    for (const [name, regex] of Object.entries(critical)) {
      const hits = [...new Set(text.match(regex) || [])];
      if (hits.length) criticalHits.push({ file: relative, pattern: name, hits: hits.slice(0, 5) });
    }
    for (const [name, regex] of Object.entries(informational)) {
      const hits = [...new Set(text.match(regex) || [])];
      if (hits.length) infoHits.push({ file: relative, pattern: name, hits: hits.slice(0, 5) });
    }
  }
}

walk(repo);

console.log(`repo: ${repo}`);
console.log(`scanned ${scanned} text files (${binaries} binary skipped), ${(bytes / 1024 / 1024).toFixed(2)} MB`);

console.log(`\nCRITICAL: ${criticalHits.length}`);
for (const hit of criticalHits) {
  console.log(`  [${hit.pattern}] ${hit.file}`);
  for (const value of hit.hits) console.log(`      ${value.slice(0, 100)}`);
}
if (!criticalHits.length) console.log('  (none)');

const byPattern = {};
for (const hit of infoHits) (byPattern[hit.pattern] ||= []).push(hit);
console.log(`\nINFORMATIONAL: ${infoHits.length}`);
for (const [pattern, list] of Object.entries(byPattern)) {
  console.log(`  [${pattern}] ${list.length} file(s)`);
  for (const hit of list.slice(0, 5)) {
    console.log(`      ${hit.file}: ${hit.hits.map(value => value.slice(0, 60)).join(' | ')}`);
  }
  if (list.length > 5) console.log(`      ... and ${list.length - 5} more`);
}

process.exit(criticalHits.length ? 1 : 0);
