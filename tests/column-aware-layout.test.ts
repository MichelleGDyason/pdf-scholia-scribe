import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	ColumnAwareLayoutResult,
	ColumnAwareTextBox,
	detectColumnAwareRegions,
	layoutColumnAwarePage,
} from '../src/lib/column-aware-layout';

const PAGE = { width: 600, height: 800 } as const;

function box(str: string, x: number, y: number, width: number, height = 10): ColumnAwareTextBox {
	return { str, x, y, width, height };
}

function columnItems(prefix: string, x: number, width: number, ys: number[]) {
	return ys.map((y, index) => box(`${prefix} line ${index + 1} with enough text`, x, y, width));
}

function cleanTwoColumnItems() {
	const ys = [700, 670, 640, 610, 580, 550];
	return [
		...columnItems('Left', 50, 220, ys),
		...columnItems('Right', 330, 220, ys),
	];
}

function assertBoundedAndUnique(result: ColumnAwareLayoutResult, expectedItemCount: number) {
	const assignedIndices = result.regions.flatMap((region) => region.sourceItemIndices);
	assert.equal(assignedIndices.length, expectedItemCount);
	assert.equal(new Set(assignedIndices).size, expectedItemCount);
	for (const region of result.regions) {
		assert.ok(region.rect.x >= 0);
		assert.ok(region.rect.y >= 0);
		assert.ok(region.rect.width > 0);
		assert.ok(region.rect.height > 0);
		assert.ok(region.rect.x + region.rect.width <= PAGE.width);
		assert.ok(region.rect.y + region.rect.height <= PAGE.height);
	}
}

test('detects a conventional single-column page', () => {
	const items = columnItems('Body', 60, 480, [720, 680, 640, 600, 560, 520]);
	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'one-column');
	assert.equal(result.decision, 'detected-one-column');
	assert.deepEqual(result.regions.map((region) => region.kind), ['full-width']);
	assertBoundedAndUnique(result, items.length);
});

test('keeps EPUB body lines split around inline ligatures in one column', () => {
	const items: ColumnAwareTextBox[] = [];
	for (const [index, y] of [700, 670, 640, 610, 580, 550].entries()) {
		items.push(
			box(`Body line ${index + 1} before the ligature`, 60, y, 205, 12),
			box('fi', 268, y, 6, 12),
			box(`continues across the rest of the same line ${index + 1}`, 277, y, 263, 12),
		);
	}

	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'one-column');
	assert.equal(result.decision, 'detected-one-column');
	assert.deepEqual(result.regions.map((region) => region.kind), ['full-width']);
	assertBoundedAndUnique(result, items.length);
});

test('keeps linked EPUB index rows fragmented into inline runs in one column', () => {
	const items: ColumnAwareTextBox[] = [];
	for (const [index, y] of [700, 670, 640, 610, 580, 550].entries()) {
		let x = 60;
		for (const [text, width] of [
			[`Index term ${index + 1}`, 170],
			['123', 18],
			[',', 3],
			['456', 18],
			['–', 6],
			['7', 6],
			[',', 3],
			['512', 18],
			[',', 3],
			['600', 18],
		] as const) {
			items.push(box(text, x, y, width, 12));
			x += width + 3;
		}
	}

	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'one-column');
	assert.equal(result.decision, 'detected-one-column');
	assert.deepEqual(result.regions.map((region) => region.kind), ['full-width']);
	assertBoundedAndUnique(result, items.length);
});

test('still detects genuine columns when each line contains fragmented inline runs', () => {
	const items: ColumnAwareTextBox[] = [];
	for (const [index, y] of [700, 670, 640, 610, 580, 550].entries()) {
		items.push(
			box(`Left ${index + 1} before`, 50, y, 80, 12),
			box('fi', 133, y, 6, 12),
			box(`left continuation ${index + 1}`, 142, y, 100, 12),
			box(`Right ${index + 1} before`, 330, y, 80, 12),
			box('fi', 413, y, 6, 12),
			box(`right continuation ${index + 1}`, 422, y, 100, 12),
		);
	}

	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'two-column');
	assert.equal(result.decision, 'detected-two-column');
	assert.deepEqual(result.regions.map((region) => region.column), ['left', 'right']);
	assertBoundedAndUnique(result, items.length);
});

test('detects a clean two-column page and reads left before right', () => {
	const items = cleanTwoColumnItems();
	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'two-column');
	assert.equal(result.decision, 'detected-two-column');
	assert.ok(result.confidence >= 0.62);
	assert.deepEqual(result.regions.map((region) => region.column), ['left', 'right']);
	assert.deepEqual(result.regions[0].sourceItemIndices, [0, 1, 2, 3, 4, 5]);
	assert.deepEqual(result.regions[1].sourceItemIndices, [6, 7, 8, 9, 10, 11]);
	assertBoundedAndUnique(result, items.length);
});

test('renders a spanning title once before the two columns', () => {
	const title = box('A title spanning the page', 60, 755, 480, 20);
	const body = cleanTwoColumnItems();
	const items = [title, ...body];
	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'two-column');
	assert.deepEqual(result.regions.map((region) => region.kind), ['full-width', 'column', 'column']);
	assert.deepEqual(result.regions[0].sourceItemIndices, [0]);
	assert.equal(result.regions.filter((region) => region.sourceItemIndices.includes(0)).length, 1);
	assertBoundedAndUnique(result, items.length);
});

test('renders a spanning table band once between upper and lower columns', () => {
	const upperYs = [700, 675, 650, 625];
	const lowerYs = [330, 305, 280, 255];
	const items = [
		...columnItems('Upper left', 50, 220, upperYs),
		...columnItems('Upper right', 330, 220, upperYs),
		box('Table 1: full-width comparison', 45, 440, 510, 16),
		box('Table left cell', 70, 410, 180),
		box('Table right cell', 350, 410, 180),
		...columnItems('Lower left', 50, 220, lowerYs),
		...columnItems('Lower right', 330, 220, lowerYs),
	];
	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.resolvedMode, 'two-column');
	assert.deepEqual(result.regions.map((region) => region.kind), [
		'column',
		'column',
		'full-width',
		'column',
		'column',
	]);
	const tableRegion = result.regions[2];
	assert.deepEqual(tableRegion.sourceItemIndices, [8, 9, 10]);
	assert.equal(result.regions.filter((region) => region.sourceItemIndices.includes(8)).length, 1);
	assertBoundedAndUnique(result, items.length);
});

test('falls back safely for sparse text and image-only pages', () => {
	const sparseItems = [
		box('Sparse left label', 50, 700, 180),
		box('Sparse right label', 360, 700, 180),
	];
	const sparse = layoutColumnAwarePage(PAGE, sparseItems);
	const imageOnly = layoutColumnAwarePage(PAGE, []);

	assert.equal(sparse.decision, 'fallback');
	assert.equal(sparse.fallbackReason, 'insufficient-text');
	assert.deepEqual(sparse.regions[0].sourceItemIndices, [0, 1]);
	assert.equal(imageOnly.decision, 'fallback');
	assert.equal(imageOnly.fallbackReason, 'insufficient-text');
	assert.deepEqual(imageOnly.regions[0].rect, { x: 0, y: 0, width: 600, height: 800 });
	assertBoundedAndUnique(sparse, sparseItems.length);
	assertBoundedAndUnique(imageOnly, 0);
});

test('can read the right column before the left column', () => {
	const items = cleanTwoColumnItems();
	const result = layoutColumnAwarePage(PAGE, items, { swapColumns: true });

	assert.equal(result.resolvedMode, 'two-column');
	assert.deepEqual(result.regions.map((region) => region.column), ['right', 'left']);
	assert.deepEqual(result.regions[0].sourceItemIndices, [6, 7, 8, 9, 10, 11]);
	assert.deepEqual(result.regions[1].sourceItemIndices, [0, 1, 2, 3, 4, 5]);
	assertBoundedAndUnique(result, items.length);
});

test('falls back for rotated or invalid text geometry', () => {
	const rotated: ColumnAwareTextBox[] = [
		{ str: 'Rotated text', width: 120, height: 10, transform: [0, 10, -10, 0, 100, 600] },
		...cleanTwoColumnItems(),
	];
	const invalid: ColumnAwareTextBox[] = [
		box('Valid text', 50, 700, 220),
		{ str: 'Invalid text', x: 330, y: 700, width: Number.NaN, height: 10 },
		...cleanTwoColumnItems(),
	];
	const rotatedResult = layoutColumnAwarePage(PAGE, rotated);
	const invalidResult = layoutColumnAwarePage(PAGE, invalid);

	assert.equal(rotatedResult.decision, 'fallback');
	assert.equal(rotatedResult.fallbackReason, 'unsupported-text-geometry');
	assert.equal(rotatedResult.regions.length, 1);
	assert.equal(invalidResult.decision, 'fallback');
	assert.equal(invalidResult.fallbackReason, 'unsupported-text-geometry');
	assert.equal(invalidResult.regions.length, 1);
	assertBoundedAndUnique(rotatedResult, rotated.length);
	assertBoundedAndUnique(invalidResult, invalid.length);
});

test('falls back for meaningful right-to-left text in auto and forced two-column modes', () => {
	const items = cleanTwoColumnItems().map((item, index) => ({
		...item,
		dir: index < 3 ? 'rtl' : 'ltr',
	}));
	const automatic = layoutColumnAwarePage(PAGE, items);
	const forced = layoutColumnAwarePage(PAGE, items, { mode: 'two-column' });

	for (const result of [automatic, forced]) {
		assert.equal(result.decision, 'fallback');
		assert.equal(result.fallbackReason, 'unsupported-text-direction');
		assert.equal(result.resolvedMode, 'one-column');
		assert.deepEqual(result.regions[0].rect, { x: 0, y: 0, width: 600, height: 800 });
		assertBoundedAndUnique(result, items.length);
	}
});

test('resolves vertical text from PDF.js TextContent styles and returns a full-page crop', () => {
	const items = cleanTwoColumnItems().map((item, index) => ({
		str: item.str ?? '',
		width: item.width ?? 0,
		height: item.height ?? 0,
		transform: [item.height ?? 0, 0, 0, item.height ?? 0, item.x ?? 0, item.y ?? 0],
		dir: 'ltr',
		fontName: index < 2 ? 'VerticalBody' : 'HorizontalBody',
	}));
	const regions = detectColumnAwareRegions({
		view: [0, 0, 600, 800],
		rotation: 0,
		items,
		styles: {
			VerticalBody: { vertical: true },
			HorizontalBody: { vertical: false },
		},
	}, { mode: 'two-column' });

	assert.deepEqual(regions, [{
		kind: 'full-width',
		rect: [0, 0, 600, 800],
		confidence: 0,
	}]);
});

test('does not treat an isolated short RTL token as meaningful page direction', () => {
	const items = cleanTwoColumnItems().map((item, index) => index === 0
		? { ...item, str: 'א', dir: 'rtl' }
		: { ...item, dir: 'ltr' });
	const result = layoutColumnAwarePage(PAGE, items);

	assert.equal(result.decision, 'detected-two-column');
	assert.equal(result.resolvedMode, 'two-column');
	assertBoundedAndUnique(result, items.length);
});

test('forced one-column mode remains a full-page native-order view for RTL text', () => {
	const items = cleanTwoColumnItems().map((item) => ({ ...item, dir: 'rtl' }));
	const result = layoutColumnAwarePage(PAGE, items, { mode: 'one-column' });

	assert.equal(result.decision, 'forced-one-column');
	assert.equal(result.fallbackReason, undefined);
	assert.deepEqual(result.regions.map((region) => region.kind), ['full-width']);
	assertBoundedAndUnique(result, items.length);
});

test('falls back to one bounded region for a rotated page or invalid page box', () => {
	const items = cleanTwoColumnItems();
	const rotatedPage = layoutColumnAwarePage({ ...PAGE, rotation: 90 }, items);
	const invalidPage = layoutColumnAwarePage({ width: Number.NaN, height: 800 }, items);

	assert.equal(rotatedPage.fallbackReason, 'rotated-page');
	assert.equal(rotatedPage.regions.length, 1);
	assert.deepEqual(rotatedPage.regions[0].rect, { x: 0, y: 0, width: 600, height: 800 });
	assert.equal(invalidPage.fallbackReason, 'invalid-page');
	assert.equal(invalidPage.regions.length, 1);
	assert.deepEqual(invalidPage.regions[0].rect, { x: 0, y: 0, width: 1, height: 800 });
	assertBoundedAndUnique(rotatedPage, items.length);
	assertBoundedAndUnique(invalidPage, items.length);
});

test('honours explicit one-column and two-column modes', () => {
	const sparseItems = [box('Only one text item', 50, 700, 220)];
	const oneColumn = layoutColumnAwarePage(PAGE, cleanTwoColumnItems(), { mode: 'one-column' });
	const twoColumn = layoutColumnAwarePage(PAGE, sparseItems, { mode: 'two-column' });

	assert.equal(oneColumn.decision, 'forced-one-column');
	assert.equal(oneColumn.regions.length, 1);
	assert.equal(twoColumn.decision, 'forced-two-column');
	assert.equal(twoColumn.regions.length, 2);
	assertBoundedAndUnique(oneColumn, 12);
	assertBoundedAndUnique(twoColumn, 1);
});

test('exposes ordered PDF user-space rectangles for the companion view', () => {
	const items = cleanTwoColumnItems().map((item) => ({
		str: item.str ?? '',
		width: item.width ?? 0,
		height: item.height ?? 0,
		transform: [item.height ?? 0, 0, 0, item.height ?? 0, (item.x ?? 0) + 10, (item.y ?? 0) + 20],
	}));
	const regions = detectColumnAwareRegions({
		view: [10, 20, 610, 820],
		rotation: 0,
		items,
	}, { mode: 'auto' });

	assert.deepEqual(regions.map((region) => region.kind), ['left-column', 'right-column']);
	assert.deepEqual(regions[0].rect, [10, 20, 310, 820]);
	assert.deepEqual(regions[1].rect, [310, 20, 610, 820]);
	assert.ok(regions.every((region) => region.confidence >= 0.62));
});

test('honours a full-width band discovered from page graphics', () => {
	const items = cleanTwoColumnItems().map((item) => ({
		str: item.str ?? '',
		width: item.width ?? 0,
		height: item.height ?? 0,
		transform: [item.height ?? 0, 0, 0, item.height ?? 0, item.x ?? 0, item.y ?? 0],
	}));
	const regions = detectColumnAwareRegions({
		view: [0, 0, 600, 800],
		rotation: 0,
		items,
		spanningBands: [[430, 500]],
	}, { mode: 'auto' });

	assert.deepEqual(regions.map((region) => region.kind), [
		'left-column',
		'right-column',
		'full-width',
		'left-column',
		'right-column',
	]);
	assert.deepEqual(regions[2].rect, [0, 430, 600, 500]);
});
