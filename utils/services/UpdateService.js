/**
 * UpdateService
 * Compares the list of installed plugins (parsed from the filesystem)
 * against provider version data to identify available updates.
 *
 * Does NOT store state in the DB. Reads from the live filesystem scan
 * cached by InstallationService.listInstalled().
 *
 * Respects per-plugin ignored versions stored in the lightweight
 * user-preferences store (db key: `${instanceId}_plugin_prefs`).
 */

const cache = require("../cache");
const log   = new (require("cat-loggr"))();

// Cache update check results for 30 minutes
const UPDATE_CACHE_TTL = 30 * 60 * 1000;

class UpdateService {
  /**
   * Check for available updates across all installed plugins.
   *
   * @param {string} instanceId        Panel instance ID.
   * @param {Array}  installedPlugins  Output of InstallationService.listInstalled().
   * @param {Object} provider          Provider instance to query versions from.
   * @param {string} software          Server software (e.g. "paper").
   * @param {string} minecraftVersion  Minecraft version string (e.g. "1.21.1").
   * @param {Object} db                Panel's Keyv db instance.
   * @returns {Promise<Array>}  List of { plugin, currentVersion, latestVersion, versionId }
   */
  static async checkAll(instanceId, installedPlugins, provider, software, minecraftVersion, db) {
    const cacheKey = `updates:${instanceId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Load user-ignored versions
    const prefs = (await db.get(`${instanceId}_plugin_prefs`)) || {};
    const ignored = prefs.ignoredVersions || {};

    const updates = [];

    await Promise.allSettled(
      installedPlugins.map(async plugin => {
        if (!plugin.providerId || !plugin.provider) return;

        try {
          const versions = await provider.getVersions(plugin.providerId, {
            software, minecraftVersion
          });

          if (!versions || versions.length === 0) return;
          const latest = versions[0]; // providers return newest-first

          // Skip if user ignored this version
          if (ignored[plugin.name]?.includes(latest.versionNumber)) return;

          // Compare version strings – only surface if different
          if (latest.versionNumber !== plugin.version) {
            updates.push({
              plugin,
              currentVersion: plugin.version,
              latestVersion:  latest.versionNumber,
              versionId:      latest.id,
              changelog:      latest.changelog || "",
            });
          }
        } catch (err) {
          log.warn(`UpdateService: check failed for plugin '${plugin.name}': ${err.message}`);
        }
      })
    );

    cache.set(cacheKey, updates, UPDATE_CACHE_TTL);
    return updates;
  }

  /**
   * Mark a specific version as ignored for a plugin.
   *
   * @param {string} instanceId
   * @param {string} pluginName
   * @param {string} versionNumber
   * @param {Object} db
   */
  static async ignoreVersion(instanceId, pluginName, versionNumber, db) {
    const prefs = (await db.get(`${instanceId}_plugin_prefs`)) || {};
    if (!prefs.ignoredVersions) prefs.ignoredVersions = {};
    if (!prefs.ignoredVersions[pluginName]) prefs.ignoredVersions[pluginName] = [];
    if (!prefs.ignoredVersions[pluginName].includes(versionNumber)) {
      prefs.ignoredVersions[pluginName].push(versionNumber);
    }
    await db.set(`${instanceId}_plugin_prefs`, prefs);

    // Invalidate cached update check
    cache.delete(`updates:${instanceId}`);
  }
}

module.exports = UpdateService;
