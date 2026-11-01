import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAllFiles, getDaysOld } from './scanner.js';

export class Cleanup extends EventEmitter {
  /**
   * Finds files older than `olderThan` days.
   * Without `confirm` it runs in dry run mode and deletes nothing.
   */
  async run(directory, { olderThan, confirm = false }) {
    const root = path.resolve(directory);
    this.emit('cleanup-start', { directory: root, olderThan, dryRun: !confirm });

    const files = await getAllFiles(root, (filePath, error) => {
      this.emit('file-error', { path: filePath, error });
    });

    const oldFiles = [];
    for (const filePath of files) {
      try {
        const stats = await fs.stat(filePath);
        const daysOld = getDaysOld(stats.mtime);

        if (daysOld > olderThan) {
          const fileData = {
            path: filePath,
            name: path.basename(filePath),
            size: stats.size,
            mtime: stats.mtime,
            daysOld,
          };
          oldFiles.push(fileData);
          this.emit('file-found', fileData);
        }
      } catch (error) {
        this.emit('file-error', { path: filePath, error });
      }
    }

    oldFiles.sort((a, b) => b.daysOld - a.daysOld);
    const totalSize = oldFiles.reduce((sum, file) => sum + file.size, 0);
    this.emit('search-complete', { files: oldFiles, totalSize });

    const result = {
      dryRun: !confirm,
      found: oldFiles.length,
      totalSize,
      deleted: 0,
      freed: 0,
      failed: 0,
    };

    if (confirm && oldFiles.length > 0) {
      this.emit('delete-start', { total: oldFiles.length, totalSize });

      let processed = 0;
      for (const file of oldFiles) {
        processed++;
        try {
          await fs.unlink(file.path);
          result.deleted++;
          result.freed += file.size;
          this.emit('file-deleted', { ...file, processed, total: oldFiles.length });
        } catch (error) {
          result.failed++;
          this.emit('file-error', { path: file.path, error, processed, total: oldFiles.length });
        }
      }
    }

    this.emit('cleanup-complete', result);
    return result;
  }
}
