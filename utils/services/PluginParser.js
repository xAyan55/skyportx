const fs = require("fs");
const path = require("path");

// Safely require adm-zip (since it's installed via npm install)
let AdmZip;
try {
  AdmZip = require("adm-zip");
} catch (err) {
  // Fallback in case package not loaded in this tick
}

class PluginParser {
  /**
   * Parse metadata from a plugin JAR file on the local filesystem.
   * @param {string} filePath Absolute path to the JAR file.
   * @returns {Object} Extracted metadata (name, version, platform, dependencies, mainClass).
   */
  static parse(filePath) {
    if (!AdmZip) {
      AdmZip = require("adm-zip");
    }

    try {
      const zip = new AdmZip(filePath);
      
      // 1. Try Bukkit/Spigot/Paper plugin.yml
      const pluginYmlEntry = zip.getEntry("plugin.yml");
      if (pluginYmlEntry) {
        const content = pluginYmlEntry.getData().toString("utf8");
        return this.parseBukkitYml(content);
      }

      // 2. Try Paper paper-plugin.yml
      const paperPluginYmlEntry = zip.getEntry("paper-plugin.yml");
      if (paperPluginYmlEntry) {
        const content = paperPluginYmlEntry.getData().toString("utf8");
        return this.parsePaperYml(content);
      }

      // 3. Try Velocity velocity-plugin.json
      const velocityJsonEntry = zip.getEntry("velocity-plugin.json");
      if (velocityJsonEntry) {
        const content = velocityJsonEntry.getData().toString("utf8");
        return this.parseVelocityJson(content);
      }

      // 4. Try BungeeCord bungee.yml
      const bungeeYmlEntry = zip.getEntry("bungee.yml");
      if (bungeeYmlEntry) {
        const content = bungeeYmlEntry.getData().toString("utf8");
        return this.parseBungeeYml(content);
      }

      // 5. Try Fabric fabric.mod.json
      const fabricJsonEntry = zip.getEntry("fabric.mod.json");
      if (fabricJsonEntry) {
        const content = fabricJsonEntry.getData().toString("utf8");
        return this.parseFabricJson(content);
      }

      // 6. Try Forge mods.toml
      const modsTomlEntry = zip.getEntry("META-INF/mods.toml");
      if (modsTomlEntry) {
        const content = modsTomlEntry.getData().toString("utf8");
        return this.parseForgeToml(content);
      }

      // No metadata entry found
      return {
        name: path.basename(filePath, ".jar"),
        version: "Unknown",
        platform: "unknown",
        dependencies: [],
        mainClass: ""
      };
    } catch (error) {
      console.error(`Failed to parse JAR at ${filePath}:`, error.message);
      return {
        name: path.basename(filePath, ".jar"),
        version: "Unknown",
        platform: "unknown",
        dependencies: [],
        mainClass: "",
        error: error.message
      };
    }
  }

  // Parses basic YAML-like key-value structures
  static parseYamlSimple(content) {
    const obj = {};
    const lines = content.split(/\r?\n/);
    let currentKey = null;

    for (const line of lines) {
      // Ignore comments and empty lines
      if (line.trim().startsWith("#") || line.trim() === "") continue;
      
      // Detect top-level fields
      if (!line.startsWith(" ")) {
        const idx = line.indexOf(":");
        if (idx !== -1) {
          const key = line.substring(0, idx).trim();
          let value = line.substring(idx + 1).trim();
          
          // Strip quotes
          if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
            value = value.substring(1, value.length - 1);
          }

          obj[key] = value;
          currentKey = key;
        }
      }
    }
    return obj;
  }

  static parseBukkitYml(content) {
    const yaml = this.parseYamlSimple(content);
    // Parse list of dependencies
    const dependencies = [];
    
    // Parse 'depend' field
    const dependMatch = content.match(/depend:\s*\[?([^\]\r\n]+)\]?/);
    if (dependMatch) {
      dependMatch[1].split(",").forEach(d => {
        const name = d.trim().replace(/['"]/g, "");
        if (name) dependencies.push({ name, required: true });
      });
    }

    // Parse 'softdepend' field
    const softDependMatch = content.match(/softdepend:\s*\[?([^\]\r\n]+)\]?/);
    if (softDependMatch) {
      softDependMatch[1].split(",").forEach(d => {
        const name = d.trim().replace(/['"]/g, "");
        if (name) dependencies.push({ name, required: false });
      });
    }

    return {
      name: yaml.name || "Unknown",
      version: yaml.version || "1.0.0",
      platform: "bukkit",
      dependencies,
      mainClass: yaml.main || ""
    };
  }

  static parsePaperYml(content) {
    const yaml = this.parseYamlSimple(content);
    const dependencies = [];

    // Parse dependencies blocks if present (regex parser as yaml parser is simple)
    const depRegex = /dependency\s+(\S+)/g;
    let match;
    while ((match = depRegex.exec(content)) !== null) {
      dependencies.push({ name: match[1], required: true });
    }

    return {
      name: yaml.name || "Unknown",
      version: yaml.version || "1.0.0",
      platform: "paper",
      dependencies,
      mainClass: yaml.main || ""
    };
  }

  static parseBungeeYml(content) {
    const yaml = this.parseYamlSimple(content);
    const dependencies = [];

    const dependMatch = content.match(/depends:\s*\[?([^\]\r\n]+)\]?/);
    if (dependMatch) {
      dependMatch[1].split(",").forEach(d => {
        const name = d.trim().replace(/['"]/g, "");
        if (name) dependencies.push({ name, required: true });
      });
    }

    return {
      name: yaml.name || "Unknown",
      version: yaml.version || "1.0.0",
      platform: "bungeecord",
      dependencies,
      mainClass: yaml.main || ""
    };
  }

  static parseVelocityJson(content) {
    try {
      const data = JSON.parse(content);
      const dependencies = (data.dependencies || []).map(dep => ({
        name: dep.id,
        required: !dep.optional
      }));

      return {
        name: data.name || data.id || "Unknown",
        version: data.version || "1.0.0",
        platform: "velocity",
        dependencies,
        mainClass: data.main || ""
      };
    } catch (e) {
      return { name: "Unknown", version: "1.0.0", platform: "velocity", dependencies: [], mainClass: "" };
    }
  }

  static parseFabricJson(content) {
    try {
      const data = JSON.parse(content);
      const dependencies = [];
      
      if (data.depends) {
        Object.entries(data.depends).forEach(([depName, verRange]) => {
          // Filter out minecraft runtime dependencies
          if (depName !== "minecraft" && depName !== "fabricloader") {
            dependencies.push({ name: depName, required: true });
          }
        });
      }

      return {
        name: data.name || data.id || "Unknown",
        version: data.version || "1.0.0",
        platform: "fabric",
        dependencies,
        mainClass: ""
      };
    } catch (e) {
      return { name: "Unknown", version: "1.0.0", platform: "fabric", dependencies: [], mainClass: "" };
    }
  }

  static parseForgeToml(content) {
    // Parse simple toml mods section using regex
    const modIdMatch = content.match(/modId\s*=\s*['"]([^'"]+)['"]/);
    const modNameMatch = content.match(/displayName\s*=\s*['"]([^'"]+)['"]/);
    const versionMatch = content.match(/version\s*=\s*['"]([^'"]+)['"]/);

    return {
      name: modNameMatch ? modNameMatch[1] : (modIdMatch ? modIdMatch[1] : "Unknown Forge Mod"),
      version: versionMatch ? versionMatch[1] : "1.0.0",
      platform: "forge",
      dependencies: [], // Forge mods dependencies are complex to parse via simple regex, but can be added
      mainClass: ""
    };
  }
}

module.exports = PluginParser;
