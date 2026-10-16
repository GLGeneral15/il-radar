'use strict';
/*
 * Validate the question bank with the runtime's own loader and run a lookup regression.
 *
 *   node tools/validate-bank.cjs [bank-path]
 *
 * Default bank-path is references/question-bank.json. The loader is required from
 * ../scripts/question-bank.cjs, so this checks exactly the code the skill runs.
 *
 * Reports: entries the loader accepted, entries answered directly, entries needing review
 * (with reasons), and a real lookup pass over a sample with the option texts rotated.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '..');
const loaderPath = path.join(repoRoot, 'scripts', 'question-bank.cjs');
const bankPath = path.resolve(process.argv[2] || path.join(repoRoot, 'references', 'question-bank.json'));

if (!fs.existsSync(loaderPath)) {
  console.error(`Cannot find the runtime loader: ${loaderPath}`);
  process.exit(1);
}
if (!fs.existsSync(bankPath)) {
  console.error(`Cannot find the bank: ${bankPath}`);
  process.exit(1);
}

const { QuestionBank, lookupQuestionBank } = createRequire(loaderPath)(loaderPath);

// The loader resolves <root>/references/question-bank.json; point it at the given file so any
// bank path can be checked without copying it around.
const bank = new QuestionBank(repoRoot);
bank.file = bankPath;
try {
  bank.refresh();
} catch (error) {
  console.error(`FAIL: the loader rejected the bank: ${error.message}`);
  process.exit(1);
}

const flagged = [];
for (const { entry } of bank.indexed) {
  const reasons = bank.reasons(entry);
  if (reasons.length) flagged.push({ id: entry.id, type: entry.type, reasons });
}

const types = {};
for (const { entry } of bank.indexed) types[entry.type] = (types[entry.type] || 0) + 1;

console.log('bank:', bankPath);
console.log('entries accepted:', bank.indexed.length);
console.log('by type:', JSON.stringify(types));
console.log('answered directly:', bank.indexed.length - flagged.length);
console.log('needs review:', flagged.length);
if (flagged.length) {
  const byReason = {};
  for (const item of flagged) for (const reason of item.reasons) byReason[reason] = (byReason[reason] || 0) + 1;
  console.log('review reasons:', JSON.stringify(byReason));
  console.log('first flagged ids:', flagged.slice(0, 20).map(item => item.id).join(', '));
}

// --- real lookup regression over a sample, with the option texts rotated ---
const raw = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
const entries = raw.entries;
const step = Math.max(1, Math.floor(entries.length / 200));
let checked = 0, matched = 0, answerMismatch = 0, notMatched = 0;
const problems = [];

for (let i = 0; i < entries.length && checked < 200; i += step) {
  const entry = entries[i];
  checked += 1;
  // Rotate the option values while keeping the labels: a real paper shuffles the same texts.
  const values = Object.values(entry.options);
  const labels = Object.keys(entry.options);
  const shift = values.length ? i % values.length : 0;
  const rotated = values.slice(shift).concat(values.slice(0, shift));
  const options = {};
  labels.forEach((label, index) => { options[label] = rotated[index]; });

  const result = lookupQuestionBank(
    { id: `probe-${i}`, type: entry.type, question: entry.stem, options },
    { root: repoRoot, limit: 3 });

  if (result.status !== 'matched') {
    notMatched += 1;
    if (problems.length < 5) problems.push({ id: entry.id, type: entry.type, status: result.status, reason: result.reason });
    continue;
  }
  matched += 1;
  const expected = [...(entry.answer_texts || [])].sort();
  const got = [...result.answer_texts].sort();
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    answerMismatch += 1;
    if (problems.length < 5) problems.push({ id: entry.id, expected, got });
  }
}

console.log('\nlookup regression (sampled, option texts rotated):');
console.log('  checked:', checked);
console.log('  answered:', matched);
console.log('  answer text mismatch:', answerMismatch);
console.log('  not answered:', notMatched);
for (const problem of problems) console.log('  problem:', JSON.stringify(problem));

const ok = flagged.length === 0 && answerMismatch === 0 && notMatched === 0;
console.log(ok ? '\nOK' : '\nATTENTION: see the entries above');
process.exit(ok ? 0 : 1);
