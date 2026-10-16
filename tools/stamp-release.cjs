'use strict';
/*
 * Stamp content-version metadata into the bank, then keep the digest consistent.
 *
 *   node tools/stamp-release.cjs <bank-path> [release] [source-file]
 *
 * `release` is the bank's content version (for example 2026.10) and is informational: the
 * runtime validates `version` and `entries_sha256`, not this field. `source-file` records the
 * file the entries were imported from, when one exists.
 *
 * The digest is recomputed at the end because editing provenance changes nothing about
 * `entries`, but re-running it keeps the file self-consistent if entries were touched.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const bankPath = path.resolve(process.argv[2] || 'references/question-bank.json');
const release = process.argv[3] || new Date().toISOString().slice(0, 7);
const sourceFile = process.argv[4];

const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
bank.bankRelease = release;

if (sourceFile) {
  bank.provenance.source_file = sourceFile;
  const resolved = path.resolve(sourceFile);
  if (fs.existsSync(resolved)) {
    bank.provenance.source_sha256 = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  }
}

bank.entries_sha256 = crypto.createHash('sha256').update(JSON.stringify(bank.entries)).digest('hex');
fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  bank: bankPath,
  bankRelease: bank.bankRelease,
  entries: bank.entries.length,
  entries_sha256: bank.entries_sha256,
  source_file: bank.provenance.source_file || null,
}, null, 2));
