/**
 * SearchService
 * Queries all providers in parallel, normalizes results via PluginNormalizer,
 * deduplicates overlapping plugins, and applies deterministic relevance scoring.
 *
 * Scoring algorithm (max ~225 pts):
 *   Exact name match          +100
 *   Verified/Official flag    +30
 *   Compatible MC version     +25
 *   Compatible platform       +20
 *   Downloads (log-scaled)    +25
 *   Stars (log-scaled)        +15
 *   Updated within 30 days    +10
 */

const ModrinthProvider = require("../providers/Modrinth");
const HangarProvider   = require("../providers/Hangar");
const SpigetProvider   = require("../providers/Spiget");
const GithubProvider   = require("../providers/Github");
const CompatibilityService = require("./CompatibilityService");
const cache = require("../cache");
const log   = new (require("cat-loggr"))();

const PROVIDERS = [
  new ModrinthProvider(),
  new HangarProvider(),
  new SpigetProvider(),
  new GithubProvider(),
];

// Cache TTL: 10 minutes
const SEARCH_CACHE_TTL = 10 * 60 * 1000;

class SearchService {
  /**
   * Search across all providers and return a merged, deduplicated, ranked list.
   *
   * @param {string} query
   * @param {Object} filters  { software, minecraftVersion, category, sortBy }
   * @returns {Promise<Array>}
   */
  static async search(query, filters = {}) {
    const cacheKey = `search:${query}:${JSON.stringify(filters)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Fan out all provider searches concurrently; failures are isolated
    const settled = await Promise.allSettled(
      PROVIDERS.map(p => p.search(query, filters).catch(err => {
        log.warn(`Provider ${p.constructor.name} search failed: ${err.message}`);
        return [];
      }))
    );

    // Flatten fulfilled results
    const all = settled
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value || []);

    // Deduplicate: collapse entries with the same normalised name into one,
    // recording all source providers on the merged item
    const merged = this._deduplicate(all);

    // Score and sort
    const scored = merged
      .map(plugin => ({ ...plugin, _score: this._score(plugin, query, filters) }))
      .sort((a, b) => b._score - a._score);

    cache.set(cacheKey, scored, SEARCH_CACHE_TTL);
    return scored;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  static _deduplicate(plugins) {
    const seen = new Map();

    for (const plugin of plugins) {
      const key = plugin.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(key)) {
        // Merge: keep higher download count, record additional sources
        const existing = seen.get(key);
        existing.downloads = Math.max(existing.downloads, plugin.downloads);
        existing.stars     = Math.max(existing.stars,     plugin.stars);
        existing._sources  = [...(existing._sources || [existing.provider]), plugin.provider];
        if (!existing.iconUrl && plugin.iconUrl) existing.iconUrl = plugin.iconUrl;
      } else {
        seen.set(key, { ...plugin, _sources: [plugin.provider] });
      }
    }

    return Array.from(seen.values());
  }

  static _score(plugin, query, filters) {
    let score = 0;

    // Exact name match
    if (plugin.name.toLowerCase() === query.toLowerCase()) score += 100;
    else if (plugin.name.toLowerCase().includes(query.toLowerCase())) score += 40;

    // Verified flag (Modrinth & Hangar expose this)
    if (plugin.verified) score += 30;

    // Platform compatibility
    if (filters.software) {
      const loaders = plugin.compatibleLoaders || [];
      if (loaders.some(l => CompatibilityService.isCompatible(filters.software, l))) {
        score += 20;
      }
    }

    // MC version compatibility
    if (filters.minecraftVersion) {
      const versions = plugin.compatibleMinecraftVersions || [];
      if (versions.includes(filters.minecraftVersion)) score += 25;
    }

    // Downloads (log-scaled, max 25)
    if (plugin.downloads > 0) {
      score += Math.min(25, Math.floor(Math.log10(plugin.downloads) * 5));
    }

    // Stars (log-scaled, max 15)
    if (plugin.stars > 0) {
      score += Math.min(15, Math.floor(Math.log10(plugin.stars + 1) * 4));
    }

    // Recently updated (within 30 days)
    if (plugin.lastUpdated) {
      const daysSince = (Date.now() - new Date(plugin.lastUpdated).getTime()) / 86400000;
      if (daysSince <= 30) score += 10;
    }

    return score;
  }
}

module.exports = SearchService;
