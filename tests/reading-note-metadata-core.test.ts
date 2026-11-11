import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	buildReadingNoteMetadataProposals,
	candidatesFromReferenceMetadata,
	extractEmbeddedPdfMetadata,
	getReferenceMetadataConfidence,
	isBlankFrontmatterValue,
	mergeReadingNoteCandidates,
	normalizeDoi,
	parseTranslatedBookExtraMetadata,
} from '../src/lib/reading-note-metadata-core';
import { collectPdfFrontMatterPages } from '../src/lib/pdf-front-matter-text';

test('front-matter collection stays bounded and preserves page slots across errors', async () => {
	const requested: number[] = [];
	const cleaned: number[] = [];
	const errors: Array<{ pageNumber: number, phase: string }> = [];
	const pages = await collectPdfFrontMatterPages({
		numPages: 20,
		async getPage(pageNumber) {
			requested.push(pageNumber);
			return {
				async getTextContent() {
					if (pageNumber === 2) throw new Error('Unreadable text layer');
					return { items: [{ str: `page ${pageNumber}`, hasEOL: true }] };
				},
				cleanup() {
					cleaned.push(pageNumber);
					if (pageNumber === 3) throw new Error('Cleanup failed');
				},
			};
		},
	}, {
		pageLimit: 12,
		characterLimit: 50_000,
		onError: (pageNumber, phase) => errors.push({ pageNumber, phase }),
	});

	assert.deepEqual(requested, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	assert.equal(pages.length, 12);
	assert.equal(pages[1], '');
	assert.equal(pages[2], 'page 3');
	assert.equal(pages[3], 'page 4');
	assert.deepEqual(cleaned, requested);
	assert.deepEqual(errors, [
		{ pageNumber: 2, phase: 'read' },
		{ pageNumber: 3, phase: 'cleanup' },
	]);
});

test('rich journal XMP maps bibliographic values without using PDF lifecycle dates', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'downloaded-article',
		info: {
			Title: 'Conflicting Info title',
			Author: 'Conflicting Info author',
			CreationDate: 'D:20100403120000',
			ModDate: 'D:20260908062946',
		},
		xmp: {
			'dc:title': 'Situated Reading',
			'dc:creator': ['Ada Scholar', 'Bea Researcher'],
			'prism:publicationDate': '2024-06-01',
			'prism:publicationName': 'Journal of Careful Metadata',
			'prism:volume': '12',
			'prism:number': '3',
			'prism:startingPage': '123',
			'prism:endingPage': '145',
			'prism:doi': 'https://doi.org/10.1234/example.7',
			'dc:publisher': 'Example University Press',
		},
	});

	assert.equal(candidates.title?.value, 'Situated Reading');
	assert.equal(candidates.author?.value, 'Ada Scholar; Bea Researcher');
	assert.equal(candidates.year?.value, '2024');
	assert.equal(candidates.journal?.value, 'Journal of Careful Metadata');
	assert.equal(candidates.volume?.value, '12');
	assert.equal(candidates.issue?.value, '3');
	assert.equal(candidates.pages?.value, '123–145');
	assert.equal(candidates.doi?.value, '10.1234/example.7');
	assert.equal(candidates.publisher?.value, 'Example University Press');
});

test('explicit PDF keywords fill concepts as a deduplicated list without touching tags', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'article',
		xmp: {
			'dc:subject': ['Resilience', 'food systems', 'resilience', 'https://example.org/not-a-concept'],
		},
	});
	const proposals = buildReadingNoteMetadataProposals(
		{ concepts: null, tags: null },
		candidates,
	);

	assert.deepEqual(candidates.concepts?.value, ['Resilience', 'food systems']);
	assert.equal(candidates.concepts?.confidence, 'high');
	assert.equal(proposals[0]?.property, 'concepts');
	assert.deepEqual(proposals[0]?.value, ['Resilience', 'food systems']);
	assert.ok(!proposals.some((proposal) => proposal.property === 'tags'));
});

test('XMP subject bag entries keep meaningful commas while keyword strings are split', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'article',
		xmp: {
			'dc:subject': ['Health, Culture and Society', 'Embodiment'],
			'pdf:keywords': 'affect, archives, embodiment',
		},
	});

	assert.deepEqual(candidates.concepts?.value, [
		'Health, Culture and Society',
		'Embodiment',
		'affect',
		'archives',
	]);
});

test('PDF Info Keywords are used when richer XMP keywords are absent', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'article',
		info: { Keywords: 'Author Keywords: care ethics; subjectivity; 10.1234/not-a-concept' },
	});

	assert.deepEqual(candidates.concepts?.value, ['care ethics', 'subjectivity']);
	assert.equal(candidates.concepts?.source, 'pdf-info');
});

test('generic PDF Subject prose is not treated as concepts and entered concepts are preserved', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'article',
		info: { Subject: 'A prose abstract about the article rather than a keyword list.' },
	});
	assert.equal(candidates.concepts, undefined);

	const explicitKeywords = extractEmbeddedPdfMetadata({
		fileBasename: 'article',
		info: { Keywords: 'care; relationality' },
	});
	assert.ok(!buildReadingNoteMetadataProposals(
		{ concepts: ['already entered'] },
		explicitKeywords,
	).some((proposal) => proposal.property === 'concepts'));
});

test('Info metadata accepts sane title and author but never derives publication year from file dates', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'article-file',
		info: {
			Title: 'A Useful Article',
			Author: 'Michelle Scholar',
			Creator: 'Microsoft Word',
			Producer: 'Quartz PDFContext',
			CreationDate: 'D:20241231235959',
			ModDate: 'D:20250101000000',
		},
	});

	assert.equal(candidates.title?.value, 'A Useful Article');
	assert.equal(candidates.author?.value, 'Michelle Scholar');
	assert.equal(candidates.year, undefined);
});

test('converted EPUB front matter supplies conservative book metadata after blank pages', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'somers_hall_2026_reading_a_thousand_plateaus_adventures_in_nomad_thought_2',
		info: {
			Title: 'Reading a Thousand Plateaus: Adventures in Nomad Thought',
			CreationDate: "D:20261104133252+11'00'",
			ModDate: "D:20261104133252+11'00'",
		},
		firstPageText: [
			'Reading a Thousand Plateaus: Adventures in Nomad Thought',
			'Henry Somers-Hall',
			'2026-05-31T20:22:33.111893+00:00',
		].join('\n'),
		frontMatterPages: [
			'Reading a Thousand Plateaus: Adventures in Nomad Thought\nHenry Somers-Hall\n2026-05-31T20:22:33.111893+00:00',
			'',
			'',
			[
				'Reading A Thousand Plateaus',
				'Adventures in Nomad Thought',
				'Henry Somers-Hall',
				'Edinburgh University Press is one of the leading university presses in the UK.',
				'© Henry Somers-Hall, 2026',
				'Edinburgh University Press Ltd',
				'13 In fi rmary Street, Edinburgh EH1 1LT',
				'A CIP record for this book is available from the British Library',
				'ISBN 978 1 3995 4062 9',
				'The right of Henry Somers-Hall to be identi fi ed as the author of this work has been asserted.',
				'For more information, visit www.edinburghuniversitypress.com.',
			].join('\n'),
		],
	});

	assert.equal(candidates.title?.value, 'Reading a Thousand Plateaus: Adventures in Nomad Thought');
	assert.equal(candidates.author?.value, 'Henry Somers-Hall');
	assert.equal(candidates.author?.confidence, 'high');
	assert.equal(candidates.year?.value, '2026');
	assert.equal(candidates.year?.confidence, 'review');
	assert.equal(candidates.publisher?.value, 'Edinburgh University Press Ltd');
	assert.equal(candidates.isbn?.value, '9781399540629');
	assert.equal(candidates.sourceUrl, undefined);
	assert.equal(candidates.pages, undefined);
	assert.equal(candidates.concepts, undefined);
});

test('converted-file timestamps and generic XMP dates never become publication years', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'converted-book',
		info: {
			CreationDate: 'D:20261104133252',
			ModDate: 'D:20261104133252',
		},
		xmp: { 'dc:date': '2026-11-04T13:32:52+11:00' },
		firstPageText: 'A Book\nAn Author\n2026-05-31T20:22:33.111893+00:00',
		frontMatterPages: ['A Book\nAn Author\n2026-05-31T20:22:33.111893+00:00'],
	});

	assert.equal(candidates.year, undefined);
});

test('book front-matter heuristics ignore journal copyright and permission lines', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'journal-article',
		frontMatterPages: [
			'Copyright © The Author(s), 2024\nPublished by permission of the author',
		],
	});

	assert.equal(candidates.author, undefined);
	assert.equal(candidates.year, undefined);
	assert.equal(candidates.publisher, undefined);
});

test('Copyright plus a symbol parses a clean book author name', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: [[
			'Copyright © Jane Scholar, 2024',
			'Jane Scholar to be identified as the author of this work',
			'A CIP record for this book is available',
			'ISBN 978-0-306-40615-7',
		].join('\n')],
	});

	assert.equal(candidates.author?.value, 'Jane Scholar');
});

test('only a line-anchored first-published statement can outrank a copyright year', () => {
	const explicit = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		info: { CreationDate: 'D:20261104133252' },
		frontMatterPages: [[
			'First published 2018',
			'© Jane Scholar, 2024',
			'ISBN 978-0-306-40615-7',
		].join('\n')],
	});
	assert.equal(explicit.year?.value, '2018');
	assert.equal(explicit.year?.confidence, 'high');

	const prose = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: [[
			'Notes. First published as an essay in 1968, it was revised later.',
			'© Jane Scholar, 2024',
			'ISBN 978-0-306-40615-7',
		].join('\n')],
	});
	assert.equal(prose.year?.value, '2024');
	assert.equal(prose.year?.confidence, 'review');

	const ambiguous = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: [[
			'First published 2018',
			'First published 2020',
			'© Jane Scholar, 2024',
			'ISBN 978-0-306-40615-7',
		].join('\n')],
	});
	assert.equal(ambiguous.year, undefined);
});

test('a book title ending in Press is not mistaken for a publisher', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'the-printing-press',
		frontMatterPages: [[
			'The Printing Press',
			'© Jane Scholar, 2024',
			'ISBN 978-0-306-40615-7',
		].join('\n')],
	});

	assert.equal(candidates.publisher, undefined);
});

test('front-matter ISBNs must be uniquely labelled and checksum-valid', () => {
	const invalid = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: ['ISBN 978 1 3995 4062 8'],
	});
	assert.equal(invalid.isbn, undefined);

	const multiple = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: ['ISBN 978 1 3995 4062 9; ISBN (ebook) 978-0-306-40615-7'],
	});
	assert.equal(multiple.isbn, undefined);

	const advertised = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: ['Other titles available\nISBN 978-0-306-40615-7'],
	});
	assert.equal(advertised.isbn, undefined);

	const embeddedSuffix = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		frontMatterPages: ['© Jane Scholar, 2024\nISBN 9999781399540629'],
	});
	assert.equal(embeddedSuffix.isbn, undefined);
});

test('a DOI found after page one is not assumed to identify the converted book', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'book',
		firstPageText: 'Book title\nBook author',
		frontMatterPages: ['Book title\nBook author', '', 'References\n10.1234/cited-work'],
	});

	assert.equal(candidates.doi, undefined);
});

test('custom metadata and first-page text provide exact identifiers conservatively', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'paper',
		info: {
			Custom: {
				CitationKey: 'Dyason2026Care',
				Journal: 'Metadata Studies',
				PublicationDate: '2026-02-14',
			},
		},
		firstPageText: 'Read the article at doi:10.5555/ABC.123).',
	});

	assert.equal(candidates.citekey?.value, 'Dyason2026Care');
	assert.equal(candidates.journal?.value, 'Metadata Studies');
	assert.equal(candidates.year?.value, '2026');
	assert.equal(candidates.doi?.value, '10.5555/ABC.123');
});

test('explicit translated-book metadata maps without guessing from generic XMP fields', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'translated-book',
		xmp: {
			'original_title': 'Le titre original',
			'biblatex:origdate': '1968',
			'original_publisher': 'Éditions Exemple',
			'original_language': 'French',
			'foreword_author': 'A. Introducer',
			'dc:source': 'Not the original title',
			'dc:language': 'en-AU',
			'dc:contributor': 'Not necessarily a foreword author',
		},
	});

	assert.equal(candidates.originalTitle?.value, 'Le titre original');
	assert.equal(candidates.originalDatePublished?.value, '1968');
	assert.equal(candidates.originalPublisher?.value, 'Éditions Exemple');
	assert.equal(candidates.originalLanguage?.value, 'French');
	assert.equal(candidates.originalLanguage?.confidence, 'review');
	assert.equal(candidates.forewordAuthor?.value, 'A. Introducer');
	assert.equal(candidates.forewordAuthor?.confidence, 'review');
	assert.notEqual(candidates.originalTitle?.value, 'Not the original title');
	assert.notEqual(candidates.forewordAuthor?.value, 'Not necessarily a foreword author');
});

test('Zotero Extra translated-book fields support official labels and repeated foreword names', () => {
	const metadata = parseTranslatedBookExtraMetadata([
		'Original Title: Le titre original',
		'Original Date: 1968',
		'Original Publisher: Éditions Exemple',
		'Original Language: French',
		'Foreword Author: Derrida || Jacques',
		'Forward By: Spivak || Gayatri',
	].join('\n'));

	assert.equal(metadata.originalTitle, 'Le titre original');
	assert.equal(metadata.originalDatePublished, '1968');
	assert.equal(metadata.originalPublisher, 'Éditions Exemple');
	assert.equal(metadata.originalLanguage, 'French');
	assert.deepEqual(metadata.forewordAuthors, ['Jacques Derrida', 'Gayatri Spivak']);
});

test('suspicious office defaults are rejected and filename fallback requires review', () => {
	const candidates = extractEmbeddedPdfMetadata({
		fileBasename: 'Real title from filename',
		info: {
			Title: 'Microsoft Word - manuscript.docx',
			Author: 'Microsoft Office User',
		},
	});

	assert.equal(candidates.title?.value, 'Real title from filename');
	assert.equal(candidates.title?.confidence, 'review');
	assert.equal(candidates.author, undefined);
});

test('DOI normalization accepts resolver URLs, repairs filename-safe delimiters, and trims punctuation', () => {
	assert.equal(normalizeDoi('https://doi.org/10.1000/xyz.12).'), '10.1000/xyz.12');
	assert.equal(normalizeDoi('DOI: 10.4321/ABC_def'), '10.4321/ABC_def');
	assert.equal(normalizeDoi('10.1515_semi.2001.034'), '10.1515/semi.2001.034');
	assert.equal(normalizeDoi('10.1002/(SICI)1234-5678(199901)1:1<1::AID-TEST>3.0.CO;2-A'), '10.1002/(SICI)1234-5678(199901)1:1<1::AID-TEST>3.0.CO;2-A');
});

test('Zotero metadata has priority over embedded metadata', () => {
	const embedded = extractEmbeddedPdfMetadata({
		fileBasename: 'paper',
		info: { Title: 'Embedded title', Author: 'Embedded Author' },
	});
	const zotero = candidatesFromReferenceMetadata({
		citekey: 'Best2025',
		title: 'Authoritative title',
		authors: ['A. Best', 'B. Careful'],
		year: '2025',
		journal: 'Reliable Sources',
		volume: '4',
		issue: '2',
		pages: '10–29',
		doi: '10.9999/reliable',
		publisher: 'Source Press',
		url: 'https://example.org/article',
		itemType: 'journalArticle',
	});
	const merged = mergeReadingNoteCandidates(zotero, embedded);

	assert.equal(merged.title?.value, 'Authoritative title');
	assert.equal(merged.author?.value, 'A. Best; B. Careful');
	assert.equal(merged.publicationType?.value, 'Journal article');
});

test('a filename-only Zotero match remains review-only and cannot displace embedded metadata', () => {
	const embedded = extractEmbeddedPdfMetadata({
		fileBasename: 'paper',
		info: { Title: 'Embedded PDF title', Author: 'Embedded Author' },
	});
	const record = {
		citekey: 'Unverified2025',
		title: 'A different Zotero item',
		authors: ['Different Author'],
	};
	const confidence = getReferenceMetadataConfidence(record, embedded);
	const merged = mergeReadingNoteCandidates(
		candidatesFromReferenceMetadata(record, confidence),
		embedded,
	);

	assert.equal(confidence, 'review');
	assert.equal(merged.title?.value, 'Embedded PDF title');
	assert.equal(merged.author?.value, 'Embedded Author');
	assert.equal(merged.citekey?.confidence, 'review');
});

test('a matching DOI corroborates the Zotero attachment identity', () => {
	const embedded = extractEmbeddedPdfMetadata({
		fileBasename: 'paper',
		xmp: { 'prism:doi': '10.1234/matched' },
	});
	assert.equal(getReferenceMetadataConfidence({ doi: 'https://doi.org/10.1234/matched' }, embedded), 'exact');
	assert.equal(getReferenceMetadataConfidence({ doi: '10.1234/different' }, embedded), 'review');
});

test('blank detection preserves meaningful falsey and provisional values', () => {
	assert.equal(isBlankFrontmatterValue(null), true);
	assert.equal(isBlankFrontmatterValue('   '), true);
	assert.equal(isBlankFrontmatterValue([]), true);
	assert.equal(isBlankFrontmatterValue(['']), true);
	assert.equal(isBlankFrontmatterValue(0), false);
	assert.equal(isBlankFrontmatterValue(false), false);
	assert.equal(isBlankFrontmatterValue('Journal article?'), false);
	assert.equal(isBlankFrontmatterValue(['unread']), false);
	assert.equal(isBlankFrontmatterValue({}), false);
});

test('the supplied journal template fills only existing blank bibliographic fields', () => {
	const frontmatter = {
		created: '2025-04-03 22:03:18',
		updated: '08-09-2026 06:29:46',
		citekey: null,
		author: '',
		author_affiliation: null,
		year: null,
		title: null,
		journal: null,
		volume: null,
		issue: null,
		pages: null,
		doi: null,
		publisher: null,
		source_url: null,
		PDF: null,
		publication_type: 'Journal article?',
		ai_summary: null,
		concepts: null,
		method: null,
		tags: null,
		rating: null,
		type: 'reading_note',
		reading_status: ['unread'],
		project_note: null,
		citationPageOffset: null,
		cssclasses: ['scholia-note-align-justify'],
	};
	const candidates = mergeReadingNoteCandidates(
		candidatesFromReferenceMetadata({
			citekey: 'Careful2024',
			title: 'Careful Metadata',
			authors: ['Ada Scholar'],
			year: '2024',
			journal: 'Reliable Sources',
			volume: '2',
			issue: '1',
			pages: '1–20',
			doi: '10.1234/careful',
			publisher: 'Source Press',
			url: 'https://example.org/careful',
			itemType: 'journalArticle',
		}),
		{
			pdf: {
				field: 'pdf', value: '[[Sources/Careful Metadata.pdf]]', source: 'pdf-link', confidence: 'exact',
			},
		},
	);
	const proposals = buildReadingNoteMetadataProposals(frontmatter, candidates);
	const properties = proposals.map((proposal) => proposal.property);

	assert.deepEqual(properties.sort(), [
		'PDF', 'author', 'citekey', 'doi', 'issue', 'journal', 'pages', 'publisher',
		'source_url', 'title', 'volume', 'year',
	].sort());
	assert.ok(!properties.includes('publication_type'));
	assert.ok(!properties.includes('created'));
	assert.ok(!properties.includes('updated'));
	assert.ok(!properties.includes('ai_summary'));
	assert.ok(!properties.includes('concepts'));
	assert.ok(!properties.includes('method'));
	assert.ok(!properties.includes('reading_status'));
	assert.ok(!properties.includes('cssclasses'));
});

test('the supplied translated-book template fills its bibliographic fields and preserves question-mark values', () => {
	const frontmatter = {
		created: '2025-04-03 22:03:18',
		updated: '01-11-2026 06:28:43',
		citekey: null,
		author: null,
		author_affiliation: null,
		translator: null,
		year: null,
		title: null,
		publisher: null,
		original_title: null,
		original_date_published: null,
		original_publisher: null,
		original_language: null,
		forward_author: null,
		source_url: null,
		ai_summary: null,
		pages: null,
		isbn: null,
		type: 'reading_note?',
		publication_type: 'book?',
		summary_30s: null,
		concepts: null,
		collection: null,
		discipline: null,
		theory: null,
		related_thinkers: null,
		method: null,
		epistemological_stance: null,
		scale: null,
		region: null,
		tags: null,
		rating: null,
		importance: null,
		emoji: null,
		reading_status: ['unread', 'reading', 'skimmed', 'finished', 'abandoned', 'read', 'read_next', 'revising'],
		project_note: null,
		citationPageOffset: null,
		cssclasses: ['scholia-note-align-justify'],
	};
	const candidates = candidatesFromReferenceMetadata({
		citekey: 'Translated1968',
		authors: ['Ada Author'],
		translators: ['Terry Translator'],
		year: '2024',
		title: 'The Translated Title',
		publisher: 'Current Press',
		originalTitle: 'Le titre original',
		originalDatePublished: '1968',
		originalPublisher: 'Éditions Exemple',
		originalLanguage: 'French',
		forewordAuthors: ['Fran Foreword'],
		url: 'https://example.org/book',
		pages: '384',
		isbn: '978-1-23456-789-0',
		itemType: 'book',
	});
	const proposals = buildReadingNoteMetadataProposals(frontmatter, candidates);
	const properties = proposals.map((proposal) => proposal.property);

	assert.deepEqual(properties.sort(), [
		'author', 'citekey', 'forward_author', 'isbn', 'original_date_published', 'original_language',
		'original_publisher', 'original_title', 'pages', 'publisher', 'source_url', 'title', 'translator', 'year',
	].sort());
	assert.equal(proposals.find((proposal) => proposal.property === 'original_language')?.confidence, 'review');
	assert.equal(proposals.find((proposal) => proposal.property === 'forward_author')?.confidence, 'review');
	assert.ok(!properties.includes('type'));
	assert.ok(!properties.includes('publication_type'));
	assert.ok(!properties.includes('ai_summary'));
	assert.ok(!properties.includes('theory'));
	assert.ok(!properties.includes('reading_status'));
	assert.ok(!properties.includes('cssclasses'));
});

test('the existing foreward_author misspelling is supported without adding a new property', () => {
	const proposals = buildReadingNoteMetadataProposals(
		{ foreward_author: null },
		candidatesFromReferenceMetadata({ forewordAuthors: ['Fran Foreword'] }),
	);

	assert.equal(proposals.length, 1);
	assert.equal(proposals[0]?.property, 'foreward_author');
	assert.equal(proposals[0]?.value, 'Fran Foreword');
});

test('converted-book candidates fill only blank bibliography fields in the live note shape', () => {
	const embedded = extractEmbeddedPdfMetadata({
		fileBasename: 'somers-hall',
		info: { Title: 'Reading a Thousand Plateaus: Adventures in Nomad Thought' },
		frontMatterPages: [[
			'© Henry Somers-Hall, 2026',
			'Henry Somers-Hall to be identified as the author of this work',
			'Edinburgh University Press Ltd',
			'A CIP record for this book is available from the British Library',
			'ISBN 978 1 3995 4062 9',
		].join('\n')],
	});
	const candidates = mergeReadingNoteCandidates(embedded, {
		pdf: {
			field: 'pdf',
			value: '[[somers-hall.pdf]]',
			source: 'pdf-link',
			confidence: 'exact',
		},
	});
	const proposals = buildReadingNoteMetadataProposals({
		created: '2025-04-03 22:03:18',
		updated: '04-11-2026 07:39:19',
		author: null,
		year: null,
		title: null,
		publisher: null,
		isbn: null,
		PDF: null,
		type: 'reading_note',
		publication_type: 'book?',
		ai_summary: null,
		epistemological_stance: '[[Epistemological stance]]',
		tags: 'review',
		reading_status: ['reading'],
	}, candidates);
	const properties = proposals.map((proposal) => proposal.property).sort();

	assert.deepEqual(properties, ['PDF', 'author', 'isbn', 'publisher', 'title', 'year'].sort());
	assert.ok(!properties.includes('created'));
	assert.ok(!properties.includes('updated'));
	assert.ok(!properties.includes('publication_type'));
	assert.ok(!properties.includes('epistemological_stance'));
	assert.ok(!properties.includes('tags'));
	assert.ok(!properties.includes('reading_status'));
});

test('absent properties are not added and duplicate aliases are skipped', () => {
	const candidates = candidatesFromReferenceMetadata({ title: 'A title', authors: ['One Author'] });
	assert.deepEqual(buildReadingNoteMetadataProposals({ author: null, authors: null }, candidates), []);
	assert.deepEqual(buildReadingNoteMetadataProposals({ unrelated: null }, candidates), []);
});

test('hyphenated PDF property aliases use the same matching rules as template proposals', () => {
	const proposals = buildReadingNoteMetadataProposals(
		{ 'source-pdf': null },
		{
			pdf: {
				field: 'pdf', value: '[[Sources/Paper.pdf]]', source: 'pdf-link', confidence: 'exact',
			},
		},
	);
	assert.equal(proposals[0]?.property, 'source-pdf');
});
