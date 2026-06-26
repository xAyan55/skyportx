const BaseProvider = require("./BaseProvider");
const PluginNormalizer = require("./PluginNormalizer");
const axios = require("axios");

class GithubProvider extends BaseProvider {
  constructor() {
    super();
    this.api = axios.create({
      baseURL: "https://api.github.com",
      headers: {
        "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
      }
    });
  }

  async search(query, filters = {}) {
    try {
      // If query is a repo directly (owner/name), search by repository path
      if (query.includes("/")) {
        const repoDetails = await this.getDetails(query);
        return repoDetails ? [repoDetails] : [];
      }

      const params = {
        q: `${query} topic:minecraft-plugin`,
        per_page: 20
      };

      const response = await this.api.get("/search/repositories", { params });
      return (response.data.items || []).map(item => PluginNormalizer.normalizeGithub(item));
    } catch (error) {
      console.error("Github search failed:", error.message);
      return [];
    }
  }

  async getDetails(pluginId) {
    try {
      const [owner, repo] = pluginId.split("/");
      if (!owner || !repo) {
        throw new Error("Invalid GitHub repository. Format: 'owner/repo'");
      }

      const response = await this.api.get(`/repos/${owner}/${repo}`);
      const item = response.data;

      return {
        ...PluginNormalizer.normalizeGithub(item),
        longDescription: item.description || "",
        license: item.license?.name || "Unknown",
        homepage: item.homepage || item.html_url,
        sourceRepo: item.html_url,
        documentation: item.homepage || "",
        screenshots: [],
        lastUpdated: item.pushed_at
      };
    } catch (error) {
      console.error("Github getDetails failed:", error.message);
      return null;
    }
  }

  async getVersions(pluginId, filters = {}) {
    try {
      const [owner, repo] = pluginId.split("/");
      if (!owner || !repo) {
        throw new Error("Invalid GitHub repository. Format: 'owner/repo'");
      }

      const response = await this.api.get(`/repos/${owner}/${repo}/releases`);
      const releases = response.data || [];

      return releases.map(rel => {
        // Find .jar assets
        const jarAssets = (rel.assets || []).filter(a => a.name.endsWith(".jar"));
        const files = jarAssets.map(asset => ({
          filename: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
          id: String(asset.id)
        }));

        return {
          id: String(rel.id),
          name: rel.name || rel.tag_name,
          versionNumber: rel.tag_name,
          changelog: rel.body || "",
          downloadsCount: jarAssets.reduce((sum, asset) => sum + (asset.download_count || 0), 0),
          publishedAt: rel.published_at,
          compatibleMinecraftVersions: [],
          compatibleLoaders: [],
          files: files,
          dependencies: []
        };
      });
    } catch (error) {
      console.error("Github getVersions failed:", error.message);
      return [];
    }
  }

  async download(pluginId, versionId) {
    try {
      const [owner, repo] = pluginId.split("/");
      if (!owner || !repo) {
        throw new Error("Invalid GitHub repository. Format: 'owner/repo'");
      }

      // Fetch release to find asset
      const response = await this.api.get(`/repos/${owner}/${repo}/releases`);
      const release = (response.data || []).find(r => String(r.id) === String(versionId));
      if (!release) {
        throw new Error("Release not found");
      }

      const jarAssets = (release.assets || []).filter(a => a.name.endsWith(".jar"));
      if (jarAssets.length === 0) {
        throw new Error("No JAR asset found in GitHub release");
      }

      const selectedAsset = jarAssets[0];
      const downloadResponse = await axios.get(selectedAsset.browser_download_url, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
        }
      });

      return {
        buffer: Buffer.from(downloadResponse.data),
        filename: selectedAsset.name,
        checksum: null
      };
    } catch (error) {
      console.error("Github download failed:", error.message);
      throw error;
    }
  }
}

module.exports = GithubProvider;
