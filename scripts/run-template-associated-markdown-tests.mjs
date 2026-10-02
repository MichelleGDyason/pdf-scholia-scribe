import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outputDir = await mkdtemp(join(tmpdir(), 'scholia-template-associated-markdown-'));
try {
    const outfile = join(outputDir, 'test.mjs');
    await build({
        entryPoints: ['tests/template-associated-markdown.test.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['obsidian', 'electron'],
        outfile,
    });
    await import(pathToFileURL(outfile).href);
} finally {
    await rm(outputDir, { recursive: true, force: true });
}
