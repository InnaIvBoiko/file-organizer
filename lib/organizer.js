import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getAllFiles } from './scanner.js';

export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

export const categories = {
  Documents: ['.pdf', '.docx', '.doc', '.txt', '.md', '.xlsx', '.pptx'],
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'],
  Archives: ['.zip', '.rar', '.tar', '.gz', '.7z'],
  Code: ['.js', '.py', '.java', '.cpp', '.html', '.css', '.json'],
  Videos: ['.mp4', '.avi', '.mkv', '.mov', '.webm'],
  Other: [],
};

export function getCategory(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const category = Object.keys(categories).find((name) =>
    categories[name].includes(extension),
  );
  return category ?? 'Other';
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** file.pdf → file(1).pdf → file(2).pdf ... when a file with that name already exists. */
export async function getUniquePath(targetPath) {
  const { dir, name, ext } = path.parse(targetPath);
  let candidate = targetPath;
  let counter = 1;

  while (await exists(candidate)) {
    candidate = path.join(dir, `${name}(${counter})${ext}`);
    counter++;
  }

  return candidate;
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class Organizer extends EventEmitter {
  async organize(sourceDir, outputDir) {
    const source = path.resolve(sourceDir);
    const output = path.resolve(outputDir);

    if (source === output) {
      const error = new Error('Source and output directories must be different');
      error.code = 'ESAMEDIR';
      throw error;
    }

    this.emit('organize-start', { source, output });

    const allFiles = await getAllFiles(source, (filePath, error) => {
      this.emit('copy-error', { source: filePath, error });
    });
    // If the output directory is inside the source, don't copy its contents again
    const files = allFiles.filter((filePath) => !isInside(filePath, output));

    for (const category of Object.keys(categories)) {
      const folder = path.join(output, category);
      await fs.mkdir(folder, { recursive: true });
      this.emit('folder-created', { category, path: folder });
    }
    this.emit('folders-ready', { total: files.length });

    const summary = Object.fromEntries(
      Object.keys(categories).map((category) => [category, { count: 0, totalSize: 0 }]),
    );
    const total = files.length;
    let processed = 0;
    let copiedFiles = 0;
    let copiedSize = 0;
    let failed = 0;

    for (const sourcePath of files) {
      processed++;
      const category = getCategory(sourcePath);
      let targetPath;

      try {
        const { size } = await fs.stat(sourcePath);
        targetPath = await getUniquePath(
          path.join(output, category, path.basename(sourcePath)),
        );
        const method = size >= LARGE_FILE_THRESHOLD ? 'stream' : 'copyFile';

        this.emit('copy-start', { source: sourcePath, target: targetPath, category, size, method });

        if (method === 'stream') {
          // 'wx' — never overwrite, even if the file appeared in the meantime
          await pipeline(
            createReadStream(sourcePath),
            createWriteStream(targetPath, { flags: 'wx' }),
          );
        } else {
          await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        }

        summary[category].count++;
        summary[category].totalSize += size;
        copiedFiles++;
        copiedSize += size;

        this.emit('copy-complete', {
          source: sourcePath,
          target: targetPath,
          category,
          size,
          method,
          processed,
          total,
        });
      } catch (error) {
        failed++;
        // Remove a partially copied file so no broken copies are left behind
        if (targetPath && error.code !== 'EEXIST') {
          await fs.rm(targetPath, { force: true }).catch(() => {});
        }
        this.emit('copy-error', { source: sourcePath, target: targetPath, error, processed, total });
      }
    }

    const result = { source, output, summary, copiedFiles, copiedSize, failed };
    this.emit('organize-complete', result);
    return result;
  }
}
