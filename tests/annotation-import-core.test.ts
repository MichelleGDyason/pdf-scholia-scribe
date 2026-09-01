import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	appleBooksExportToText,
	parseAppleBooksExport,
	parseKindleClippings,
	stableImportId,
	stableImportIdFromBytes,
} from '../src/lib/annotation-import-core';

test('Kindle clippings preserve locators and pair an adjacent note with its highlight', async () => {
	const input = '\uFEFFThe Fold (Gilles Deleuze)\r\n'
		+ '- Your Highlight on page 17 | location 241-243 | Added on Monday, 1 January 2024 10:00:00\r\n\r\n'
		+ 'The world is folded in each soul.\r\n==========\r\n'
		+ 'The Fold (Gilles Deleuze)\r\n'
		+ '- Your Note on page 17 | location 241-243 | Added on Monday, 1 January 2024 10:01:00\r\n\r\n'
		+ 'Compare this with Leibniz.\r\n==========\r\n';

	const documents = await parseKindleClippings(input);
	assert.equal(documents.length, 1);
	assert.equal(documents[0].title, 'The Fold');
	assert.equal(documents[0].author, 'Gilles Deleuze');
	assert.equal(documents[0].annotations.length, 1);
	assert.equal(documents[0].annotations[0].type, 'highlight');
	assert.equal(documents[0].annotations[0].page, 17);
	assert.equal(documents[0].annotations[0].locationStart, 241);
	assert.equal(documents[0].annotations[0].locationEnd, 243);
	assert.equal(documents[0].annotations[0].comment, 'Compare this with Leibniz.');
});

test('Kindle clippings deduplicate identical exports and retain unrecognised metadata', async () => {
	const block = 'Unknown Book (A. Reader)\n- Votre surlignement à la page 9 | emplacement 90-91\n\nTexte conservé.\n==========\n';
	const documents = await parseKindleClippings(block + block);
	assert.equal(documents[0].annotations.length, 1);
	assert.equal(documents[0].annotations[0].type, 'unknown');
	assert.match(documents[0].annotations[0].rawMetadata, /Votre surlignement/);
	assert.equal(documents[0].warnings.length, 1);
});

test('Apple Books labelled export retains colour, note, and location metadata', async () => {
	const input = [
		'Title: Difference and Repetition',
		'Author: Gilles Deleuze',
		'',
		'Highlight: Difference is not diversity.',
		'Note: Return to this definition.',
		'Colour: Blue',
		'Page: 222',
		'Location: 410-411',
	].join('\n');
	const documents = await parseAppleBooksExport(input, 'Books export.txt');
	assert.equal(documents.length, 1);
	assert.equal(documents[0].title, 'Difference and Repetition');
	assert.equal(documents[0].author, 'Gilles Deleuze');
	assert.equal(documents[0].annotations[0].text, 'Difference is not diversity.');
	assert.equal(documents[0].annotations[0].comment, 'Return to this definition.');
	assert.equal(documents[0].annotations[0].colorLabel, 'Blue');
	assert.equal(documents[0].annotations[0].page, 222);
	assert.equal(documents[0].annotations[0].locationStart, 410);
});

test('Apple Books shared excerpt and HTML are converted without executing markup', async () => {
	const html = '<blockquote>“A concept is a multiplicity.”</blockquote><p>Excerpt From<br>What Is Philosophy?<br>Gilles Deleuze and Félix Guattari<br>This material may be protected by copyright.</p><script>notRun()</script>';
	const text = appleBooksExportToText(html);
	assert.doesNotMatch(text, /<script>/);
	assert.doesNotMatch(text, /notRun/);
	const documents = await parseAppleBooksExport(html, 'Shared.html');
	assert.equal(documents[0].title, 'What Is Philosophy?');
	assert.equal(documents[0].author, 'Gilles Deleuze and Félix Guattari');
	assert.equal(documents[0].annotations[0].text, 'A concept is a multiplicity.');
});

test('Apple Books repeated labelled highlights inherit shared book metadata', async () => {
	const input = [
		'Title: A Thousand Plateaus',
		'Author: Gilles Deleuze and Félix Guattari',
		'Highlight: The first passage.',
		'Note: First comment.',
		'Highlight: The second passage.',
		'Colour: Purple',
	].join('\n');
	const documents = await parseAppleBooksExport(input, 'Shared.txt');
	assert.equal(documents.length, 1);
	assert.equal(documents[0].annotations.length, 2);
	assert.equal(documents[0].annotations[1].text, 'The second passage.');
	assert.equal(documents[0].annotations[1].colorLabel, 'Purple');
});

test('stable IDs do not expose the source text and remain deterministic', async () => {
	const first = await stableImportId('Private title and annotation text');
	const second = await stableImportId('Private title and annotation text');
	assert.equal(first, second);
	assert.match(first, /^[0-9a-f]{8,24}$/);
	assert.doesNotMatch(first, /Private/);
	const bytes = new TextEncoder().encode('synthetic PDF bytes').buffer;
	assert.equal(await stableImportIdFromBytes(bytes), await stableImportIdFromBytes(bytes.slice(0)));
});
