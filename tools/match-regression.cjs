'use strict';
/*
 * Regression test for the lookup comparison logic.
 *
 *   node tools/match-regression.cjs [bank-path]
 *
 * WHAT THIS PROVES: that the runtime's normalizer and exact-match key behave as documented —
 * option re-ordering, full/half-width brackets, extra spaces and trailing punctuation do not
 * change the outcome.
 *
 * WHAT THIS DOES NOT PROVE: any coverage figure. The probe questions are taken from the bank
 * itself, so a perfect score here is expected and says nothing about how often a question from
 * a real exam paper will be found in the bank.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '..');
const loaderPath = path.join(repoRoot, 'scripts', 'question-bank.cjs');
const bankPath = path.resolve(process.argv[2] || path.join(repoRoot, 'references', 'question-bank.json'));

const { QuestionBank, lookupQuestionBank } = createRequire(loaderPath)(loaderPath);
const bank = new QuestionBank(repoRoot);
bank.file = bankPath;
bank.refresh();

const raw = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
const entries = raw.entries;

function ask(entry, mutateStem, mutateOptions) {
  const options = mutateOptions ? mutateOptions(entry.options) : entry.options;
  return lookupQuestionBank(
    { id: 'probe', type: entry.type, question: mutateStem ? mutateStem(entry.stem) : entry.stem, options },
    { root: repoRoot, limit: 1 }).status;
}

function rotateOptions(options) {
  const values = Object.values(options);
  const out = {};
  Object.keys(options).forEach((label, index) => { out[label] = values[(index + 1) % values.length]; });
  return out;
}

const cases = [
  ['as stored', entry => ask(entry)],
  ['option texts rotated', entry => ask(entry, null, rotateOptions)],
  ['full-width parentheses', entry => ask(entry, stem => stem.replace(/（/g, '（').replace(/\(/g, '（'))],
  ['extra space in stem', entry => ask(entry, stem => `${stem} `)],
  ['trailing period difference', entry => ask(entry, stem => (/[。.?？]\s*$/.test(stem) ? stem.replace(/[。.?？]\s*$/, '') : `${stem}。`))],
  ['wrong question type', entry => {
    const other = entry.type === 'single' ? 'multiple' : 'single';
    return lookupQuestionBank({ id: 'probe', type: other, question: entry.stem, options: entry.options },
      { root: repoRoot, limit: 1 }).status;
  }],
];

const sample = [];
const step = Math.max(1, Math.floor(entries.length / 120));
for (let i = 0; i < entries.length && sample.length < 120; i += step) sample.push(entries[i]);

console.log(`bank: ${bankPath}`);
console.log(`sampled ${sample.length} of ${entries.length} entries\n`);
console.log(`${'case'.padEnd(26)} ${'matched'.padStart(8)} ${'rate'.padStart(8)}`);
for (const [name, run] of cases) {
  let matched = 0;
  for (const entry of sample) {
    try { if (run(entry) === 'matched') matched += 1; } catch { /* count as not matched */ }
  }
  console.log(`${name.padEnd(26)} ${String(matched).padStart(8)} ${(matched / sample.length * 100).toFixed(1).padStart(7)}%`);
}

console.log('\nExpect the first five cases at 100%. The last case (wrong question type) is expected');
console.log('to be low and exists to show how much the type field matters.');
