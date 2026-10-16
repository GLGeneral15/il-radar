'use strict';

// Reuse captured website text, never a previous answer or a local calculation.
const fs = require('node:fs');
const path = require('node:path');

function installEvidenceReuse(Session, { stamp, hash, normalize, questionIdentity, inside }) {
  const p = Session.prototype;
  const fields = ['name', 'url', 'query', 'field', 'evidence', 'locator', 'retrieved_at'];
  const sourceKey = source => JSON.stringify(fields.map(key => source?.[key]));
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const original = record => record && (!record.kind || record.kind === 'web');
  const evidencePath = session => path.join(session.outputDir, 'evidence.jsonl');
  const persisted = session => fs.existsSync(evidencePath(session))
    ? fs.readFileSync(evidencePath(session), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];

  function current(session, question) {
    const identity = questionIdentity(question);
    const attempt = session.questionRecords.findLast(item => item.question_id === identity.id);
    if (!identity.fingerprint || !question.question.trim() || !attempt || attempt.completed
      || attempt.fingerprint !== identity.fingerprint || session.activeQuestion?.id !== identity.id
      || session.activeQuestion.attempt !== attempt.attempt) throw new Error('Begin this complete question before reusing evidence.');
    return { ...identity, attempt: attempt.attempt };
  }

  function checkFiles(session, record) {
    if (!original(record) || typeof record.question_id !== 'string' || !record.question_id
      || fields.some(key => typeof record.source?.[key] !== 'string' || !record.source[key].trim())) throw new Error('A real original website evidence record is required.');
    const url = new URL(record.source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected a website source URL.');
    const artifact = record.artifact, files = {};
    if (artifact?.storage === 'memory') {
      const payload = session.evidencePayload(record);
      const observation = payload?.observation;
      const target = typeof payload?.targetText === 'string'
        ? { url: record.source.url, locator: record.source.locator, text: payload.targetText, captured_at: record.source.retrieved_at }
        : payload?.targetText;
      if (!observation || !target || observation.url !== record.source.url || target.url !== record.source.url
        || target.locator !== record.source.locator || target.captured_at !== record.source.retrieved_at
        || typeof target.text !== 'string' || hash(target.text) !== artifact.text_sha256
        || !normalize(target.text).includes(normalize(record.source.evidence))) throw new Error('Original memory evidence text, excerpt or provenance is inconsistent.');
      return { payload: hash(JSON.stringify(payload)) };
    }
    for (const key of ['snapshot', 'target_text', ...(artifact?.screenshot ? ['screenshot'] : [])]) {
      const file = artifact?.[key];
      if (typeof file !== 'string' || !path.isAbsolute(file) || !inside(session.outputDir, file)
        || !fs.existsSync(file) || !fs.statSync(file).isFile()
        || !inside(fs.realpathSync(session.outputDir), fs.realpathSync(file))) throw new Error('Original evidence file is missing or outside this session.');
      files[key] = hash(fs.readFileSync(file));
    }
    const snapshot = read(artifact.snapshot), target = read(artifact.target_text);
    if (snapshot.url !== record.source.url || target.url !== record.source.url
      || target.locator !== record.source.locator || target.captured_at !== record.source.retrieved_at
      || typeof target.text !== 'string' || hash(target.text) !== artifact.text_sha256
      || !normalize(target.text).includes(normalize(record.source.evidence))) throw new Error('Original evidence text, excerpt or provenance is inconsistent.');
    return files;
  }

  function findOriginal(session, source, expectedHash) {
    if (!source || fields.some(key => typeof source[key] !== 'string' || !source[key].trim())) throw new Error('Supply an actual captured website source, not an answer or memory.');
    const matches = session.evidence.filter(record => original(record) && sourceKey(record.source) === sourceKey(source)
      && (!expectedHash || hash(JSON.stringify(record)) === expectedHash));
    if (!matches.length) throw new Error('No original website evidence record exists in this session.');
    let stored;
    for (const record of matches) {
      const digest = hash(JSON.stringify(record));
      if (record.artifact?.storage !== 'memory') {
        stored ||= persisted(session);
        if (!stored.some(item => original(item) && hash(JSON.stringify(item)) === digest)) continue;
      }
      const files = checkFiles(session, record);
      return { record, digest, files };
    }
    throw new Error('Original evidence is not present in the session record file.');
  }

  p.findEvidence = function ({ text, url, limit = 10 } = {}) {
    if (text !== undefined && typeof text !== 'string' || url !== undefined && typeof url !== 'string'
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Use string text/url filters and an integer limit from 1 to 100.');
    const terms = normalize(text || '').toLowerCase().split(/\s+/).filter(Boolean), results = [], seen = new Set();
    let stored;
    for (const record of this.evidence) {
      if (!original(record) || url && !record.source?.url?.includes(url)) continue;
      const key = sourceKey(record.source);
      if (seen.has(key) || terms.some(term => !normalize(fields.map(field => record.source?.[field] || '').join(' ')).toLowerCase().includes(term))) continue;
      try {
        if (record.artifact?.storage !== 'memory') {
          stored ||= new Set(persisted(this).filter(original).map(item => hash(JSON.stringify(item))));
          if (!stored.has(hash(JSON.stringify(record)))) continue;
        }
        checkFiles(this, record);
      } catch { continue; }
      seen.add(key);
      results.push({ source: structuredClone(record.source), artifact: structuredClone(record.artifact), origin_question_id: record.question_id });
      if (results.length >= limit) break;
    }
    return results;
  };

  p.reuseEvidence = function (question, { source, freshness, scope } = {}) {
    const identity = current(this, question);
    if (!['stable', 'versioned'].includes(freshness)) throw new Error('Only stable or versioned facts may be reused; live/dynamic facts need fresh evidence.');
    if (typeof scope !== 'string' || !scope.trim()) throw new Error('Explain why the original object, fields, conditions and version apply to this question.');
    // Scope is a model assessment; these checks establish provenance, not meaning.
    const { record: origin, digest, files } = findOriginal(this, source);
    const record = { kind: 'reused_web', question_id: identity.id, source: structuredClone(origin.source), artifact: structuredClone(origin.artifact),
      reuse: { session_id: this.sessionId, question_fingerprint: identity.fingerprint, attempt: identity.attempt,
        origin_question_id: origin.question_id, origin_record_sha256: digest, origin_files_sha256: files,
        freshness, scope: scope.trim(), reused_at: stamp() } };
    this.rememberEvidence(record, { reuse: structuredClone(record.reuse), origin_source: structuredClone(origin.source), origin_artifact: structuredClone(origin.artifact) });
    if (this.archive) fs.appendFileSync(evidencePath(this), JSON.stringify(record) + '\n', 'utf8');
    this.evidence.push(record);
    this.log('evidence_reused', { question_id: identity.id, origin_question_id: origin.question_id, freshness, scope: record.reuse.scope, url: record.source.url });
    return structuredClone(record);
  };

  p.validateReusedEvidence = function (record, question) {
    try {
      const identity = questionIdentity(question), reuse = record?.reuse;
      const attempt = this.questionRecords.findLast(item => item.question_id === identity.id);
      if (record?.kind !== 'reused_web' || record.question_id !== identity.id || !identity.fingerprint
        || reuse?.session_id !== this.sessionId || reuse.question_fingerprint !== identity.fingerprint
        || reuse.attempt !== attempt?.attempt || !['stable', 'versioned'].includes(reuse.freshness)
        || typeof reuse.scope !== 'string' || !reuse.scope.trim() || typeof reuse.reused_at !== 'string'
        || typeof reuse.origin_record_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reuse.origin_record_sha256)
        || !Number.isFinite(Date.parse(reuse.reused_at))) throw new Error('Reused evidence belongs to a different question/attempt or has invalid reuse metadata.');
      if (record.artifact?.storage === 'memory') {
        const payload = this.evidencePayload(record);
        if (!payload || JSON.stringify(payload.reuse) !== JSON.stringify(reuse)
          || sourceKey(payload.origin_source) !== sourceKey(record.source)
          || JSON.stringify(payload.origin_artifact) !== JSON.stringify(record.artifact)) throw new Error('Memory evidence reuse is missing, unregistered or modified.');
      }
      const { record: origin, files } = findOriginal(this, record.source, reuse.origin_record_sha256);
      const expectedFiles = reuse.origin_files_sha256 || {};
      if (origin.question_id !== reuse.origin_question_id || JSON.stringify(origin.artifact) !== JSON.stringify(record.artifact)
        || Object.keys(files).length !== Object.keys(expectedFiles).length
        || Object.entries(files).some(([key, value]) => value !== expectedFiles[key])) throw new Error('Original evidence or files changed after reuse.');
      return { origin_question_id: origin.question_id };
    } catch (error) { return { warning: '复用网站证据无效：' + error.message }; }
  };
}

module.exports = { installEvidenceReuse };
