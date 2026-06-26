class BaseProvider {
  /**
   * Search for plugins.
   * @param {string} query Search query.
   * @param {Object} filters Query filters.
   * @returns {Promise<Array>} List of search results.
   */
  async search(query, filters) {
    throw new Error("Method 'search' must be implemented.");
  }

  /**
   * Get details of a plugin.
   * @param {string} pluginId Plugin ID.
   * @returns {Promise<Object>} Detailed plugin info.
   */
  async getDetails(pluginId) {
    throw new Error("Method 'getDetails' must be implemented.");
  }

  /**
   * Get all versions of a plugin.
   * @param {string} pluginId Plugin ID.
   * @returns {Promise<Array>} List of versions.
   */
  async getVersions(pluginId) {
    throw new Error("Method 'getVersions' must be implemented.");
  }

  /**
   * Download a plugin version.
   * @param {string} pluginId Plugin ID.
   * @param {string} versionId Version ID.
   * @returns {Promise<{buffer: Buffer, filename: string}>} Download buffer and filename.
   */
  async download(pluginId, versionId) {
    throw new Error("Method 'download' must be implemented.");
  }
}

module.exports = BaseProvider;
