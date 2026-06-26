const fs = require("fs");
const crypto = require("crypto");
let AdmZip;
try {
  AdmZip = require("adm-zip");
} catch (e) {}

class JarValidationService {
  /**
   * Validate the downloaded JAR file locally.
   * @param {string} filePath Absolute path to the downloaded file.
   * @param {Object} options Validation configurations (maxSize, expectedChecksum, expectedMimeTypes).
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  static async validate(filePath, options = {}) {
    try {
      const stats = await fs.promises.stat(filePath);

      // 1. Max Size Check
      const maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default
      if (stats.size > maxSize) {
        return { valid: false, error: `File size (${(stats.size / (1024 * 1024)).toFixed(2)}MB) exceeds limit of ${(maxSize / (1024 * 1024)).toFixed(2)}MB` };
      }

      // Read first 4 bytes to check ZIP signature
      const handle = await fs.promises.open(filePath, "r");
      const buffer = Buffer.alloc(4);
      await handle.read(buffer, 0, 4, 0);
      await handle.close();

      // ZIP magic bytes: 0x50, 0x4B, 0x03, 0x04 ("PK\x03\x04")
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
        return { valid: false, error: "Invalid file format: Missing ZIP/JAR signature header (PK\\x03\\x04)" };
      }

      // 2. Checksum Verification (SHA-256 or SHA-1)
      if (options.expectedChecksum) {
        const fileHash = await this.calculateHash(filePath, options.expectedChecksum.length === 40 ? "sha1" : "sha256");
        if (fileHash !== options.expectedChecksum.toLowerCase()) {
          return { valid: false, error: `Checksum mismatch. Expected: ${options.expectedChecksum}, Calculated: ${fileHash}` };
        }
      }

      // 3. Zip Entry Path Traversal Checks
      if (!AdmZip) {
        AdmZip = require("adm-zip");
      }
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (entry.entryName.includes("../") || entry.entryName.includes("..\\")) {
          return { valid: false, error: `Security warning: File contains path traversal entry '${entry.entryName}'` };
        }
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: `Validation execution failed: ${error.message}` };
    }
  }

  static calculateHash(filePath, algorithm = "sha256") {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm);
      const stream = fs.createReadStream(filePath);
      stream.on("data", data => hash.update(data));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", err => reject(err));
    });
  }
}

module.exports = JarValidationService;
