'use strict';

// Deterministic local proofs. These do not query a website or evaluate code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileAssetCache } = require('./asset-cache.cjs');

class RuleStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.catalogFile = path.join(this.root, 'references', 'rules.json');
    this.files = new FileAssetCache();
    this.catalog = { rules: [] };
    this.catalogSignature = null;
    this.cache = new Map();
  }

  refresh() {
    const entry = this.files.load(this.catalogFile, { allowedRoot: path.join(this.root, 'references'), json: true });
    if (entry.signature === this.catalogSignature) return false;
    const catalog = entry.value;
    if (!catalog || !Array.isArray(catalog.rules) || catalog.rules.some(rule => !rule || typeof rule.id !== 'string' || !rule.id) || new Set(catalog.rules.map(rule => rule.id)).size !== catalog.rules.length) throw new Error('Rule catalog needs rules with unique nonempty IDs.');
    this.catalog = structuredClone(catalog);
    this.catalogSignature = entry.signature;
    this.cache.clear();
    return true;
  }

  card(ruleId) {
    this.refresh();
    return this.loadCard(ruleId);
  }

  loadCard(ruleId) {
    try {
      const card = this.catalog.rules.find(item => item.id === ruleId);
      if (!card || card.status !== 'verified' || card.freshness !== 'stable') throw new Error('Unknown or unverified stable rule.');
      if (typeof card.url !== 'string' || typeof card.verified_at !== 'string' || !card.claims || typeof card.claims !== 'object' || Array.isArray(card.claims) || !Object.keys(card.claims).length || Object.values(card.claims).some(claim => typeof claim !== 'string' || !claim.trim()) || !Array.isArray(card.artifacts) || !card.artifacts.length) throw new Error('Prepared rule claims or artifacts are invalid.');
      const artifacts = card.artifacts.map(item => {
        if (!item || typeof item.path !== 'string' || !/^references[\\/]rule-evidence[\\/][a-zA-Z0-9_.-]+$/.test(item.path) || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('Prepared rule artifact metadata is invalid.');
        const entry = this.files.load(path.resolve(this.root, item.path), { allowedRoot: path.join(this.root, 'references', 'rule-evidence'), json: item.path.endsWith('.json') });
        if (entry.sha256 !== item.sha256) throw new Error('Prepared rule evidence is missing or changed.');
        return entry;
      });
      const signatures = artifacts.map(item => item.signature).join('\n');
      const cached = this.cache.get(ruleId);
      if (cached?.signatures === signatures && cached.catalogSignature === this.catalogSignature) return structuredClone(cached.card);
      const jsonPosition = card.artifacts.findIndex(item => item.path.endsWith('.json'));
      const observation = artifacts[jsonPosition]?.value;
      if (!observation || observation.url !== card.url || observation.observed_at !== card.verified_at || !Array.isArray(observation.excerpts) || !observation.excerpts.length || observation.excerpts.some(excerpt => typeof excerpt !== 'string' || !excerpt.trim())) throw new Error('Prepared rule provenance is inconsistent.');
      // Keep the original verified bytes in process memory. No file is rendered
      // or copied into the model's context merely because it was prepared.
      this.cache.set(ruleId, { card: structuredClone(card), observation: structuredClone(observation), artifacts, signatures, catalogSignature: this.catalogSignature });
      return structuredClone(card);
    } catch (error) {
      this.cache.delete(ruleId);
      throw error;
    }
  }

  preload() {
    try { this.refresh(); }
    catch (error) { return { indexed: this.catalog.rules.length, eligible: 0, loaded: 0, failed: 1, failures: [{ asset: 'rules', error: error.message }] }; }
    const eligible = this.catalog.rules.filter(card => card.status === 'verified' && card.freshness === 'stable');
    const summary = { indexed: this.catalog.rules.length, eligible: eligible.length, loaded: 0, failed: 0, failures: [] };
    for (const card of eligible) {
      try { this.loadCard(card.id); summary.loaded++; }
      catch (error) { summary.failed++; summary.failures.push({ rule_id: card.id, error: error.message }); }
    }
    return summary;
  }
}

function installLocalEvidence(Session, { root, stamp, hash, normalize, questionIdentity, writeJSON, inside }) {
  const p = Session.prototype;
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const evidencePath = session => path.join(session.outputDir, 'evidence.jsonl');
  const stores = new WeakMap();
  const store = session => {
    if (!stores.has(session)) stores.set(session, new RuleStore(root));
    return stores.get(session);
  };

  p.ruleCard = function (ruleId) {
    return store(this).card(ruleId);
  };

  p.preloadRules = function () { return store(this).preload(); };

  function current(session, question) {
    const identity = questionIdentity(question);
    const attempt = session.questionRecords.findLast(item => item.question_id === identity.id);
    if (!identity.fingerprint || !attempt || attempt.completed || attempt.fingerprint !== identity.fingerprint || session.activeQuestion?.id !== identity.id || session.activeQuestion.attempt !== attempt.attempt) throw new Error('Begin this complete question before generating local evidence.');
    return { ...identity, attempt: attempt.attempt };
  }

  function validateInputs(question, inputs, quotes, keys, integers) {
    if (!inputs || !quotes || Object.keys(inputs).length !== keys.length || Object.keys(quotes).length !== keys.length) throw new Error('Supply exactly the required inputs and inputQuotes.');
    for (const key of keys) {
      const value = inputs[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || integers && !Number.isSafeInteger(value)) throw new Error('Inputs must be nonnegative finite values (safe integers for counts).');
      const quote = quotes[key];
      if (typeof quote !== 'string' || !quote.trim() || !normalize(question.question).includes(normalize(quote))) throw new Error('Each input quote must occur in this question stem.');
      const numbers = normalize(quote).replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '').match(/\d+(?:\.\d+)?/g) || [];
      if (numbers.length !== 1 || Number(numbers[0]) !== value) throw new Error('Each input quote must unambiguously contain its one corresponding value.');
      if (keys.includes('relevantTotal')) {
        const role = {
          relevantTotal: /相关/.test(quote) && /总|共|全部|所有|收录|存有/.test(quote) && !/其中|真正|检出|检索到/.test(quote),
          retrieved: /检出|检索到|检索结果|检索得到|返回|搜到|找到|查得|查出/.test(quote) && !/相关/.test(quote),
          relevantRetrieved: /相关|完全符合要求/.test(quote) && /其中|真正|检出|检索到|命中/.test(quote),
        };
        if (!role[key]) throw new Error('Input quote lacks the corresponding count role; quote its original context, not a bare number.');
      }
    }
  }

  function saveProof(session, identity, card, kind, details) {
    const id = crypto.randomUUID();
    const proof = { version: 1, id, kind, session_id: session.sessionId, question_id: identity.id,
      question_fingerprint: identity.fingerprint, attempt: identity.attempt, generated_at: stamp(),
      rule_id: card.id, rule_sha256: hash(JSON.stringify(card)), rule_verified_at: card.verified_at,
      rule_url: card.url, ...details };
    const source = { name: card.name + (kind === 'local_calculation' ? '（本题本地计算）' : '（备赛核验规则）'),
      url: card.url, query: details.operation || details.claims.join(', '), field: card.scope,
      evidence: kind === 'local_calculation' ? details.steps.join('；') : details.claims.map(key => card.claims[key]).join('；') + '。本题应用：' + details.application,
      locator: 'local-proof:' + id, retrieved_at: proof.generated_at };
    let artifact = { storage: 'memory', id, proof_sha256: hash(JSON.stringify(proof)) };
    if (session.archive) {
      const file = path.join(session.outputDir, 'local-evidence', id + '.json');
      writeJSON(file, proof);
      artifact = { storage: 'archive', proof: file, proof_sha256: hash(fs.readFileSync(file)) };
    }
    const record = { kind, question_id: identity.id, source, artifact };
    session.rememberEvidence(record, { proof });
    if (session.archive) fs.appendFileSync(evidencePath(session), JSON.stringify(record) + '\n', 'utf8');
    session.evidence.push(record);
    session.log('local_evidence_captured', { question_id: identity.id, attempt: identity.attempt, kind, rule_id: card.id, artifact });
    return { source, proof, artifact };
  }

  p.calculate = function (question, { operation, inputs, inputQuotes } = {}) {
    const identity = current(this, question);
    const card = this.ruleCard('retrieval-metrics');
    let results, steps;
    if (operation === 'retrieval-metrics') {
      validateInputs(question, inputs, inputQuotes, ['relevantTotal', 'retrieved', 'relevantRetrieved'], true);
      const { relevantTotal, retrieved, relevantRetrieved } = inputs;
      if (!relevantTotal || !retrieved || relevantRetrieved > relevantTotal || relevantRetrieved > retrieved) throw new Error('Invalid retrieval counts or zero denominator.');
      const recall = relevantRetrieved / relevantTotal, precision = relevantRetrieved / retrieved;
      results = { recall, precision, recallPercent: recall * 100, precisionPercent: precision * 100 };
      steps = [`查全率 = ${relevantRetrieved} / ${relevantTotal} = ${recall} = ${results.recallPercent}%`,
        `查准率 = ${relevantRetrieved} / ${retrieved} = ${precision} = ${results.precisionPercent}%`];
    } else if (operation === 'ratio-percent') {
      validateInputs(question, inputs, inputQuotes, ['part', 'whole'], false);
      if (!inputs.whole || inputs.part > inputs.whole) throw new Error('Invalid part/whole or zero denominator.');
      const ratio = inputs.part / inputs.whole;
      results = { ratio, percent: ratio * 100 };
      steps = [`比例 = ${inputs.part} / ${inputs.whole} = ${ratio} = ${results.percent}%`];
    } else throw new Error('Unsupported calculation operation. No arbitrary expressions are evaluated.');
    return saveProof(this, identity, card, 'local_calculation', { operation, inputs: structuredClone(inputs), inputQuotes: structuredClone(inputQuotes), results, steps });
  };

  p.useRule = function (question, { ruleId, claims, application } = {}) {
    const identity = current(this, question);
    const card = this.ruleCard(ruleId);
    if (!Array.isArray(claims) || !claims.length || new Set(claims).size !== claims.length || claims.some(key => !Object.hasOwn(card.claims, key))) throw new Error('Use only explicit claims covered by the prepared rule.');
    if (typeof application !== 'string' || !application.trim()) throw new Error('Explain how the stable rule applies to this complete question.');
    return saveProof(this, identity, card, 'local_rule', { claims: [...claims], application });
  };

  p.validateLocalEvidence = function (record, question) {
    try {
      if (!['local_calculation', 'local_rule'].includes(record.kind)) throw new Error('Unknown local evidence kind.');
      let proof;
      if (record.artifact?.storage === 'memory') {
        proof = this.evidencePayload(record)?.proof;
        if (!proof || hash(JSON.stringify(proof)) !== record.artifact.proof_sha256) throw new Error('Local memory proof is missing, unregistered or modified.');
      } else {
        const file = record.artifact?.proof;
        if (typeof file !== 'string' || !inside(path.join(this.outputDir, 'local-evidence'), file) || !fs.existsSync(file) || hash(fs.readFileSync(file)) !== record.artifact.proof_sha256) throw new Error('Local proof is missing or modified.');
        proof = read(file);
      }
      const identity = questionIdentity(question);
      const attempt = this.questionRecords.findLast(item => item.question_id === question.id);
      const card = this.ruleCard(proof.rule_id);
      if (proof.session_id !== this.sessionId || proof.question_id !== identity.id || proof.question_fingerprint !== identity.fingerprint || proof.attempt !== attempt?.attempt || proof.kind !== record.kind || proof.rule_sha256 !== hash(JSON.stringify(card)) || proof.rule_url !== record.source.url || record.source.locator !== 'local-proof:' + proof.id) throw new Error('Local proof belongs to a different question, attempt or rule.');
      return { proof, card };
    } catch (error) { return { warning: '本地证明无效：' + error.message }; }
  };

  // A calculation proof must not authorize an arbitrary selected answer.
  p.validateCalculationAnswer = function (question, answer, proofs) {
    if (!proofs.length) return [];
    const warning = message => ['计算答案待核验：' + message];
    const stem = normalize(question.question);
    // Definitions may name the metrics in a different order from the request.
    // Only an explicit output instruction establishes positional meaning.
    function requestedMetrics() {
      const name = '(?:查全率|召回率|查准率|精确率)';
      const groups = [...stem.matchAll(new RegExp(name + '(?:\\s*(?:、|和|与|及|[,，]|/)\\s*' + name + ')?', 'g'))];
      const requests = groups.filter(match => {
        const before = stem.slice(0, match.index).split(/[。！？?;；]/).at(-1);
        const after = stem.slice(match.index + match[0].length);
        return /(?:求(?:出|解)?|计算|给出|则|请按)\s*$/.test(before)
          || /^\s*(?:(?:分别|依次)(?:是|为)?(?:多少|什么|[?？:：（(]|$)|(?:是|为|等于)(?:多少|什么|[?？:：（(]|$)|的顺序)/.test(after)
          || /^\s*(?:的)?(?:下列)?计算结果(?:错误|不正确|不对|正确)的是(?=\s*[?？:：（(]|$)/.test(after);
      });
      const last = requests.at(-1);
      if (!last) return [];
      return [...last[0].matchAll(new RegExp(name, 'g'))].map(match => /查全率|召回率/.test(match[0]) ? 'recall' : 'precision');
    }
    const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const precisionInstructions = [...stem.matchAll(/(?:保留|精确到)\s*([0-9]{1,2}|[零一二两三四五六七八九十])\s*位小数/g)];
    const precisions = precisionInstructions.map(match => Object.hasOwn(digits, match[1]) ? digits[match[1]] : Number(match[1]));
    if (new Set(precisions).size > 1 || precisions.some(value => value > 10)) return warning('小数精度要求无法唯一对应数值选项。');
    const precision = precisions[0];
    const percentPrecision = precision !== undefined && /百分比|百分数/.test(stem);
    function rounded(value, scale) {
      if (precision === undefined) return value;
      const factor = 10 ** precision, scaled = value * scale * factor;
      // Correct binary representation at a rounding boundary, not answer tolerance.
      return Math.round(scaled + Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4) / factor / scale;
    }
    const expected = [];
    for (const proof of proofs) {
      if (proof.operation === 'ratio-percent') expected.push(proof.results.ratio);
      else {
        const requested = requestedMetrics();
        if (!requested.length) return warning('题干未明确要求的检索指标，不能自动对应数值。');
        const precisionTargets = precisionInstructions.map(match => [...stem.slice(0, match.index).split(/[。！？?;；，,]/).at(-1)
          .matchAll(/查全率|召回率|查准率|精确率/g)].map(item => /查全率|召回率/.test(item[0]) ? 'recall' : 'precision'));
        if (precisionTargets.length && precisionTargets.every(targets => targets.length)
          && requested.some(key => !precisionTargets.some(targets => targets.includes(key)))) return warning('小数精度仅覆盖部分所问指标，不能套用到全部数值。');
        expected.push(...requested.map(key => proof.results[key]));
      }
    }
    function values(text) {
      const normalized = normalize(text);
      const remainder = normalized.replace(/[\d\s.%、，,;；:：()（）]/g, '');
      if (remainder) return null;
      const matches = [...normalized.matchAll(/(?:^|[^\d.])([+-]?\d+(?:\.\d+)?)(\s*%)?/g)];
      return matches.map(match => ({ value: Number(match[1]) / (match[2] ? 100 : 1), scale: match[2] ? 100 : 1 }));
    }
    const negative = /(?:不正确|不符合|不等于|错误的是|错误的|不对的是)/.test(question.question);
    if (answer.type === 'judge') return warning('本地数值验证只覆盖明确的数值选项，判断陈述还须逐句核验。');
    for (const [label, text] of Object.entries(question.options || {})) {
      const actual = values(text);
      if (!actual || actual.length !== expected.length) return warning('选项含非数值陈述或指标数量不一致，需要补充证据。');
      const matches = actual.every((item, i) => Math.abs(item.value - rounded(expected[i], percentPrecision ? 100 : item.scale)) < 1e-10);
      const shouldChoose = negative ? !matches : matches;
      const chosen = answer.answer_labels.includes(label);
      if (shouldChoose !== chosen) return warning('所选文字或排除项与实际计算结果不一致。');
    }
    return [];
  };
}

module.exports = { installLocalEvidence, RuleStore };
