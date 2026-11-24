import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	getHeadingIndentDepthAtLine,
	getMarkdownHeadingIndentDepths,
	getNoteTextAlignment,
	isNoteHeadingIndentEnabled,
	markdownHasNoteHeadingIndentClass,
	parseCssClasses,
	setNoteHeadingIndentClass,
	setNoteTextAlignmentClass,
} from '../src/note-text-alignment-core';

test('a note without an alignment class uses Obsidian default left alignment', () => {
	assert.equal(getNoteTextAlignment(undefined), 'left');
	assert.equal(getNoteTextAlignment(['research-note']), 'left');
});

test('alignment is detected from string and list cssclasses values', () => {
	assert.equal(getNoteTextAlignment('research-note scholia-note-align-justify'), 'justify');
	assert.equal(getNoteTextAlignment(['research-note', 'scholia-note-align-center']), 'center');
});

test('changing alignment preserves unrelated classes and replaces managed classes', () => {
	assert.deepEqual(
		setNoteTextAlignmentClass(['research-note', 'scholia-note-align-left', 'wide-page'], 'justify'),
		['research-note', 'wide-page', 'scholia-note-align-justify'],
	);
	assert.deepEqual(
		setNoteTextAlignmentClass('research-note scholia-note-align-right', 'center'),
		['research-note', 'scholia-note-align-center'],
	);
});

test('malformed cssclasses values are rejected instead of overwritten', () => {
	assert.throws(() => parseCssClasses({ className: 'research-note' }), /must be text/);
	assert.throws(() => parseCssClasses(['research-note', 3]), /must be text/);
});

test('heading indentation can be toggled without changing alignment or unrelated classes', () => {
	const enabled = setNoteHeadingIndentClass(['research-note', 'scholia-note-align-justify'], true);
	assert.deepEqual(enabled, ['research-note', 'scholia-note-align-justify', 'scholia-note-heading-indents']);
	assert.equal(isNoteHeadingIndentEnabled(enabled), true);

	assert.deepEqual(
		setNoteHeadingIndentClass(enabled, false),
		['research-note', 'scholia-note-align-justify'],
	);
});

test('editing mode detects heading indentation only inside YAML frontmatter', () => {
	assert.equal(markdownHasNoteHeadingIndentClass([
		'---',
		'cssclasses:',
		'  - research-note',
		'  - scholia-note-heading-indents',
		'---',
		'# Heading',
	].join('\n')), true);
	assert.equal(markdownHasNoteHeadingIndentClass([
		'---',
		'cssclasses: research-note',
		'---',
		'scholia-note-heading-indents appears in prose only',
	].join('\n')), false);
	assert.equal(markdownHasNoteHeadingIndentClass('scholia-note-heading-indents without frontmatter'), false);
});

test('editing depths follow the current heading level and reset at later headings', () => {
	const markdown = [
		'Intro',
		'# First',
		'Under H1',
		'## Second',
		'Under H2',
		'# Next first',
		'Under the next H1',
	].join('\n');

	assert.deepEqual(getMarkdownHeadingIndentDepths(markdown), [0, 0, 1, 0, 2, 0, 1]);
});

test('editing depths support Setext headings and ignore heading syntax inside fenced code', () => {
	const markdown = [
		'---',
		'title: Example',
		'---',
		'Section',
		'-------',
		'Under H2',
		'```md',
		'# Code, not a heading',
		'```',
		'Still under H2',
	].join('\n');

	assert.deepEqual(getMarkdownHeadingIndentDepths(markdown), [0, 0, 0, 0, 0, 2, 2, 2, 2, 2]);
});

test('reading depth uses the closest heading before a rendered section', () => {
	const headings = [
		{ level: 1, position: { start: { line: 2 } } },
		{ level: 3, position: { start: { line: 8 } } },
		{ level: 2, position: { start: { line: 14 } } },
	];

	assert.equal(getHeadingIndentDepthAtLine(headings, 0), 0);
	assert.equal(getHeadingIndentDepthAtLine(headings, 8), 1);
	assert.equal(getHeadingIndentDepthAtLine(headings, 9), 3);
	assert.equal(getHeadingIndentDepthAtLine(headings, 20), 2);
});
