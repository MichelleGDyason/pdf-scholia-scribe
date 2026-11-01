import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	BibliographyTextGeometryItem,
	findBibliographyStartIndex,
} from '../src/lib/bibliography-text-core';

function textItem(str: string, left: number, baseline: number, height = 10): BibliographyTextGeometryItem {
	return {
		str,
		height,
		transform: [height, 0, 0, height, left, baseline],
	};
}

test('preserves XYZ destination matching', () => {
	const items = [
		textItem('above target', 100, 700),
		textItem('left of target', 80, 600),
		textItem('bibliography entry', 100, 600),
	];

	assert.equal(findBibliographyStartIndex(items, 'XYZ', [100, 650, null]), 2);
});

test('preserves FitBH destination matching', () => {
	const items = [
		textItem('above target', 40, 700),
		textItem('bibliography entry', 40, 600),
	];

	assert.equal(findBibliographyStartIndex(items, 'FitBH', [650]), 1);
});

test('matches a FitR bibliography destination with fractional coordinate drift', () => {
	const items = [
		textItem('References', 306.592, 732.869, 7.9701),
		textItem('Adger et al., 2005. Successful adaptation', 306.595, 714.501, 6.3759),
	];

	assert.equal(
		findBibliographyStartIndex(items, 'FitR', [306.604, 720.485, 555.67, 720.485]),
		1,
	);
});

test('FitR matching stays inside the destination column', () => {
	const items = [
		textItem('left-column entry', 37.6, 530, 6.4),
		textItem('right-column entry above target', 306.6, 600, 6.4),
		textItem('right-column target', 306.6, 530, 6.4),
	];

	assert.equal(
		findBibliographyStartIndex(items, 'FitR', [306.6, 535, 555.7, 535]),
		2,
	);
});

test('FitR matching does not fall through to distant text when the target is absent', () => {
	const items = [
		textItem('same-column entry much farther down', 306.6, 400, 6.4),
	];

	assert.equal(
		findBibliographyStartIndex(items, 'FitR', [306.6, 535, 555.7, 535]),
		-1,
	);
});

test('returns no match for unsupported or incomplete destinations', () => {
	const items = [textItem('entry', 100, 500)];

	assert.equal(findBibliographyStartIndex(items, 'FitR', [100, 500, null, 510]), -1);
	assert.equal(findBibliographyStartIndex(items, 'FitH', [510]), -1);
});
