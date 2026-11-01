import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const outputDirectory = join(tmpdir(), 'pdf-scholia-scribe-reading-note-metadata-tests');
const outputFile = join(outputDirectory, 'reading-note-metadata-core.test.cjs');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
	entryPoints: ['tests/reading-note-metadata-core.test.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	outfile: outputFile,
});

const exitCode = await new Promise((resolve, reject) => {
	const child = spawn(process.execPath, ['--test', outputFile], { stdio: 'inherit' });
	child.once('error', reject);
	child.once('exit', (code) => resolve(code ?? 1));
});

await rm(outputDirectory, { recursive: true, force: true });
process.exitCode = exitCode;
