/**
 * InstallationService (Orchestrator)
 * Coordinates the full installation workflow for a single plugin:
 *   1. Download (via DownloadService)
 *   2. Validate  (via JarValidationService)
 *   3. Upload    (via UploadService)
 *   4. Rollback  (via RollbackService) on any failure
 *
 * Also provides listInstalled() which scans the server /plugins/ directory
 * and parses each JAR using PluginParser — this is the ONLY mechanism for
 * determining what is installed. The parsed results are cached in-memory
 * with a 60-second TTL and invalidated immediately after any install/delete.
 *
 * detectServer() resolves server software and Minecraft version using the
 * following priority order (lazily, results cached 24 hours):
 *   1. Existing instance metadata (instance.imageData)
 *   2. Environment variables in instance.Env
 *   3. Startup command text
 *   4. Cached previous detection
 *   5. Filesystem file presence (e.g. purpur.yml, paper-global.yml)
 *   6. Log inspection (logs/latest.log) — last resort only
 */

const DownloadService     = require("./DownloadService");
const JarValidationService = require("./JarValidationService");
const UploadService       = require("./UploadService");
const RollbackService     = require("./RollbackService");
const PluginParser        = require("./PluginParser");
const axios               = require("axios");
const path                = require("path");
const os                  = require("os");
const fs                  = require("fs");
const crypto              = require("crypto");
const cache               = require("../cache");
const log                 = new (require("cat-loggr"))();

// In-memory cache for installed plugin lists
const INSTALLED_CACHE_TTL = 60 * 1000;       // 60 seconds
const DETECT_CACHE_TTL    = 24 * 60 * 60 * 1000; // 24 hours

class InstallationService {
  // ─── Server Detection ────────────────────────────────────────────────────────

  /**
   * Detect Minecraft server software and version for an instance.
   * Results are cached per instance for 24 hours.
   *
   * @param {Object} instance  Full instance DB object.
   * @returns {Promise<{ software: string, minecraftVersion: string }>}
   */
  static async detectServer(instance) {
    const cacheKey = `detect:${instance.Id}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let software = null;
    let minecraftVersion = null;

    // ── Priority 1: Existing imageData metadata ──────────────────────────────
    const imageName = (instance.Image || instance.imageData?.Name || "").toLowerCase();
    const softwareNames = [
      "paper","purpur","spigot","bukkit","folia",
      "velocity","waterfall","bungeecord","fabric","forge","neoforge",
    ];
    for (const s of softwareNames) {
      if (imageName.includes(s)) { software = s; break; }
    }

    // ── Priority 2: Environment variables ───────────────────────────────────
    if (!minecraftVersion && instance.Env) {
      const versionEnv = instance.Env.MINECRAFT_VERSION
        || instance.Env.MC_VERSION
        || instance.Env.VERSION;
      if (versionEnv && /^\d+\.\d+/.test(versionEnv)) {
        minecraftVersion = versionEnv;
      }
    }

    // ── Priority 3: Startup command text ────────────────────────────────────
    if ((!software || !minecraftVersion) && instance.imageData?.StartCommand) {
      const cmd = instance.imageData.StartCommand.toLowerCase();
      if (!software) {
        for (const s of softwareNames) {
          if (cmd.includes(s)) { software = s; break; }
        }
      }
      if (!minecraftVersion) {
        const vMatch = cmd.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (vMatch) minecraftVersion = vMatch[1];
      }
    }

    // ── Priority 4: Filesystem file presence ────────────────────────────────
    if (!software && instance.Node && instance.VolumeId) {
      const indicators = {
        "purpur.yml":          "purpur",
        "paper-global.yml":    "paper",
        "paper.yml":           "paper",
        "spigot.yml":          "spigot",
        "bukkit.yml":          "bukkit",
        "config/velocity.toml":"velocity",
        "waterfall.yml":       "waterfall",
        "bungee.yml":          "bungeecord",
        "config/fabric":       "fabric",
        "libraries/net/minecraftforge": "forge",
      };

      try {
        const filesResponse = await axios.get(
          `http://${instance.Node.address}:${instance.Node.port}/fs/${instance.VolumeId}/files`,
          { auth: { username: "Skyport", password: instance.Node.apiKey }, timeout: 5000 }
        );
        const files = (filesResponse.data?.files || []).map(f => f.name.toLowerCase());

        for (const [indicator, detected] of Object.entries(indicators)) {
          if (files.includes(indicator.toLowerCase())) {
            software = detected;
            break;
          }
        }
      } catch (err) {
        log.warn(`InstallationService.detectServer: filesystem scan failed for ${instance.Id}: ${err.message}`);
      }
    }

    // ── Priority 5: Log inspection (last resort) ─────────────────────────────
    if ((!software || !minecraftVersion) && instance.Node && instance.VolumeId) {
      try {
        const logContent = await axios.get(
          `http://${instance.Node.address}:${instance.Node.port}/fs/${instance.VolumeId}/files/view/latest.log?path=logs`,
          { auth: { username: "Skyport", password: instance.Node.apiKey }, timeout: 5000 }
        );
        const text = logContent.data?.content || "";
        if (!software) {
          for (const s of softwareNames) {
            if (text.toLowerCase().includes(s)) { software = s; break; }
          }
        }
        if (!minecraftVersion) {
          const vMatch = text.match(/\bMinecraft (\d+\.\d+(?:\.\d+)?)\b/i);
          if (vMatch) minecraftVersion = vMatch[1];
        }
      } catch {
        // Silently ignore – log may not exist yet
      }
    }

    const result = {
      software: software || "bukkit",
      minecraftVersion: minecraftVersion || null,
    };

    cache.set(cacheKey, result, DETECT_CACHE_TTL);
    return result;
  }

  // ─── Installed Plugin Listing ─────────────────────────────────────────────

  /**
   * Scan the /plugins/ directory on the node and parse each JAR's metadata.
   * Results are cached in-memory for 60 seconds.
   * The filesystem is the ONLY source of truth; no DB registry is used.
   *
   * @param {Object} instance  Full instance DB object.
   * @returns {Promise<Array>} Array of parsed plugin metadata objects.
   */
  static async listInstalled(instance) {
    const cacheKey = `installed:${instance.Id}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { Node, VolumeId } = instance;
    if (!Node || !VolumeId) return [];

    let files = [];
    try {
      const response = await axios.get(
        `http://${Node.address}:${Node.port}/fs/${VolumeId}/files?path=plugins`,
        { auth: { username: "Skyport", password: Node.apiKey }, timeout: 10000 }
      );
      files = (response.data?.files || []).filter(f =>
        !f.isDirectory && f.name.toLowerCase().endsWith(".jar")
      );
    } catch (err) {
      log.warn(`InstallationService.listInstalled: could not list /plugins/ for ${instance.Id}: ${err.message}`);
      return [];
    }

    // Download each JAR to a temp location, parse metadata, then clean up
    const plugins = [];

    await Promise.allSettled(
      files.map(async file => {
        const tmpDir  = path.join(os.tmpdir(), `sp-parse-${crypto.randomBytes(6).toString("hex")}`);
        const tmpFile = path.join(tmpDir, file.name);

        try {
          await fs.promises.mkdir(tmpDir, { recursive: true });

          const jarResponse = await axios.get(
            `http://${Node.address}:${Node.port}/fs/${VolumeId}/files/view/${file.name}?path=plugins`,
            {
              auth: { username: "Skyport", password: Node.apiKey },
              responseType: "arraybuffer",
              timeout: 15000,
            }
          );

          await fs.promises.writeFile(tmpFile, Buffer.from(jarResponse.data));
          const meta = PluginParser.parse(tmpFile);
          plugins.push({ ...meta, filename: file.name, fileSize: file.size });
        } catch (err) {
          // Best-effort: still include the file with minimal metadata
          plugins.push({
            name: path.basename(file.name, ".jar"),
            version: "Unknown",
            platform: "unknown",
            dependencies: [],
            filename: file.name,
            fileSize: file.size,
            parseError: err.message,
          });
        } finally {
          fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      })
    );

    cache.set(cacheKey, plugins, INSTALLED_CACHE_TTL);
    return plugins;
  }

  /**
   * Invalidate the installed-plugins cache for an instance.
   * Must be called after any install, update, or uninstall.
   * @param {string} instanceId
   */
  static invalidateInstalledCache(instanceId) {
    cache.delete(`installed:${instanceId}`);
    cache.delete(`updates:${instanceId}`);
  }

  // ─── Install Orchestration ────────────────────────────────────────────────

  /**
   * Orchestrate a full plugin installation.
   *
   * @param {Object}   instance     Full instance DB object.
   * @param {string}   downloadUrl  HTTPS URL to the JAR.
   * @param {string}   filename     Intended JAR filename.
   * @param {string}   checksum     Optional SHA-256 or SHA-1 checksum.
   * @param {Function} onProgress   Callback(status: string, detail?: string) for WS broadcast.
   * @returns {Promise<void>}
   */
  static async install(instance, downloadUrl, filename, checksum, onProgress = () => {}) {
    let tempPath  = null;
    let cleanUp   = async () => {};
    let uploaded  = false;

    try {
      // ── Step 1: Download ──────────────────────────────────────────────────
      onProgress("downloading", `Downloading ${filename}...`);
      const dl = await DownloadService.download(downloadUrl, filename);
      tempPath = dl.tempPath;
      cleanUp  = dl.cleanUp;

      // ── Step 2: Validate ──────────────────────────────────────────────────
      onProgress("validating", `Validating ${filename}...`);
      const validation = await JarValidationService.validate(tempPath, {
        expectedChecksum: checksum || undefined,
      });

      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.error}`);
      }

      // ── Step 3: Upload ────────────────────────────────────────────────────
      onProgress("installing", `Uploading ${filename} to server...`);
      await UploadService.upload(instance, tempPath, filename);
      uploaded = true;

      // ── Step 4: Invalidate cache ──────────────────────────────────────────
      this.invalidateInstalledCache(instance.Id);
      onProgress("completed", `${filename} installed successfully.`);
    } catch (err) {
      // ── Rollback ──────────────────────────────────────────────────────────
      onProgress("failed", `Installation failed: ${err.message}. Rolling back...`);
      if (uploaded) {
        await RollbackService.deleteUploaded(instance, filename);
      }
      this.invalidateInstalledCache(instance.Id);
      throw err;
    } finally {
      await cleanUp();
    }
  }

  // ─── Uninstall ────────────────────────────────────────────────────────────

  /**
   * Delete a plugin JAR from the server's /plugins/ directory.
   *
   * @param {Object} instance     Full instance DB object.
   * @param {string} jarFilename  Filename of the JAR to remove.
   * @param {Function} onProgress Broadcast callback.
   */
  static async uninstall(instance, jarFilename, onProgress = () => {}) {
    onProgress("uninstalling", `Removing ${jarFilename}...`);
    await RollbackService.deleteUploaded(instance, jarFilename);
    this.invalidateInstalledCache(instance.Id);
    onProgress("completed", `${jarFilename} removed.`);
  }
}

module.exports = InstallationService;
