import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Recursively collects the paths of all files in a directory.
 * An error reading the root directory is thrown to the caller,
 * while unreadable subdirectories are passed to onError and skipped.
 */
export async function getAllFiles(dirPath, onError, fileList = []) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      try {
        await getAllFiles(fullPath, onError, fileList);
      } catch (error) {
        if (!onError) throw error;
        onError(fullPath, error);
      }
    } else if (entry.isFile()) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

/** File age in days, based on the last modification time. */
export function getDaysOld(mtime) {
  return (Date.now() - mtime.getTime()) / DAY_MS;
}

/** Builds the scan report from the list of collected files (pure function, no I/O). */
export function calculateStatistics(files) {
  const byType = new Map(); // Map<extension, { count, totalSize }>
  const byAge = { last7Days: 0, last30Days: 0, olderThan90Days: 0 };
  let totalSize = 0;

  for (const file of files) {
    totalSize += file.size;

    const typeStats = byType.get(file.extension) ?? { count: 0, totalSize: 0 };
    typeStats.count++;
    typeStats.totalSize += file.size;
    byType.set(file.extension, typeStats);

    if (file.daysOld <= 7) byAge.last7Days++;
    if (file.daysOld <= 30) byAge.last30Days++;
    if (file.daysOld > 90) byAge.olderThan90Days++;
  }

  return {
    totalFiles: files.length,
    totalSize,
    byType: [...byType.entries()]
      .map(([extension, data]) => ({ extension, ...data }))
      .sort((a, b) => b.totalSize - a.totalSize),
    byAge,
    largestFiles: [...files].sort((a, b) => b.size - a.size).slice(0, 3),
    oldestFile: files.reduce(
      (oldest, file) => (!oldest || file.mtime < oldest.mtime ? file : oldest),
      null,
    ),
  };
}

export class Scanner extends EventEmitter {
  async scan(directory) {
    const root = path.resolve(directory);
    this.emit('scan-start', { directory: root });

    const files = await getAllFiles(root, (filePath, error) => {
      this.emit('file-error', { path: filePath, error });
    });
    const total = files.length;
    this.emit('files-listed', { total });

    const allFiles = [];
    let processed = 0;

    for (const filePath of files) {
      processed++;

      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch (error) {
        this.emit('file-error', { path: filePath, error, processed, total });
        continue;
      }

      const fileData = {
        path: filePath,
        name: path.basename(filePath),
        extension: path.extname(filePath).toLowerCase() || '(no ext)',
        size: stats.size,
        mtime: stats.mtime,
        daysOld: getDaysOld(stats.mtime),
      };

      allFiles.push(fileData);
      this.emit('file-found', { ...fileData, processed, total });
    }

    const statistics = { directory: root, ...calculateStatistics(allFiles) };

    this.emit('scan-complete', statistics);
    return statistics;
  }
}
