import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outputDir = await mkdtemp(join(tmpdir(), 'scholia-text-reordering-'));
try {
	const outfile = join(outputDir, 'test.mjs');
	await build({
		entryPoints: ['tests/text-reordering-core.test.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
	});
	await import(pathToFileURL(outfile).href);
} finally {
	await rm(outputDir, { recursive: true, force: true });
}
