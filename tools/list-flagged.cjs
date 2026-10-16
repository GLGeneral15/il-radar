'use strict';
/*
 * List every bank entry the runtime would refuse to answer directly, with the reason.
 *
 *   node tools/list-flagged.cjs [bank-path]
 *
 * A flagged entry still matches a question, but the lookup returns needs_verification instead
 * of an answer, so the skill falls back to retrieval. Use this to find entries to fix.
 */
const path = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '..');
const loaderPath = path.join(repoRoot, 'scripts', 'question-bank.cjs');
const bankPath = path.resolve(process.argv[2] || path.join(repoRoot, 'references', 'question-bank.json'));

const { QuestionBank } = createRequire(loaderPath)(loaderPath);
const bank = new QuestionBank(repoRoot);
bank.file = bankPath;
bank.refresh();

const flagged = [];
for (const { entry } of bank.indexed) {
  const reasons = bank.reasons(entry);
  if (!reasons.length) continue;
  flagged.push({
    id: entry.id,
    type: entry.type,
    reasons,
    options: entry.options,
    answer_labels: entry.answer_labels,
    answer_texts: entry.answer_texts,
    judge_answer: entry.judge_answer,
    reported_answer: entry.reported_answer,
    stem: entry.stem.slice(0, 80),
  });
}

const byReason = {};
for (const item of flagged) for (const reason of item.reasons) byReason[reason] = (byReason[reason] || 0) + 1;

console.log(`flagged ${flagged.length} of ${bank.indexed.length} entries`);
console.log('by reason:', JSON.stringify(byReason, null, 2));
for (const item of flagged) {
  console.log(`\n[${item.id}] ${item.type}  ${item.reasons.join(', ')}`);
  console.log(`  stem:    ${item.stem}`);
  console.log(`  options: ${JSON.stringify(item.options)}`);
  console.log(`  answer:  labels=${JSON.stringify(item.answer_labels)} texts=${JSON.stringify(item.answer_texts)}`
    + ` judge=${JSON.stringify(item.judge_answer)} reported=${JSON.stringify(item.reported_answer)}`);
}

process.exit(flagged.length ? 1 : 0);
