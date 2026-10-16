'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileAssetCache } = require('./asset-cache.cjs');
const clone = value => structuredClone(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateRecipes(recipes, sourceId) {
  if (!Array.isArray(recipes) || recipes.some(recipe => !recipe || typeof recipe.id !== 'string' || !recipe.id || typeof recipe.source_id !== 'string' || !recipe.source_id || sourceId && recipe.source_id !== sourceId) || new Set(recipes.map(recipe => recipe.id)).size !== recipes.length) throw new Error('Recipes must be an array with unique IDs and valid source identities.');
}

function validateIndex(index, explicitRecipes) {
  if (!index || !Array.isArray(index.sources)) throw new Error('Recipe index needs a sources array.');
  const sources = index.sources.map(source => ({ ...source, id: source.id || source.source_id }));
  if (sources.some(source => typeof source.id !== 'string' || !source.id) || new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Recipe source IDs must be unique.');
  const inline = explicitRecipes ?? index.recipes ?? [];
  validateRecipes(inline);
  return { index: clone(index), sources, inline: clone(inline), hash: digest(index) };
}

class RecipeStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.indexFile = path.join(this.root, 'references', 'search-index.json');
    this.files = new FileAssetCache();
    this.diskIndex = options.recipeIndex == null && !options.catalog;
    this.explicitRecipes = options.recipes == null ? undefined : clone(options.recipes);
    this.indexSignature = null;
    this.hasDiskIndex = false;
    this.cache = new Map();
    Object.assign(this, validateIndex(options.recipeIndex ?? { sources: [] }, this.explicitRecipes));
    if (this.diskIndex) this.refresh();
  }

  refresh() {
    if (!this.diskIndex) return false;
    if (!this.hasDiskIndex && !fs.existsSync(this.indexFile)) return false;
    const entry = this.files.load(this.indexFile, { allowedRoot: path.join(this.root, 'references'), json: true });
    if (entry.signature === this.indexSignature) return false;
    // Validate before atomically replacing the usable index. A failed refresh
    // throws rather than silently answering from an outdated catalog.
    const next = validateIndex(entry.value, this.explicitRecipes);
    this.cache.clear();
    Object.assign(this, next);
    this.indexSignature = entry.signature;
    this.hasDiskIndex = true;
    return true;
  }

  profile(sourceId) {
    this.refresh();
    return this.loadProfile(sourceId);
  }

  loadProfile(sourceId) {
    const source = this.sources.find(item => item.id === sourceId);
    if (!source) throw new Error(`No prepared site profile for source: ${sourceId}`);
    let profile;
    if (source.profile) {
      const relative = source.profile.replace(/\\/g, '/');
      if (!/^references\/sites\/[a-zA-Z0-9_-]+\.json$/.test(relative)) throw new Error('Site profile must be an indexed JSON file inside references/sites.');
      const file = path.join(this.root, relative);
      const entry = this.files.load(file, { allowedRoot: path.join(this.root, 'references', 'sites'), json: true });
      const cached = this.cache.get(sourceId);
      if (cached?.signature === entry.signature) return clone(cached.profile);
      this.cache.delete(sourceId);
      profile = entry.value;
      if (profile.source_id !== sourceId || !Array.isArray(profile.recipes)) throw new Error('Site profile identity or recipes are invalid.');
      validateRecipes(profile.recipes, sourceId);
      this.cache.set(sourceId, { signature: entry.signature, profile: clone(profile) });
    } else {
      const cached = this.cache.get(sourceId);
      if (cached) return clone(cached.profile);
      profile = { source_id: sourceId, recipes: this.inline.filter(recipe => recipe.source_id === sourceId) };
      this.cache.set(sourceId, { signature: null, profile: clone(profile) });
    }
    return clone(profile);
  }

  preload() {
    try { this.refresh(); }
    catch (error) { return { indexed: this.sources.length, loaded: 0, failed: 1, failures: [{ asset: 'search-index', error: error.message }], index_sha256: this.hash }; }
    const summary = { indexed: this.sources.length, loaded: 0, failed: 0, failures: [], index_sha256: this.hash };
    for (const source of this.sources) {
      try { this.loadProfile(source.id); summary.loaded++; }
      catch (error) { summary.failed++; summary.failures.push({ source_id: source.id, error: error.message }); }
    }
    return summary;
  }

  recipe(id) {
    if (typeof id !== 'string' || !id) throw new Error('Use a nonempty recipe ID.');
    this.refresh();
    let recipe = this.inline.find(item => item.id === id);
    if (!recipe) {
      const source = this.sources.find(item => item.recipe_ids?.includes(id) || id.startsWith(item.id + ':'));
      if (source) recipe = this.profile(source.id).recipes.find(item => item.id === id);
    }
    if (!recipe || typeof recipe.source_id !== 'string') throw new Error(`Unknown recipe ID: ${id}`);
    return clone(recipe);
  }

  find({ sourceId, taskKind } = {}) {
    if (!sourceId) throw new Error('Choose the authoritative source before selecting its task recipe.');
    return this.profile(sourceId).recipes.filter(item => !taskKind || item.task_kind === taskKind).map(clone);
  }
}

function locate(page, descriptor) {
  if (!descriptor) throw new Error('A real locator descriptor is required.');
  if (typeof descriptor.count === 'function' && typeof descriptor.page === 'function') {
    if (descriptor.page() !== page) throw new Error('Locator belongs to another page.');
    return descriptor;
  }
  if (typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('Use a locator descriptor or a native Locator.');
  let root = descriptor.frame ? page.frameLocator(descriptor.frame) : page;
  if (descriptor.scope) root = locate(page, descriptor.scope);
  const exact = descriptor.exact !== false;
  if (descriptor.role) return root.getByRole(descriptor.role, { ...(descriptor.name !== undefined ? { name: descriptor.name } : {}), exact });
  if (descriptor.label) return root.getByLabel(descriptor.label, { exact });
  if (descriptor.text) return root.getByText(descriptor.text, { exact });
  if (descriptor.css) return root.locator(descriptor.css);
  throw new Error('Locator needs role/name, label, text or observed CSS.');
}

async function uniqueVisible(page, descriptor) {
  const locator = locate(page, descriptor).filter({ visible: true });
  if (await locator.count() !== 1 || !await locator.isVisible().catch(() => false)) return null;
  return locator;
}

module.exports = { RecipeStore, locate, uniqueVisible };
