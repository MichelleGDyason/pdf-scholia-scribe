import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { getParagraphRange, planParagraphMove } from '../src/text-reordering-core';

test('finds the full blank-line-delimited paragraph around a cursor', () => {
	assert.deepEqual(getParagraphRange(['one', '', 'two', 'continued', '', 'three'], 3, 3), { start: 2, end: 3 });
});

test('expands a selection across multiple paragraphs', () => {
	assert.deepEqual(getParagraphRange(['one', '', 'two', '', 'three'], 0, 2), { start: 0, end: 2 });
});

test('moves a paragraph up while retaining the separator', () => {
	const move = planParagraphMove(['first', '', 'second', 'continued'], 2, 2, 'up');
	assert.deepEqual(move?.replacement, ['second', 'continued', '', 'first']);
	assert.equal(move?.lineDelta, -2);
});

test('moves a paragraph down while retaining multiple blank lines', () => {
	const move = planParagraphMove(['first', '', '', 'second', 'continued'], 0, 0, 'down');
	assert.deepEqual(move?.replacement, ['second', 'continued', '', '', 'first']);
	assert.equal(move?.lineDelta, 4);
});

test('does nothing at a document boundary or on a blank-only selection', () => {
	assert.equal(planParagraphMove(['first', '', 'second'], 0, 0, 'up'), null);
	assert.equal(planParagraphMove(['first', '', 'second'], 2, 2, 'down'), null);
	assert.equal(planParagraphMove(['first', '', 'second'], 1, 1, 'down'), null);
});
