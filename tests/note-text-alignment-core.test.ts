import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	getNoteTextAlignment,
	parseCssClasses,
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
