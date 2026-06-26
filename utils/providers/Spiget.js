const BaseProvider = require("./BaseProvider");
const PluginNormalizer = require("./PluginNormalizer");
const axios = require("axios");

class SpigetProvider extends BaseProvider {
  constructor() {
    super();
    this.api = axios.create({
      baseURL: "https://api.spiget.org/v2",
      headers: {
        "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
      }
    });
  }

  async search(query, filters = {}) {
    try {
      const response = await this.api.get(`/search/resources/${encodeURIComponent(query)}`, {
        params: {
          size: 20,
          fields: "id,name,tag,contributors,likes,downloads,icon,author"
        }
      });
      return (response.data || []).map(res => PluginNormalizer.normalizeSpiget(res));
    } catch (error) {
      console.error("Spiget search failed:", error.message);
      return [];
    }
  }

  async getDetails(pluginId) {
    try {
      const response = await this.api.get(`/resources/${pluginId}`);
      const res = response.data;
      
      // Fetch author if possible
      let authorName = "Unknown";
      if (res.author && res.author.id) {
        try {
          const authRes = await this.api.get(`/authors/${res.author.id}`);
          authorName = authRes.data.name || "Unknown";
        } catch (err) {}
      }

      return {
        ...PluginNormalizer.normalizeSpiget({ ...res, author: { name: authorName } }),
        longDescription: res.description ? Buffer.from(res.description, "base64").toString("utf8") : "",
        license: "Spigot License",
        homepage: `https://www.spigotmc.org/resources/${pluginId}/`,
        sourceRepo: res.sourceCodeLink || "",
        documentation: res.donationLink || "",
        screenshots: [],
        lastUpdated: res.updateDate ? new Date(res.updateDate * 1000).toISOString() : null
      };
    } catch (error) {
      console.error("Spiget getDetails failed:", error.message);
      return null;
    }
  }

  async getVersions(pluginId, filters = {}) {
    try {
      const response = await this.api.get(`/resources/${pluginId}/versions`, {
        params: { size: 50, sort: "-releaseDate" }
      });
      
      return (response.data || []).map(ver => ({
        id: String(ver.id),
        name: ver.name,
        versionNumber: ver.name,
        changelog: "",
        downloadsCount: ver.downloads || 0,
        publishedAt: ver.releaseDate ? new Date(ver.releaseDate * 1000).toISOString() : null,
        compatibleMinecraftVersions: [],
        compatibleLoaders: ["spigot", "paper", "bukkit"],
        files: [{
          filename: `${pluginId}-${ver.name}.jar`,
          url: `https://api.spiget.org/v2/resources/${pluginId}/versions/${ver.id}/download`,
          size: 0
        }],
        dependencies: []
      }));
    } catch (error) {
      console.error("Spiget getVersions failed:", error.message);
      return [];
    }
  }

  async download(pluginId, versionId) {
    try {
      // Spiget download URLs
      const downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/versions/${versionId}/download`;
      
      const downloadResponse = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
        }
      });

      // Verify that response is not an error page
      const length = downloadResponse.data.length;
      if (length < 1000) {
        const text = Buffer.from(downloadResponse.data).toString("utf8");
        if (text.includes("Resource is hosted externally")) {
          throw new Error("This resource is hosted externally and cannot be downloaded directly. Please download it from SpigotMC.");
        }
      }

      return {
        buffer: Buffer.from(downloadResponse.data),
        filename: `spiget-${pluginId}-${versionId}.jar`,
        checksum: null // Spiget doesn't offer checksums easily
      };
    } catch (error) {
      console.error("Spiget download failed:", error.message);
      throw error;
    }
  }
}

module.exports = SpigetProvider;
