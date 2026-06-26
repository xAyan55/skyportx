/**
 * DependencyService
 * Resolves required and optional plugin dependencies before installation.
 * Checks which dependencies are already installed (via filesystem scan) and
 * returns only what still needs to be fetched.
 */

const log = new (require("cat-loggr"))();

class DependencyService {
  /**
   * Resolve dependencies for a list of version objects.
   * Returns a dependency plan listing what needs to be installed.
   *
   * @param {Array}  dependencies  Array of { name, projectId, type } from provider.
   * @param {Array}  installedPlugins  Array of already-installed plugin metadata objects.
   * @param {Object} provider      The provider instance to fetch details from.
   * @returns {Promise<{ required: Array, optional: Array }>}
   */
  static async resolve(dependencies, installedPlugins, provider) {
    const installedNames = new Set(
      (installedPlugins || []).map(p => (p.name || "").toLowerCase())
    );

    const required = [];
    const optional = [];

    for (const dep of dependencies || []) {
      const depName = (dep.name || dep.projectId || "").toLowerCase();
      if (!depName) continue;

      // Already installed – skip
      if (installedNames.has(depName)) continue;

      // Fetch details if we have a projectId and provider
      let details = null;
      if (dep.projectId && provider) {
        try {
          details = await provider.getDetails(dep.projectId);
        } catch (err) {
          log.warn(`DependencyService: could not fetch details for ${dep.projectId}: ${err.message}`);
        }
      }

      const entry = {
        name:      details?.name || dep.name || dep.projectId,
        projectId: dep.projectId || null,
        iconUrl:   details?.iconUrl || null,
        provider:  provider?.constructor?.name?.toLowerCase() || "unknown",
        alreadyInstalled: false,
      };

      if (dep.type === "required" || dep.required === true) {
        required.push(entry);
      } else {
        optional.push(entry);
      }
    }

    return { required, optional };
  }
}

module.exports = DependencyService;
