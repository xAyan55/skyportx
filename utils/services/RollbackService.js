/**
 * RollbackService
 * Restores the server filesystem to its previous state after a failed installation.
 *
 * Rollback scenarios covered:
 *   1. Failed download      – temp file cleaned up by DownloadService; nothing to do on node.
 *   2. Failed validation    – same as above.
 *   3. Failed upload        – no JAR reached the node; nothing to do.
 *   4. Failed install after upload – delete the partially uploaded JAR from the node.
 *   5. Failed update        – restore the backed-up old JAR and delete the new one.
 */

const axios = require("axios");
const log   = new (require("cat-loggr"))();

class RollbackService {
  /**
   * Delete a JAR that was fully or partially uploaded to the node.
   * Called when installation fails after the upload step.
   *
   * @param {Object} instance       Full instance DB object.
   * @param {string} jarFilename    Filename of the JAR to remove from /plugins/.
   */
  static async deleteUploaded(instance, jarFilename) {
    if (!jarFilename || !instance?.Node) return;

    const { Node, VolumeId } = instance;
    const safeFilename = jarFilename.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const url = `http://${Node.address}:${Node.port}/fs/${VolumeId}/files/delete/${safeFilename}?path=plugins`;

    try {
      await axios({
        method: "delete",
        url,
        auth: { username: "Skyport", password: Node.apiKey },
      });
      log.info(`RollbackService: removed '${safeFilename}' from instance ${instance.Id}`);
    } catch (err) {
      // Non-fatal — file may not have been written at all
      log.warn(`RollbackService: could not remove '${safeFilename}' during rollback: ${err.message}`);
    }
  }

  /**
   * Restore an old JAR during a failed update.
   * The caller is responsible for holding the backup path from the download step.
   *
   * @param {Object} instance        Full instance DB object.
   * @param {string} backupFilename  Old JAR filename to restore from the backup upload.
   * @param {string} newFilename     New JAR filename to remove (the failed update).
   * @param {Function} uploadFn      UploadService.upload reference to re-upload the backup.
   * @param {string} backupTempPath  Local temp path of the backed-up old JAR.
   */
  static async restoreFromUpdate(instance, backupFilename, newFilename, uploadFn, backupTempPath) {
    log.info(`RollbackService: restoring '${backupFilename}' after failed update on instance ${instance.Id}`);

    // 1. Remove the failed new JAR
    await this.deleteUploaded(instance, newFilename).catch(() => {});

    // 2. Re-upload the backup JAR if available
    if (backupTempPath && uploadFn) {
      try {
        await uploadFn(instance, backupTempPath, backupFilename);
        log.info(`RollbackService: successfully restored '${backupFilename}'`);
      } catch (err) {
        log.error(`RollbackService: failed to restore backup JAR '${backupFilename}': ${err.message}`);
      }
    }
  }
}

module.exports = RollbackService;
