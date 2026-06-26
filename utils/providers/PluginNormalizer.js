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
      categories: project.categories || []
    };
  }

  static normalizeHangar(project) {
    const author = project.author || (project.namespace ? project.namespace.owner : "Unknown");
    const slug = project.slug || project.name;
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
      categories: project.category ? [project.category] : []
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
      categories: []
    };
  }

  static normalizeGithub(repo) {
    return {
      id: repo.full_name,
      name: repo.name,
      description: repo.description || "",
      author: repo.owner?.login || "Unknown",
      downloads: 0, // Github repos don't have aggregated download count easily
      stars: repo.stargazers_count || 0,
      iconUrl: repo.owner?.avatar_url || null,
      provider: "github",
      sourceUrl: repo.html_url,
      categories: repo.topics || []
    };
  }
}

module.exports = PluginNormalizer;
