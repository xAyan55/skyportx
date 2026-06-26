/**
 * routes/Instance/Plugins.js
 *
 * Thin Express router for the Minecraft Plugin Manager.
 * Follows the same pattern as all other instance routes in Skyport:
 *   - Load instance from DB
 *   - Check isUserAuthorizedForContainer
 *   - Check isInstanceSuspended
 *   - Delegate heavy work to services, never in the controller
 *
 * REST Endpoints:
 *   GET  /instance/:id/plugins                          – render Plugin Manager page
 *   GET  /instance/:id/plugins/api/installed            – list installed plugins (filesystem)
 *   GET  /instance/:id/plugins/api/search               – search across providers
 *   GET  /instance/:id/plugins/api/details/:provider/:pluginId – plugin detail
 *   GET  /instance/:id/plugins/api/updates              – check for available updates
 *   POST /instance/:id/plugins/api/install              – enqueue installation task
 *   POST /instance/:id/plugins/api/uninstall            – delete plugin JAR
 *   POST /instance/:id/plugins/api/update               – enqueue update task
 *   POST /instance/:id/plugins/api/bulk-install         – bulk install
 *   POST /instance/:id/plugins/api/bulk-update          – bulk update
 *   POST /instance/:id/plugins/api/ignore               – ignore a version
 *   ws   /instance/:id/plugins/ws                       – task progress events
 *
 * WebSocket: Uses the existing express-ws infrastructure. Broadcasts JSON
 *   events: { event: "progress", taskId, status, detail }
 */

const express              = require("express");
const router               = express.Router();
const { db }               = require("../../handlers/db.js");
const { isUserAuthorizedForContainer, isInstanceSuspended } = require("../../utils/authHelper");
const { loadPlugins }      = require("../../plugins/loadPls.js");
const path                 = require("path");
const log                  = new (require("cat-loggr"))();

// Services
const InstallationService  = require("../../utils/services/InstallationService");
const SearchService        = require("../../utils/services/SearchService");
const UpdateService        = require("../../utils/services/UpdateService");

// Task queue (interface only – backed by MemoryQueue singleton)
const { queue }            = require("../../utils/backgroundTaskQueue");

// Providers (for getDetails / getVersions)
const ModrinthProvider     = require("../../utils/providers/Modrinth");
const HangarProvider       = require("../../utils/providers/Hangar");
const SpigetProvider       = require("../../utils/providers/Spiget");
const GithubProvider       = require("../../utils/providers/Github");

const PROVIDERS = {
  modrinth: new ModrinthProvider(),
  hangar:   new HangarProvider(),
  spiget:   new SpigetProvider(),
  github:   new GithubProvider(),
};

const panelPlugins = loadPlugins(path.join(__dirname, "../../plugins"));

// Active WebSocket clients per instance: Map<instanceId, Set<ws>>
const pluginWsClients = new Map();

// Helper: broadcast a progress event to all WS clients for an instance
function broadcast(instanceId, payload) {
  const clients = pluginWsClients.get(instanceId);
  if (!clients || clients.size === 0) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    try { if (ws.readyState === 1) ws.send(msg); } catch {}
  });
}

// Shared auth middleware for all /instance/:id/plugins/* routes
async function requirePluginAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });

  const { id } = req.params;
  const instance = await db.get(id + "_instance").catch(() => null);
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
  if (!isAuthorized) return res.status(403).json({ error: "Unauthorized" });

  const suspended = await isInstanceSuspended(req.user.userId, instance, id);
  if (suspended) return res.render("instance/suspended", { req, user: req.user });

  req.instance = instance;
  next();
}

// ─── Page ─────────────────────────────────────────────────────────────────────
router.get("/instance/:id/plugins", requirePluginAccess, async (req, res) => {
  try {
    const allPluginData = Object.values(panelPlugins).map(p => p.config);
    const serverInfo = await InstallationService.detectServer(req.instance);

    res.render("instance/plugins", {
      req,
      user:      req.user,
      instance:  req.instance,
      serverInfo,
      addons:    { plugins: allPluginData },
    });
  } catch (err) {
    log.error("Plugins page error:", err);
    res.status(500).send("Failed to load Plugin Manager");
  }
});

// ─── Installed Plugins ─────────────────────────────────────────────────────────
router.get("/instance/:id/plugins/api/installed", requirePluginAccess, async (req, res) => {
  try {
    const installed = await InstallationService.listInstalled(req.instance);
    res.json({ plugins: installed });
  } catch (err) {
    log.error("Plugins installed list error:", err);
    res.status(500).json({ error: "Failed to list installed plugins" });
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────
router.get("/instance/:id/plugins/api/search", requirePluginAccess, async (req, res) => {
  const { q, software, version, category } = req.query;
  if (!q) return res.status(400).json({ error: "Query parameter 'q' is required" });

  try {
    const results = await SearchService.search(q, { software, minecraftVersion: version, category });
    res.json({ results });
  } catch (err) {
    log.error("Plugins search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ─── Plugin Details ───────────────────────────────────────────────────────────
router.get("/instance/:id/plugins/api/details/:provider/:pluginId(*)", requirePluginAccess, async (req, res) => {
  const { provider, pluginId } = req.params;
  const providerInstance = PROVIDERS[provider.toLowerCase()];
  if (!providerInstance) {
    return res.status(400).json({ error: `Unknown provider '${provider}'` });
  }

  try {
    const details  = await providerInstance.getDetails(pluginId);
    const versions = await providerInstance.getVersions(pluginId);
    res.json({ details, versions });
  } catch (err) {
    log.error("Plugins details error:", err);
    res.status(500).json({ error: "Failed to fetch plugin details" });
  }
});

// ─── Update Checks ─────────────────────────────────────────────────────────────
router.get("/instance/:id/plugins/api/updates", requirePluginAccess, async (req, res) => {
  try {
    const installed   = await InstallationService.listInstalled(req.instance);
    const serverInfo  = await InstallationService.detectServer(req.instance);
    // Use Modrinth as primary provider for update checks (most comprehensive)
    const updates = await UpdateService.checkAll(
      req.params.id,
      installed,
      PROVIDERS.modrinth,
      serverInfo.software,
      serverInfo.minecraftVersion,
      db
    );
    res.json({ updates });
  } catch (err) {
    log.error("Plugins update check error:", err);
    res.status(500).json({ error: "Failed to check for updates" });
  }
});

// ─── Install ──────────────────────────────────────────────────────────────────
router.post("/instance/:id/plugins/api/install", requirePluginAccess, async (req, res) => {
  const { url, filename, checksum } = req.body;
  if (!url || !filename) {
    return res.status(400).json({ error: "url and filename are required" });
  }

  const instanceId = req.params.id;
  const instance   = req.instance;

  const taskId = await queue.enqueue(
    instanceId,
    async (onProgress) => {
      await InstallationService.install(instance, url, filename, checksum, (status, detail) => {
        broadcast(instanceId, { event: "progress", taskId, status, detail });
        onProgress(status, detail);
      });
    }
  );

  res.status(202).json({ taskId, message: "Installation queued" });
});

// ─── Uninstall ────────────────────────────────────────────────────────────────
router.post("/instance/:id/plugins/api/uninstall", requirePluginAccess, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "filename is required" });

  const instanceId = req.params.id;
  const instance   = req.instance;

  const taskId = await queue.enqueue(
    instanceId,
    async (onProgress) => {
      await InstallationService.uninstall(instance, filename, (status, detail) => {
        broadcast(instanceId, { event: "progress", taskId, status, detail });
        onProgress(status, detail);
      });
    }
  );

  res.status(202).json({ taskId, message: "Uninstall queued" });
});

// ─── Update ───────────────────────────────────────────────────────────────────
router.post("/instance/:id/plugins/api/update", requirePluginAccess, async (req, res) => {
  const { url, filename, checksum, oldFilename } = req.body;
  if (!url || !filename) {
    return res.status(400).json({ error: "url and filename are required" });
  }

  const instanceId = req.params.id;
  const instance   = req.instance;

  const taskId = await queue.enqueue(
    instanceId,
    async (onProgress) => {
      // For updates, optionally remove the old JAR first (if same filename this is redundant)
      if (oldFilename && oldFilename !== filename) {
        try {
          await InstallationService.uninstall(instance, oldFilename, () => {});
        } catch {}
      }
      await InstallationService.install(instance, url, filename, checksum, (status, detail) => {
        broadcast(instanceId, { event: "progress", taskId, status, detail });
        onProgress(status, detail);
      });
    }
  );

  res.status(202).json({ taskId, message: "Update queued" });
});

// ─── Bulk Install ─────────────────────────────────────────────────────────────
router.post("/instance/:id/plugins/api/bulk-install", requirePluginAccess, async (req, res) => {
  const { items } = req.body; // [{ url, filename, checksum }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array is required" });
  }

  const instanceId = req.params.id;
  const instance   = req.instance;
  const taskIds    = [];

  for (const item of items) {
    if (!item.url || !item.filename) continue;
    const taskId = await queue.enqueue(
      instanceId,
      async (onProgress) => {
        await InstallationService.install(instance, item.url, item.filename, item.checksum, (status, detail) => {
          broadcast(instanceId, { event: "progress", taskId, status, detail });
          onProgress(status, detail);
        });
      }
    );
    taskIds.push(taskId);
  }

  res.status(202).json({ taskIds, message: `${taskIds.length} installations queued` });
});

// ─── Bulk Update ──────────────────────────────────────────────────────────────
router.post("/instance/:id/plugins/api/bulk-update", requirePluginAccess, async (req, res) => {
  const { items } = req.body; // [{ url, filename, checksum, oldFilename }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array is required" });
  }

  const instanceId = req.params.id;
  const instance   = req.instance;
  const taskIds    = [];

  for (const item of items) {
    if (!item.url || !item.filename) continue;
    const taskId = await queue.enqueue(
      instanceId,
      async (onProgress) => {
        if (item.oldFilename && item.oldFilename !== item.filename) {
          try { await InstallationService.uninstall(instance, item.oldFilename, () => {}); } catch {}
        }
        await InstallationService.install(instance, item.url, item.filename, item.checksum, (status, detail) => {
          broadcast(instanceId, { event: "progress", taskId, status, detail });
          onProgress(status, detail);
        });
      }
    );
    taskIds.push(taskId);
  }

  res.status(202).json({ taskIds, message: `${taskIds.length} updates queued` });
});

// ─── Ignore Version ───────────────────────────────────────────────────────────
router.post("/instance/:id/plugins/api/ignore", requirePluginAccess, async (req, res) => {
  const { pluginName, versionNumber } = req.body;
  if (!pluginName || !versionNumber) {
    return res.status(400).json({ error: "pluginName and versionNumber are required" });
  }

  try {
    await UpdateService.ignoreVersion(req.params.id, pluginName, versionNumber, db);
    res.json({ success: true });
  } catch (err) {
    log.error("Plugins ignore version error:", err);
    res.status(500).json({ error: "Failed to ignore version" });
  }
});

// ─── WebSocket Progress ───────────────────────────────────────────────────────
router.ws("/instance/:id/plugins/ws", async (ws, req) => {
  if (!req.user) return ws.close(1008, "Authorization required");

  const { id } = req.params;
  const instance = await db.get(id + "_instance").catch(() => null);
  if (!instance) return ws.close(1008, "Instance not found");

  const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
  if (!isAuthorized) return ws.close(1008, "Unauthorized");

  // Register this client
  if (!pluginWsClients.has(id)) pluginWsClients.set(id, new Set());
  pluginWsClients.get(id).add(ws);

  ws.on("close", () => {
    const clients = pluginWsClients.get(id);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) pluginWsClients.delete(id);
    }
  });
});

module.exports = router;
