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
   * @returns {Promise<{ results: Array, warnings: Array }>}
   */
  static async search(query, filters = {}) {
    const cacheKey = `search:${query}:${JSON.stringify(filters)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const failedProviders = [];

    // Fan out all provider searches concurrently; failures are isolated
    const settled = await Promise.allSettled(
      PROVIDERS.map(async p => {
        try {
          return await p.search(query, filters);
        } catch (err) {
          log.warn(`Provider ${p.constructor.name} search failed: ${err.message}`);
          failedProviders.push(p.constructor.name.replace("Provider", "").toLowerCase());
          return [];
        }
      })
    );

    // Flatten fulfilled results
    const all = settled
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value || []);

    // Deduplicate: collapse entries with the same normalised name into one
    const merged = this._deduplicate(all);

    // Score and sort
    let scored = [];
    if (query) {
      // Query search: sort by relevance score
      scored = merged
        .map(plugin => ({ ...plugin, _score: this._score(plugin, query, filters) }))
        .sort((a, b) => b._score - a._score);
    } else if (filters.sortBy === "featured") {
      // Featured section
      scored = merged
        .map(plugin => ({ ...plugin, _score: this._featuredScore(plugin, filters) }))
        .sort((a, b) => b._score - a._score);
    } else if (filters.sortBy === "updated") {
      // Recently updated section
      scored = merged
        .sort((a, b) => {
          const aTime = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
          const bTime = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
          if (aTime !== bTime) return bTime - aTime;
          return b.downloads - a.downloads;
        });
    } else {
      // Popular section (default popularity sorting)
      scored = merged
        .sort((a, b) => this._comparePopularity(a, b, filters));
    }

    const payload = { results: scored, warnings: failedProviders };
    cache.set(cacheKey, payload, SEARCH_CACHE_TTL);
    return payload;
  }

  // Curated list of high quality plugins for Featured section
  static get CURATED_PLUGINS() {
    return [
      "essentialsx", "luckperms", "worldedit", "vault", "geysermc", 
      "viaversion", "dynmap", "coreprotect", "protocollib", "citizens", 
      "placeholderapi", "multiverse-core", "griefprevention"
    ];
  }

  static _featuredScore(plugin, filters) {
    let score = 0;

    // Curated list boost
    const normName = plugin.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (this.CURATED_PLUGINS.some(cur => normName.includes(cur))) {
      score += 500;
    }

    // Verified project
    if (plugin.verified) score += 100;

    // Platform compatibility
    if (filters.software) {
      const loaders = plugin.compatibleLoaders || [];
      if (loaders.some(l => CompatibilityService.isCompatible(filters.software, l))) {
        score += 40;
      }
    }

    // MC version compatibility
    if (filters.minecraftVersion) {
      const versions = plugin.compatibleMinecraftVersions || [];
      if (versions.includes(filters.minecraftVersion)) score += 50;
    }

    // Downloads (log-scaled, max 50)
    if (plugin.downloads > 0) {
      score += Math.min(50, Math.floor(Math.log10(plugin.downloads + 1) * 10));
    }

    // Stars (log-scaled, max 30)
    if (plugin.stars > 0) {
      score += Math.min(30, Math.floor(Math.log10(plugin.stars + 1) * 8));
    }

    return score;
  }

  static _comparePopularity(a, b, filters) {
    // 1. Verified projects
    if (!!a.verified !== !!b.verified) {
      return a.verified ? -1 : 1;
    }
    // 2. Download count
    if (a.downloads !== b.downloads) {
      return b.downloads - a.downloads;
    }
    // 3. Favorites/Stars
    if (a.stars !== b.stars) {
      return b.stars - a.stars;
    }
    // 4. Recently updated
    const aTime = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
    const bTime = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    // 5. Compatible with the current server
    const aComp = this._isCompatible(a, filters);
    const bComp = this._isCompatible(b, filters);
    if (aComp !== bComp) {
      return aComp ? -1 : 1;
    }
    return 0;
  }

  static _isCompatible(plugin, filters) {
    if (filters.software) {
      const loaders = plugin.compatibleLoaders || [];
      if (loaders.length > 0 && !loaders.some(l => CompatibilityService.isCompatible(filters.software, l))) {
        return false;
      }
    }
    if (filters.minecraftVersion) {
      const versions = plugin.compatibleMinecraftVersions || [];
      if (versions.length > 0 && !versions.includes(filters.minecraftVersion)) {
        return false;
      }
    }
    return true;
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
        if (!existing.latestVersion && plugin.latestVersion) existing.latestVersion = plugin.latestVersion;
        if (plugin.verified) existing.verified = true;
        if (plugin.compatibleLoaders && plugin.compatibleLoaders.length > 0) {
          existing.compatibleLoaders = Array.from(new Set([...(existing.compatibleLoaders || []), ...plugin.compatibleLoaders]));
        }
        if (plugin.compatibleMinecraftVersions && plugin.compatibleMinecraftVersions.length > 0) {
          existing.compatibleMinecraftVersions = Array.from(new Set([...(existing.compatibleMinecraftVersions || []), ...plugin.compatibleMinecraftVersions]));
        }
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

    // Verified flag
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
