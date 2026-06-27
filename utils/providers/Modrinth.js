const BaseProvider = require("./BaseProvider");
const PluginNormalizer = require("./PluginNormalizer");
const axios = require("axios");

class ModrinthProvider extends BaseProvider {
  constructor() {
    super();
    this.api = axios.create({
      baseURL: "https://api.modrinth.com/v2",
      headers: {
        "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
      }
    });
  }

  async search(query, filters = {}) {
    try {
      const facets = [["project_type:mod"]];
      
      // Determine loaders to filter by based on server software
      const loaders = [];
      const software = (filters.software || "").toLowerCase();
      if (["paper", "purpur", "spigot", "bukkit", "folia"].includes(software)) {
        loaders.push("paper", "spigot", "purpur", "bukkit", "folia");
      } else if (software === "velocity") {
        loaders.push("velocity");
      } else if (["bungeecord", "waterfall"].includes(software)) {
        loaders.push("bungeecord", "waterfall");
      } else if (software === "fabric") {
        loaders.push("fabric");
      } else if (software === "forge") {
        loaders.push("forge");
      } else if (software === "neoforge") {
        loaders.push("neoforge");
      }

      if (loaders.length > 0) {
        facets.push(loaders.map(l => `categories:${l}`));
      }

      if (filters.minecraftVersion) {
        facets.push([`versions:${filters.minecraftVersion}`]);
      }

      if (filters.category) {
        facets.push([`categories:${filters.category}`]);
      }

      const params = {
        query: query || "",
        facets: JSON.stringify(facets),
        limit: query ? 20 : 40
      };

      if (!query) {
        params.index = filters.sortBy === "updated" ? "updated" : "downloads";
      }

      const response = await this.api.get("/search", { params });
      return (response.data.hits || []).map(hit => PluginNormalizer.normalizeModrinth(hit));
    } catch (error) {
      console.error("Modrinth search failed:", error.message);
      return [];
    }
  }

  async getDetails(pluginId) {
    try {
      const response = await this.api.get(`/project/${pluginId}`);
      const project = response.data;
      
      // Fetch author if possible
      let author = "Unknown";
      try {
        const membersResponse = await this.api.get(`/project/${pluginId}/members`);
        if (membersResponse.data && membersResponse.data.length > 0) {
          author = membersResponse.data[0].user.username;
        }
      } catch (err) {
        // Ignore
      }

      return {
        ...PluginNormalizer.normalizeModrinth(project),
        author,
        longDescription: project.body || "",
        license: project.license?.name || "Unknown",
        homepage: project.wiki_url || project.source_url || "",
        sourceRepo: project.source_url || "",
        documentation: project.wiki_url || "",
        screenshots: (project.gallery || []).map(g => g.url),
        lastUpdated: project.updated || null
      };
    } catch (error) {
      console.error("Modrinth getDetails failed:", error.message);
      return null;
    }
  }

  async getVersions(pluginId, filters = {}) {
    try {
      const params = {};
      if (filters.software) {
        params.loaders = JSON.stringify([filters.software.toLowerCase()]);
      }
      if (filters.minecraftVersion) {
        params.game_versions = JSON.stringify([filters.minecraftVersion]);
      }

      const response = await this.api.get(`/project/${pluginId}/version`, { params });
      return (response.data || []).map(ver => ({
        id: ver.id,
        name: ver.name,
        versionNumber: ver.version_number,
        changelog: ver.changelog || "",
        downloadsCount: ver.downloads || 0,
        publishedAt: ver.date_published,
        compatibleMinecraftVersions: ver.game_versions || [],
        compatibleLoaders: ver.loaders || [],
        files: (ver.files || []).map(f => ({
          filename: f.filename,
          url: f.url,
          size: f.size,
          primary: f.primary,
          hashes: f.hashes || {}
        })),
        dependencies: (ver.dependencies || []).map(dep => ({
          projectId: dep.project_id,
          versionId: dep.version_id,
          type: dep.dependency_type // "required" | "optional" | "embedded"
        }))
      }));
    } catch (error) {
      console.error("Modrinth getVersions failed:", error.message);
      return [];
    }
  }

  async download(pluginId, versionId) {
    try {
      const response = await this.api.get(`/version/${versionId}`);
      const ver = response.data;
      if (!ver.files || ver.files.length === 0) {
        throw new Error("No files found for version");
      }

      const primaryFile = ver.files.find(f => f.primary) || ver.files[0];
      
      const downloadResponse = await axios.get(primaryFile.url, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "SkyportPanel/0.3.0 (Minecraft Plugin Manager)"
        }
      });

      return {
        buffer: Buffer.from(downloadResponse.data),
        filename: primaryFile.filename,
        checksum: primaryFile.hashes?.sha256 || primaryFile.hashes?.sha1 || null
      };
    } catch (error) {
      console.error("Modrinth download failed:", error.message);
      throw error;
    }
  }
}

module.exports = ModrinthProvider;
