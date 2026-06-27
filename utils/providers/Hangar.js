const BaseProvider = require("./BaseProvider");
const PluginNormalizer = require("./PluginNormalizer");
const axios = require("axios");

class HangarProvider extends BaseProvider {
  constructor() {
    super();
    this.api = axios.create({
      baseURL: "https://hangar.papermc.io/api/v1",
      headers: {
        "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
      }
    });
  }

  async search(query, filters = {}) {
    try {
      const params = {
        limit: query ? 20 : 40
      };

      if (query) {
        params.q = query;
      } else {
        params.sort = filters.sortBy === "updated" ? "updated" : "downloads";
      }

      const response = await this.api.get("/projects", { params });
      return (response.data.result || []).map(proj => PluginNormalizer.normalizeHangar(proj));
    } catch (error) {
      console.error("Hangar search failed:", error.message);
      return [];
    }
  }

  async getDetails(pluginId) {
    try {
      // pluginId format is "author/slug"
      const [author, slug] = pluginId.split("/");
      if (!author || !slug) {
        throw new Error("Invalid Hangar pluginId. Expected format: 'author/slug'");
      }

      const response = await this.api.get(`/projects/${author}/${slug}`);
      const project = response.data;

      return {
        ...PluginNormalizer.normalizeHangar(project),
        longDescription: project.description || "",
        license: project.settings?.license?.name || "Unknown",
        homepage: project.settings?.links?.homepage || "",
        sourceRepo: project.settings?.links?.source || "",
        documentation: project.settings?.links?.wiki || "",
        screenshots: [],
        lastUpdated: project.lastUpdated || null
      };
    } catch (error) {
      console.error("Hangar getDetails failed:", error.message);
      return null;
    }
  }

  async getVersions(pluginId, filters = {}) {
    try {
      const [author, slug] = pluginId.split("/");
      if (!author || !slug) {
        throw new Error("Invalid Hangar pluginId. Expected format: 'author/slug'");
      }

      const response = await this.api.get(`/projects/${author}/${slug}/versions`);
      const list = response.data.result || [];

      return list.map(ver => {
        // Map Hangar platforms
        const platforms = Object.keys(ver.platformDependencies || {});
        // Get downloads and files info
        const files = Object.entries(ver.downloads || {}).map(([platform, dlInfo]) => ({
          filename: dlInfo.fileName || `${slug}-${ver.name}.jar`,
          url: dlInfo.downloadUrl || null,
          platform: platform,
          hashes: { sha256: dlInfo.hash || null }
        }));

        return {
          id: ver.name,
          name: ver.name,
          versionNumber: ver.name,
          changelog: ver.description || "",
          downloadsCount: ver.stats?.totalDownloads || 0,
          publishedAt: ver.createdAt,
          compatibleMinecraftVersions: [], // Needs deep dependencies parsing if needed
          compatibleLoaders: platforms,
          files: files,
          dependencies: [] // Simplification
        };
      });
    } catch (error) {
      console.error("Hangar getVersions failed:", error.message);
      return [];
    }
  }

  async download(pluginId, versionId) {
    try {
      const [author, slug] = pluginId.split("/");
      if (!author || !slug) {
        throw new Error("Invalid Hangar pluginId");
      }

      // Fetch version to get download URL
      const response = await this.api.get(`/projects/${author}/${slug}/versions/${versionId}`);
      const ver = response.data;
      
      const firstPlatform = Object.keys(ver.downloads || {})[0];
      if (!firstPlatform) {
        throw new Error("No download platform available");
      }

      const downloadInfo = ver.downloads[firstPlatform];
      const filename = downloadInfo.fileName || `${slug}-${versionId}.jar`;
      
      let downloadUrl = downloadInfo.downloadUrl;
      if (!downloadUrl) {
        // Construct fallback download URL
        downloadUrl = `https://hangar.papermc.io/api/v1/projects/${author}/${slug}/versions/${versionId}/platforms/${firstPlatform}/download`;
      }

      const downloadResponse = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
        }
      });

      return {
        buffer: Buffer.from(downloadResponse.data),
        filename: filename,
        checksum: downloadInfo.hash || null
      };
    } catch (error) {
      console.error("Hangar download failed:", error.message);
      throw error;
    }
  }
}

module.exports = HangarProvider;
