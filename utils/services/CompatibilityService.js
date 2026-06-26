/**
 * CompatibilityService
 * Normalizes platform names and resolves compatibility inheritance.
 *
 * Compatibility hierarchy:
 *   folia     → satisfies paper, spigot, bukkit
 *   purpur    → satisfies paper, spigot, bukkit
 *   paper     → satisfies spigot, bukkit
 *   spigot    → satisfies bukkit
 *   waterfall → satisfies bungeecord
 */

// Maps each platform to its implicit ancestors (platforms it also satisfies)
const PLATFORM_INHERITANCE = {
  folia: ["folia", "paper", "spigot", "bukkit"],
  purpur: ["purpur", "paper", "spigot", "bukkit"],
  paper: ["paper", "spigot", "bukkit"],
  spigot: ["spigot", "bukkit"],
  bukkit: ["bukkit"],
  waterfall: ["waterfall", "bungeecord"],
  bungeecord: ["bungeecord"],
  velocity: ["velocity"],
  fabric: ["fabric"],
  forge: ["forge"],
  neoforge: ["neoforge"],
};

class CompatibilityService {
  /**
   * Check whether a plugin that declares support for `requiredPlatform`
   * can be installed on `actualPlatform`.
   *
   * Example: actualPlatform=folia, requiredPlatform=paper → true
   *
   * @param {string} actualPlatform   The server's actual software (e.g. "folia")
   * @param {string} requiredPlatform The platform the plugin declares support for
   * @returns {boolean}
   */
  static isCompatible(actualPlatform, requiredPlatform) {
    if (!actualPlatform || !requiredPlatform) return false;
    const actual = actualPlatform.toLowerCase().trim();
    const required = requiredPlatform.toLowerCase().trim();
    const satisfies = PLATFORM_INHERITANCE[actual] || [actual];
    return satisfies.includes(required);
  }

  /**
   * Filter a list of plugin versions to only those compatible with the
   * given server software and Minecraft version.
   *
   * @param {Array}  versions          Provider-normalized version list.
   * @param {string} serverSoftware    E.g. "paper", "fabric".
   * @param {string} minecraftVersion  E.g. "1.21.1".
   * @returns {Array} Filtered and sorted versions (newest first).
   */
  static filterCompatibleVersions(versions, serverSoftware, minecraftVersion) {
    if (!versions || versions.length === 0) return [];

    return versions.filter(ver => {
      // Check loader/platform compatibility
      const loaderCompat =
        !ver.compatibleLoaders ||
        ver.compatibleLoaders.length === 0 ||
        ver.compatibleLoaders.some(loader =>
          this.isCompatible(serverSoftware, loader)
        );

      // Check Minecraft version compatibility
      const versionCompat =
        !minecraftVersion ||
        !ver.compatibleMinecraftVersions ||
        ver.compatibleMinecraftVersions.length === 0 ||
        ver.compatibleMinecraftVersions.includes(minecraftVersion);

      return loaderCompat && versionCompat;
    });
  }

  /**
   * Determine the best matching version from a filtered list.
   * Returns the first item (providers already sort newest-first).
   *
   * @param {Array}  versions
   * @param {string} serverSoftware
   * @param {string} minecraftVersion
   * @returns {Object|null}
   */
  static getBestVersion(versions, serverSoftware, minecraftVersion) {
    const compatible = this.filterCompatibleVersions(versions, serverSoftware, minecraftVersion);
    return compatible.length > 0 ? compatible[0] : null;
  }

  /**
   * Normalize a raw platform string from a plugin manifest or provider
   * to a canonical lowercase key used throughout the system.
   *
   * @param {string} raw
   * @returns {string}
   */
  static normalizePlatform(raw) {
    if (!raw) return "unknown";
    const lower = raw.toLowerCase().trim();
    const aliases = {
      "bukkit": "bukkit",
      "craftbukkit": "bukkit",
      "spigot": "spigot",
      "paper": "paper",
      "papermc": "paper",
      "purpur": "purpur",
      "folia": "folia",
      "velocity": "velocity",
      "bungeecord": "bungeecord",
      "bungee": "bungeecord",
      "waterfall": "waterfall",
      "fabric": "fabric",
      "forge": "forge",
      "neoforge": "neoforge",
    };
    return aliases[lower] || lower;
  }

  /**
   * Return the inheritance chain for a given platform.
   * Useful for displaying compatibility badges in the UI.
   *
   * @param {string} platform
   * @returns {string[]}
   */
  static getPlatformChain(platform) {
    return PLATFORM_INHERITANCE[platform.toLowerCase()] || [platform.toLowerCase()];
  }
}

module.exports = CompatibilityService;
