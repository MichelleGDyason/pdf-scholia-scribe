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

test('a percent-encoded Zotero file URL matches the decoded vault path exactly', () => {
	const attachment = {
		key: 'JOURNAL',
		path: 'file:///Users/example/Obsidian%20Vault/Attachments/Seeing%20virtuality%20in%20nature%7BHoffmeyer%7D.pdf',
		filename: '',
		title: 'Seeing virtuality in nature',
	};
	assert.deepEqual(
		chooseZoteroAttachmentMatch(
			[attachment],
			'Seeing virtuality in nature{Hoffmeyer}.pdf',
			'/Users/example/Obsidian Vault/Attachments/Seeing virtuality in nature{Hoffmeyer}.pdf',
		),
		{ attachment, confidence: 'exact' },
	);
});

test('a percent-encoded file URL supplies a reviewable filename fallback', () => {
	const attachment = {
		key: 'URL_ONLY',
		path: 'file:///Users/example/Attachments/Journal%20article.pdf',
		filename: '',
		title: 'Journal article',
	};
	assert.deepEqual(
		chooseZoteroAttachmentMatch([attachment], 'Journal article.pdf', ''),
		{ attachment, confidence: 'review' },
	);
});

test('a Windows file URL matches a drive-letter path', () => {
	const attachment = {
		key: 'WINDOWS_URL',
		path: 'file:///C:/Vault/Attachments/Book%20chapter.pdf',
		filename: '',
		title: 'Book chapter',
	};
	assert.equal(
		chooseZoteroAttachmentMatch(
			[attachment],
			'Book chapter.pdf',
			'C:\\Vault\\Attachments\\Book chapter.pdf',
		)?.confidence,
		'exact',
	);
});

test('a network file URL matches a UNC path', () => {
	const attachment = {
		key: 'NETWORK_URL',
		path: 'file://server/share/Journal%20article.pdf',
		filename: '',
		title: 'Journal article',
	};
	assert.equal(
		chooseZoteroAttachmentMatch(
			[attachment],
			'Journal article.pdf',
			'\\\\server\\share\\Journal article.pdf',
		)?.confidence,
		'exact',
	);
});

test('malformed file URL escapes do not throw or become exact matches', () => {
	const attachment = {
		key: 'MALFORMED',
		path: 'file:///Users/example/Bad%2Path.pdf',
		filename: '',
		title: 'Bad path',
	};
	assert.doesNotThrow(() => chooseZoteroAttachmentMatch(
		[attachment],
		'Bad path.pdf',
		'/Users/example/Bad path.pdf',
	));
	assert.equal(
		chooseZoteroAttachmentMatch([attachment], 'Bad path.pdf', '/Users/example/Bad path.pdf'),
		null,
	);
});
