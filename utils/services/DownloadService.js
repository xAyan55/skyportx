/**
 * DownloadService
 * Streams a plugin JAR from a remote URL to a temporary file on the panel server.
 * Uses streaming to avoid buffering large files in RAM.
 *
 * Security:
 *   - HTTPS-only
 *   - Allowlisted domains
 *   - Maximum file size (100 MB)
 *   - Download timeout (30 s)
 *   - Temp file isolated in os.tmpdir() with random subdirectory
 */

const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");
const log    = new (require("cat-loggr"))();

const ALLOWED_HOSTS = [
  "cdn.modrinth.com",
  "api.modrinth.com",
  "hangar.papermc.io",
  "api.spiget.org",
  "cdn.spiget.org",
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_TIMEOUT  = 30_000;             // 30 seconds

class DownloadService {
  /**
   * Stream a remote JAR to a temp file on the panel server.
   *
   * @param {string} url       Download URL (must be HTTPS).
   * @param {string} filename  Intended filename (used to name the temp file).
   * @returns {Promise<{tempPath: string, cleanUp: Function}>}
   *   tempPath  – absolute path to the downloaded temp file
   *   cleanUp   – call this to delete the temp file once done
   */
  static async download(url, filename) {
    // Security: HTTPS only
    if (!url.startsWith("https://")) {
      throw new Error(`Insecure download URL rejected (HTTPS required): ${url}`);
    }

    // Security: allowlisted domains
    const hostname = new URL(url).hostname;
    if (!ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith(`.${h}`))) {
      throw new Error(`Download host '${hostname}' is not in the allowlist`);
    }

    // Create isolated temp directory
    const tmpDir  = path.join(os.tmpdir(), `skyport-plugin-${crypto.randomBytes(8).toString("hex")}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    // Sanitize filename – strip path traversal characters
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const tempPath = path.join(tmpDir, safeFilename);

    const cleanUp = async () => {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`Failed to clean up temp directory ${tmpDir}: ${err.message}`);
      }
    };

    try {
      const response = await axios({
        method:  "GET",
        url:     url,
        responseType: "stream",
        timeout: DOWNLOAD_TIMEOUT,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        maxRedirects: 5,
      });

      let downloaded = 0;
      const writer = fs.createWriteStream(tempPath);

      await new Promise((resolve, reject) => {
        response.data.on("data", chunk => {
          downloaded += chunk.length;
          if (downloaded > MAX_DOWNLOAD_SIZE) {
            response.data.destroy();
            writer.destroy();
            reject(new Error(`File exceeds maximum allowed size of ${MAX_DOWNLOAD_SIZE / (1024 * 1024)} MB`));
          }
        });

        response.data.pipe(writer);
        response.data.on("error", reject);
        writer.on("finish", resolve);
        writer.on("error",  reject);
      });

      return { tempPath, cleanUp };
    } catch (err) {
      await cleanUp();
      throw err;
    }
  }
}

module.exports = DownloadService;
