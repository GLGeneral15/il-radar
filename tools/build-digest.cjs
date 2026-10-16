'use strict';
// Recompute entries_sha256 with the exact algorithm the runtime loader uses:
//   sha256(JSON.stringify(entries)) as UTF-8.
// Python's json.dumps is not byte-identical to JSON.stringify for non-ASCII content, so the
// digest must be produced here rather than in the importer.
const fs = require('node:fs');
const crypto = require('node:crypto');

const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const bank = JSON.parse(raw);

const digest = crypto.createHash('sha256').update(JSON.stringify(bank.entries)).digest('hex');
const previous = bank.entries_sha256;
bank.entries_sha256 = digest;

// Keep the file formatting stable: two-space indent, Chinese characters unescaped.
fs.writeFileSync(file, JSON.stringify(bank, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  file,
  entries: bank.entries.length,
  previous_digest: previous,
  entries_sha256: digest,
  changed: previous !== digest,
  size_kb: Math.round(fs.statSync(file).size / 1024),
}, null, 2));
