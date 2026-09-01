import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const path = new URL('../tests/fixtures/annotated-preview.pdf', import.meta.url);
const data = new Uint8Array(await readFile(path));
const loadingTask = getDocument({ data, useWorkerFetch: false, isEvalSupported: false });
const document = await loadingTask.promise;
try {
	assert.equal(document.numPages, 1);
	const metadata = await document.getMetadata();
	assert.equal(metadata.info.Title, 'Synthetic Preview Annotation Fixture');
	const page = await document.getPage(1);
	const annotations = await page.getAnnotations();
	const subtypes = annotations.map((annotation) => annotation.subtype);
	assert.deepEqual(subtypes, ['Highlight', 'Text', 'FreeText', 'Ink', 'Redact']);
	assert.equal(annotations[0].contentsObj.str, 'A preserved Preview highlight comment.');
	assert.deepEqual(Array.from(annotations[0].color), [255, 209, 31]);
	assert.equal(annotations[2].contentsObj.str, 'A Preview text box.');
	assert.equal(annotations[3].contentsObj.str, 'Handwritten ink retained; no OCR claimed.');
	console.log(`Verified ${annotations.length} synthetic PDF annotations: ${subtypes.join(', ')}`);
} finally {
	await document.destroy();
}
