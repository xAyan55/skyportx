/**
 * UploadService
 * Uploads a local JAR file to the node daemon's filesystem via the panel's
 * existing daemon API (same auth pattern used by UploadFile.js).
 *
 * Reuses the existing multipart upload endpoint on the node daemon:
 *   POST http://<node>:<port>/fs/<volumeId>/files/upload?path=plugins
 */

const axios    = require("axios");
const fs       = require("fs");
const FormData = require("form-data");
const path     = require("path");
const log      = new (require("cat-loggr"))();

class UploadService {
  /**
   * Upload a local file to the server's /plugins/ directory via the node daemon.
   *
   * @param {Object} instance  The full instance object from the DB.
   * @param {string} filePath  Absolute local path of the validated JAR.
   * @param {string} filename  Target filename on the server.
   * @returns {Promise<void>}
   */
  static async upload(instance, filePath, filename) {
    const { Node, VolumeId } = instance;
    if (!Node || !VolumeId) {
      throw new Error("Instance is missing Node or VolumeId");
    }

    // Sanitize filename to prevent path traversal
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const uploadUrl = `http://${Node.address}:${Node.port}/fs/${VolumeId}/files/upload?path=plugins`;

    const formData = new FormData();
    formData.append("files", fs.createReadStream(filePath), { filename: safeFilename });

    try {
      await axios.post(uploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Basic ${Buffer.from("Skyport:" + Node.apiKey).toString("base64")}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      log.info(`UploadService: uploaded '${safeFilename}' to instance ${instance.Id} /plugins/`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      throw new Error(`Failed to upload '${safeFilename}' to node daemon: ${msg}`);
    }
  }
}

module.exports = UploadService;
