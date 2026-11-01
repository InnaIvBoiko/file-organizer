import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAllFiles } from './scanner.js';

/** Calculates a file's SHA-256 via a stream, without loading the whole file into memory. */
export function calculateHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export class DuplicateFinder extends EventEmitter {
  async find(directory) {
    const root = path.resolve(directory);
    this.emit('search-start', { directory: root });

    const files = await getAllFiles(root, (filePath, error) => {
      this.emit('file-error', { path: filePath, error });
    });

    const total = files.length;
    this.emit('hashing-start', { total });

    const byHash = new Map(); // Map<hash, { size, filePaths }>
    let processed = 0;

    for (const filePath of files) {
      processed++;
      try {
        const { size } = await fs.stat(filePath);
        const hash = await calculateHash(filePath);
        const group = byHash.get(hash) ?? { size, filePaths: [] };
        group.filePaths.push(filePath);
        byHash.set(hash, group);
        this.emit('file-processed', { path: filePath, hash, processed, total });
      } catch (error) {
        this.emit('file-error', { path: filePath, error, processed, total });
      }
    }

    const groups = [...byHash.entries()]
      .filter(([, group]) => group.filePaths.length > 1)
      .map(([hash, { size, filePaths }]) => ({
        hash,
        size,
        filePaths: filePaths.sort(),
        wastedSpace: size * (filePaths.length - 1),
      }))
      .sort((a, b) => b.wastedSpace - a.wastedSpace);

    const result = {
      directory: root,
      groups,
      totalWasted: groups.reduce((sum, group) => sum + group.wastedSpace, 0),
    };

    this.emit('duplicates-found', result);
    return result;
  }
}
