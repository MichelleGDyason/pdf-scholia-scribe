import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { convertTextCase, planTextCaseEdits, toSentenceCase, toTitleCase } from '../src/text-case-core';

test('upper and lower case retain punctuation, whitespace, and line breaks', () => {
	const source = '  Hello, PDF!\nSecond line.  ';
	assert.equal(convertTextCase(source, 'upper'), '  HELLO, PDF!\nSECOND LINE.  ');
	assert.equal(convertTextCase(source, 'lower'), '  hello, pdf!\nsecond line.  ');
});

test('sentence case normalizes words and capitalizes sentence and line starts', () => {
	assert.equal(
		toSentenceCase('hELLO WORLD. wELCOME!\nsecond LINE? “yES.”'),
		'Hello world. Welcome!\nSecond line? “Yes.”',
	);
});

test('sentence case preserves clear initialisms without treating an all-caps sentence as one acronym', () => {
	assert.equal(toSentenceCase('using the PDF API and NASA. next step'), 'Using the PDF API and NASA. Next step');
	assert.equal(toSentenceCase('THIS PDF IS USEFUL'), 'This PDF is useful');
});

test('sentence case retains intentional mixed-case names', () => {
	assert.equal(toSentenceCase('eBay SELLERS use an iPhone.'), 'eBay sellers use an iPhone.');
});

test('title case applies English small-word rules and capitalizes after a colon', () => {
	assert.equal(
		toTitleCase('the rise and fall of NASA: a study in AI'),
		'The Rise and Fall of NASA: A Study in AI',
	);
});

test('title case normalizes an all-caps heading while retaining common initialisms', () => {
	assert.equal(toTitleCase('READING A PDF IN THE AGE OF AI'), 'Reading a PDF in the Age of AI');
});

test('title case retains intentional mixed-case names and hyphenated punctuation', () => {
	assert.equal(toTitleCase('an iPhone guide for eBay sellers'), 'An iPhone Guide for eBay Sellers');
	assert.equal(toTitleCase('the state-of-the-art method'), 'The State-of-the-Art Method');
});

test('Markdown punctuation and blank lines remain byte-for-byte in place', () => {
	assert.equal(
		toTitleCase('## the state-of-the-art method\n\n- an introduction to PDF'),
		'## The State-of-the-Art Method\n\n- An Introduction to PDF',
	);
});

test('empty and punctuation-only selections are unchanged', () => {
	assert.equal(convertTextCase('', 'sentence'), '');
	assert.equal(convertTextCase('--- … !!!', 'title'), '--- … !!!');
});

test('a case edit plan preserves multiple selection directions and expanding Unicode', () => {
	assert.deepEqual(
		planTextCaseEdits(
			'straße + Mixed',
			[
				{ anchor: 0, head: 6 },
				{ anchor: 14, head: 9 },
			],
			'upper',
		),
		{
			changes: [
				{ from: 0, to: 6, text: 'STRASSE' },
				{ from: 9, to: 14, text: 'MIXED' },
			],
			selections: [
				{ anchor: 0, head: 7 },
				{ anchor: 15, head: 10 },
			],
			text: 'STRASSE + MIXED',
		},
	);
});

test('a caret after a length-changing selection keeps its logical position', () => {
	const plan = planTextCaseEdits(
		'straße + note',
		[
			{ anchor: 0, head: 6 },
			{ anchor: 13, head: 13 },
		],
		'upper',
	);
	assert.deepEqual(plan?.selections, [
		{ anchor: 0, head: 7 },
		{ anchor: 14, head: 14 },
	]);
});
