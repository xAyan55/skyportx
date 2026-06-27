class PluginNormalizer {
  static normalizeModrinth(project) {
    return {
      id: project.project_id || project.id,
      name: project.title,
      description: project.description,
      author: project.author || "Unknown",
      downloads: project.downloads || 0,
      stars: project.followers || 0,
      iconUrl: project.icon_url || null,
      provider: "modrinth",
      sourceUrl: `https://modrinth.com/mod/${project.slug || project.id}`,
      categories: project.categories || [],
      compatibleLoaders: project.categories || [],
      compatibleMinecraftVersions: project.versions || [],
      latestVersion: project.latest_version || "",
      verified: !!project.verified
    };
  }

  static normalizeHangar(project) {
    const author = project.author || (project.namespace ? project.namespace.owner : "Unknown");
    const slug = project.slug || project.name;
    
    // Extract loaders and minecraft versions from promotedVersions
    const loadersSet = new Set();
    const mcVersionsSet = new Set();
    let latestVersion = "";

    if (Array.isArray(project.promotedVersions)) {
      project.promotedVersions.forEach(pv => {
        if (pv.platform) loadersSet.add(pv.platform.toLowerCase());
        if (pv.version) latestVersion = pv.version;
        if (Array.isArray(pv.tags)) {
          pv.tags.forEach(t => {
            if (t.name === "Minecraft") {
              if (Array.isArray(t.data)) {
                t.data.forEach(v => mcVersionsSet.add(v));
              } else if (t.data) {
                mcVersionsSet.add(t.data);
              }
            }
          });
        }
      });
    }

    const compatibleLoaders = loadersSet.size > 0 ? Array.from(loadersSet) : ["paper", "spigot"];

    return {
      id: `${author}/${slug}`,
      name: project.name,
      description: project.description || "",
      author: author,
      downloads: project.stats?.downloads || 0,
      stars: project.stats?.stars || 0,
      iconUrl: project.avatarUrl || null,
      provider: "hangar",
      sourceUrl: `https://hangar.papermc.io/${author}/${slug}`,
      categories: project.category ? [project.category] : [],
      compatibleLoaders,
      compatibleMinecraftVersions: Array.from(mcVersionsSet),
      latestVersion,
      verified: project.recommended || false
    };
  }

  static normalizeSpiget(resource) {
    const author = resource.author?.name || "Unknown";
    return {
      id: String(resource.id),
      name: resource.name,
      description: resource.tag || "",
      author: author,
      downloads: resource.downloads || 0,
      stars: resource.likes || 0,
      iconUrl: resource.icon?.url ? `https://spigotmc.org/${resource.icon.url}` : null,
      provider: "spiget",
      sourceUrl: `https://spigotmc.org/resources/${resource.id}`,
      categories: [],
      compatibleLoaders: ["spigot", "paper", "bukkit"],
      compatibleMinecraftVersions: resource.testedVersions || [],
      latestVersion: resource.version?.name || "",
      verified: false
    };
  }

  static normalizeGithub(repo) {
    return {
      id: repo.full_name,
      name: repo.name,
      description: repo.description || "",
      author: repo.owner?.login || "Unknown",
      downloads: 0,
      stars: repo.stargazers_count || 0,
      iconUrl: repo.owner?.avatar_url || null,
      provider: "github",
      sourceUrl: repo.html_url,
      categories: repo.topics || [],
      compatibleLoaders: ["spigot", "paper"],
      compatibleMinecraftVersions: [],
      latestVersion: "",
      verified: false
    };
  }
}

module.exports = PluginNormalizer;
