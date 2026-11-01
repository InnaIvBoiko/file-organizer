#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { Scanner } from './lib/scanner.js';
import { DuplicateFinder } from './lib/duplicates.js';
import { Organizer, categories } from './lib/organizer.js';
import { Cleanup } from './lib/cleanup.js';

const LINE = '━'.repeat(34);
const CLEANUP_PREVIEW_LIMIT = 10;
const TYPES_LIMIT = 10;

const USAGE = `Usage:
  node file-organizer.js scan <directory>
  node file-organizer.js duplicates <directory>
  node file-organizer.js organize <source> --output <target>
  node file-organizer.js cleanup <directory> --older-than <days> [--confirm]`;

// ───────────── Helpers ─────────────

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

function drawProgressBar(current, total, width = 20) {
  const percentage = total === 0 ? 1 : current / total;
  const filled = Math.round(percentage * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${bar} ${current}/${total}`;
}

function createProgress(label, suffix = '') {
  let finished = false;
  return {
    update(current, total) {
      process.stdout.write(`\r${label} ${drawProgressBar(current, total)}${suffix}`);
    },
    // End the line so the next output doesn't overwrite the progress bar
    finish() {
      if (finished) return;
      finished = true;
      process.stdout.write('\n');
    },
  };
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Path relative to the scanned directory's parent: Downloads/backup/file.pdf */
function displayPath(filePath, root) {
  return path.join(path.basename(root), path.relative(root, filePath));
}

function describeError(error, target) {
  switch (error.code) {
    case 'ENOENT':
      return `Not found: ${target}`;
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: ${target}`;
    case 'ENOTDIR':
      return `Not a directory: ${target}`;
    case 'EISDIR':
      return `Is a directory: ${target}`;
    case 'EEXIST':
      return `Already exists: ${target}`;
    case 'ENOSPC':
      return `No space left on device while writing: ${target}`;
    case 'EMFILE':
      return `Too many open files while processing: ${target}`;
    case 'EBUSY':
      return `Resource busy or locked: ${target}`;
    case 'ESAMEDIR':
      return error.message;
    default:
      return `Unexpected error (${error.code ?? 'unknown'}): ${error.message}`;
  }
}

function fail(message) {
  console.error(`❌ Error: ${message}`);
  process.exit(1);
}

/** Warning about a single file that couldn't be processed (the command keeps going). */
function warnFileError(progress, { path: filePath, error }) {
  progress?.finish();
  console.warn(`⚠️  Skipped — ${describeError(error, filePath)}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, options };
}

// ───────────── Commands ─────────────

async function runScan(directory) {
  const scanner = new Scanner();
  const progress = createProgress('Processing...', ' files');

  scanner.on('scan-start', ({ directory }) => console.log(`📂 Scanning: ${directory}`));
  scanner.on('files-listed', ({ total }) => progress.update(0, total));
  scanner.on('file-found', ({ processed, total }) => progress.update(processed, total));
  scanner.on('file-error', (data) => {
    if (data.total) progress.update(data.processed, data.total);
    else warnFileError(null, data);
  });

  scanner.on('scan-complete', (stats) => {
    progress.finish();
    console.log('\n📊 Scan Results:');
    console.log(LINE);
    console.log(`Total files: ${stats.totalFiles}`);
    console.log(`Total size: ${formatSize(stats.totalSize)}`);

    if (stats.totalFiles === 0) return;

    console.log('\nBy File Type:');
    const shown = stats.byType.slice(0, TYPES_LIMIT);
    const rest = stats.byType.slice(TYPES_LIMIT);
    if (rest.length > 0) {
      shown.push({
        extension: '(other)',
        count: rest.reduce((sum, t) => sum + t.count, 0),
        totalSize: rest.reduce((sum, t) => sum + t.totalSize, 0),
      });
    }
    const extWidth = Math.max(...shown.map((t) => t.extension.length)) + 1;
    for (const type of shown) {
      console.log(
        `  ${type.extension.padEnd(extWidth)} ${String(type.count).padStart(4)} files  ${formatSize(type.totalSize).padStart(10)}`,
      );
    }

    console.log('\nFile Age:');
    console.log(`  Last 7 days:    ${stats.byAge.last7Days} files`);
    console.log(`  Last 30 days:   ${stats.byAge.last30Days} files`);
    console.log(`  Older than 90:  ${stats.byAge.olderThan90Days} files`);

    console.log('\nLargest files:');
    const nameWidth = Math.max(...stats.largestFiles.map((f) => f.name.length)) + 2;
    stats.largestFiles.forEach((file, i) => {
      console.log(`  ${i + 1}. ${file.name.padEnd(nameWidth)} ${formatSize(file.size).padStart(10)}`);
    });

    const oldest = stats.oldestFile;
    console.log(
      `\nOldest file: ${oldest.name} (modified ${Math.floor(oldest.daysOld)} days ago)`,
    );
  });

  await scanner.scan(directory);
}

async function runDuplicates(directory) {
  const finder = new DuplicateFinder();
  const progress = createProgress('Calculating hashes...', ' files');

  finder.on('search-start', ({ directory }) =>
    console.log(`🔍 Searching for duplicates in: ${directory}`),
  );
  finder.on('hashing-start', ({ total }) => progress.update(0, total));
  finder.on('file-processed', ({ processed, total }) => progress.update(processed, total));
  finder.on('file-error', (data) => {
    warnFileError(progress, data);
  });

  finder.on('duplicates-found', ({ directory, groups, totalWasted }) => {
    progress.finish();

    if (groups.length === 0) {
      console.log('\n✨ No duplicates found!');
      return;
    }

    console.log(
      `\nFound ${groups.length} duplicate groups (${formatSize(totalWasted)} wasted):\n`,
    );

    groups.forEach((group, i) => {
      console.log(LINE);
      console.log(
        `Group ${i + 1} (${group.filePaths.length} copies, ${formatSize(group.size)} each):`,
      );
      console.log(`  SHA-256: ${group.hash.slice(0, 12)}...\n`);
      for (const filePath of group.filePaths) {
        console.log(`  📄 ${displayPath(filePath, directory)}`);
      }
      console.log(`\n  Wasted space: ${formatSize(group.wastedSpace)}\n`);
    });

    console.log(LINE);
    console.log(`💾 Total wasted space: ${formatSize(totalWasted)}`);
  });

  await finder.find(directory);
}

async function runOrganize(source, output) {
  const organizer = new Organizer();
  const progress = createProgress('Copying files...');
  const errors = [];

  organizer.on('organize-start', ({ source, output }) => {
    console.log(`📦 Organizing: ${source}`);
    console.log(`Target: ${output}\n`);
    console.log('Creating folders...');
  });
  organizer.on('folder-created', ({ category }) => console.log(`  ✓ ${category}/`));
  organizer.on('folders-ready', () => console.log(''));
  organizer.on('copy-complete', ({ processed, total }) => progress.update(processed, total));
  organizer.on('copy-error', (data) => {
    if (data.total) progress.update(data.processed, data.total);
    errors.push(data);
  });

  organizer.on('organize-complete', ({ output, summary, copiedFiles, copiedSize }) => {
    progress.finish();

    // errors also includes unreadable subfolders, which are not counted in `failed`
    if (errors.length > 0) {
      console.log(`\n⚠️  ${errors.length} item(s) could not be copied:`);
      for (const { source, error } of errors) {
        console.log(`  - ${describeError(error, source)}`);
      }
    }

    console.log('\n✅ Organization complete!\n');
    console.log('Summary:');
    const outputName = path.basename(output);
    const width = Math.max(...Object.keys(categories).map((c) => c.length)) + 1;
    for (const [category, { count }] of Object.entries(summary)) {
      console.log(
        `  ${`${category}:`.padEnd(width + 1)} ${String(count).padStart(4)} files → ${outputName}/${category}/`,
      );
    }
    console.log(`\nTotal copied: ${copiedFiles} files (${formatSize(copiedSize)})`);
  });

  await organizer.organize(source, output);
}

async function runCleanup(directory, olderThan, confirm) {
  const cleanup = new Cleanup();
  const progress = createProgress('Deleting...');
  const deleteErrors = [];

  cleanup.on('cleanup-start', ({ directory, olderThan }) => {
    console.log(`🧹 Cleanup: ${directory}`);
    console.log(`Looking for files older than ${olderThan} days...\n`);
  });

  cleanup.on('file-error', (data) => {
    if (data.total) {
      progress.update(data.processed, data.total);
      deleteErrors.push(data);
    } else {
      warnFileError(null, data);
    }
  });

  let root;
  cleanup.on('cleanup-start', ({ directory }) => (root = directory));

  cleanup.on('search-complete', ({ files, totalSize }) => {
    if (files.length === 0) {
      console.log(`✨ No files older than ${olderThan} days found.`);
      return;
    }

    console.log(`Found ${files.length} files to delete:\n`);
    console.log(LINE);
    for (const file of files.slice(0, CLEANUP_PREVIEW_LIMIT)) {
      console.log(displayPath(file.path, root));
      console.log(`  Size: ${formatSize(file.size)}`);
      console.log(
        `  Modified: ${Math.floor(file.daysOld)} days ago (${formatDate(file.mtime)})\n`,
      );
    }
    if (files.length > CLEANUP_PREVIEW_LIMIT) {
      console.log(`... (${files.length - CLEANUP_PREVIEW_LIMIT} more files)`);
    }
    console.log(LINE);
    console.log(`\nTotal: ${files.length} files (${formatSize(totalSize)})`);
  });

  cleanup.on('delete-start', ({ total, totalSize }) => {
    console.log(
      `\n⚠️  DELETING ${total} files (${formatSize(totalSize)}). This action cannot be undone!\n`,
    );
    progress.update(0, total);
  });
  cleanup.on('file-deleted', ({ processed, total }) => progress.update(processed, total));

  cleanup.on('cleanup-complete', ({ dryRun, found, deleted, freed, failed }) => {
    if (found === 0) return;

    if (dryRun) {
      console.log('\n⚠️  DRY RUN MODE: No files were deleted.');
      console.log('To actually delete these files, run with --confirm flag.');
      return;
    }

    progress.finish();
    if (failed > 0) {
      console.log(`\n⚠️  ${failed} file(s) could not be deleted:`);
      for (const { path: filePath, error } of deleteErrors) {
        console.log(`  - ${describeError(error, filePath)}`);
      }
    }
    console.log('\n✅ Cleanup complete!');
    console.log(`Deleted: ${deleted} files (${formatSize(freed)} freed)`);
  });

  await cleanup.run(directory, { olderThan, confirm });
}

// ───────────── Entry point ─────────────

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));

  if (!command || command === '--help' || command === 'help' || options.help) {
    console.log(USAGE);
    return;
  }

  if (!['scan', 'duplicates', 'organize', 'cleanup'].includes(command)) {
    fail(`Unknown command "${command}".\n\n${USAGE}`);
  }

  const [directory] = positional;
  if (!directory) {
    fail(`Missing directory argument for "${command}".\n\n${USAGE}`);
  }

  try {
    switch (command) {
      case 'scan':
        await runScan(directory);
        break;

      case 'duplicates':
        await runDuplicates(directory);
        break;

      case 'organize': {
        if (typeof options.output !== 'string') {
          fail(`Missing --output <target> option.\n\n${USAGE}`);
        }
        await runOrganize(directory, options.output);
        break;
      }

      case 'cleanup': {
        // Strict check: "--older-than --confirm" or "--older-than ''" must not turn into 1 or 0 days
        const value = options['older-than'];
        const olderThan = Number(value);
        if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) {
          fail(`--older-than must be a non-negative number of days.\n\n${USAGE}`);
        }
        await runCleanup(directory, olderThan, options.confirm === true);
        break;
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`Directory not found: ${path.resolve(error.path ?? directory)}`);
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      fail(`Permission denied: ${error.path ?? directory}`);
    } else if (error.code) {
      fail(describeError(error, error.path ?? directory));
    } else {
      console.error(`❌ Unexpected error: ${error.message}`);
      process.exit(1);
    }
  }
}

main();
