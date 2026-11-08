import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseZoteroAttachmentMatch } from '../src/lib/zotero-attachment-match';

test('an exact linked-file path is trusted even when another attachment has the same filename', () => {
	const attachments = [
		{
			key: 'EXACT',
			path: '/Users/example/Vault/Attachments/The Elements of Style.pdf',
			filename: '',
			title: 'The Elements of Style',
		},
		{
			key: 'COPY',
			path: 'storage:The Elements of Style.pdf',
			filename: 'The Elements of Style.pdf',
			title: 'The Elements of Style',
		},
	];
	assert.deepEqual(
		chooseZoteroAttachmentMatch(
			attachments,
			'The Elements of Style.pdf',
			'/Users/example/Vault/Attachments/The Elements of Style.pdf',
		),
		{ attachment: attachments[0], confidence: 'exact' },
	);
});

test('a unique filename-only match is retained for review', () => {
	const attachment = {
		key: 'STORED',
		path: 'storage:article.pdf',
		filename: '',
		title: 'article',
	};
	assert.deepEqual(
		chooseZoteroAttachmentMatch([attachment], 'article.pdf', ''),
		{ attachment, confidence: 'review' },
	);
});

test('ambiguous filename-only matches are rejected', () => {
	const attachments = [
		{ key: 'ONE', path: 'storage:paper.pdf', filename: '', title: 'paper' },
		{ key: 'TWO', path: '', filename: 'paper.pdf', title: 'PDF' },
	];
	assert.equal(chooseZoteroAttachmentMatch(attachments, 'paper.pdf', ''), null);
});

test('linked paths compare case-insensitively with either slash style', () => {
	const attachment = {
		key: 'WINDOWS',
		path: 'C:\\Vault\\Attachments\\Book.pdf',
		filename: '',
		title: 'Book',
	};
	assert.equal(
		chooseZoteroAttachmentMatch([attachment], 'Book.pdf', 'c:/vault/attachments/book.pdf')?.confidence,
		'exact',
	);
});
