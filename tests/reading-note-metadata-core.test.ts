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

test('DOI normalization accepts resolver URLs and trims trailing punctuation', () => {
	assert.equal(normalizeDoi('https://doi.org/10.1000/xyz.12).'), '10.1000/xyz.12');
	assert.equal(normalizeDoi('DOI: 10.4321/ABC_def'), '10.4321/ABC_def');
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
