export type ReadingNoteMetadataField =
	| 'pdf'
	| 'citekey'
	| 'author'
	| 'authorAffiliation'
	| 'year'
	| 'title'
	| 'journal'
	| 'volume'
	| 'issue'
	| 'pages'
	| 'doi'
	| 'publisher'
	| 'sourceUrl'
	| 'publicationType'
	| 'translator'
	| 'isbn'
	| 'edition'
	| 'language'
	| 'originalTitle'
	| 'originalDatePublished'
	| 'originalPublisher'
	| 'originalLanguage'
	| 'forewordAuthor'
	| 'concepts';

export type ReadingNoteMetadataValue = string | number | string[];
export type ReadingNoteMetadataSource = 'pdf-link' | 'zotero' | 'xmp' | 'pdf-info' | 'pdf-custom' | 'first-page' | 'front-matter' | 'filename';
export type ReadingNoteMetadataConfidence = 'exact' | 'high' | 'review';

export interface ReadingNoteMetadataCandidate {
	field: ReadingNoteMetadataField;
	value: ReadingNoteMetadataValue;
	source: ReadingNoteMetadataSource;
	confidence: ReadingNoteMetadataConfidence;
	evidence?: string;
}

export type ReadingNoteMetadataCandidates = Partial<Record<ReadingNoteMetadataField, ReadingNoteMetadataCandidate>>;

export interface EmbeddedPdfMetadataInput {
	info?: unknown;
	xmp?: Record<string, unknown>;
	firstPageText?: string;
	frontMatterPages?: string[];
	fileBasename: string;
}

export interface ReferenceMetadataInput {
	citekey?: string;
	authors?: string[];
	translators?: string[];
	year?: string;
	title?: string;
	journal?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	doi?: string;
	publisher?: string;
	url?: string;
	itemType?: string;
	isbn?: string;
	edition?: string;
	language?: string;
	originalTitle?: string;
	originalDatePublished?: string;
	originalPublisher?: string;
	originalLanguage?: string;
	forewordAuthors?: string[];
}

export interface TranslatedBookExtraMetadata {
	originalTitle: string;
	originalDatePublished: string;
	originalPublisher: string;
	originalLanguage: string;
	forewordAuthors: string[];
}

export interface ReadingNoteMetadataProposal extends ReadingNoteMetadataCandidate {
	property: string;
}

const FIELD_ALIASES: Record<ReadingNoteMetadataField, string[]> = {
	pdf: ['pdf', 'sourcepdf', 'source_pdf', 'pdffile', 'pdf_file'],
	citekey: ['citekey', 'cite_key', 'citationkey', 'citation_key', 'bibtexkey', 'bibtex_key'],
	author: ['author', 'authors', 'creator', 'creators'],
	authorAffiliation: ['author_affiliation', 'authoraffiliation', 'affiliation', 'affiliations'],
	year: ['year', 'publication_year', 'publicationyear', 'published_year', 'publishedyear'],
	title: ['title'],
	journal: ['journal', 'journaltitle', 'journal_title', 'containertitle', 'container_title', 'publicationtitle', 'publication_title'],
	volume: ['volume'],
	issue: ['issue', 'number'],
	pages: ['pages', 'pagerange', 'page_range'],
	doi: ['doi'],
	publisher: ['publisher', 'press'],
	sourceUrl: ['source_url', 'sourceurl', 'url'],
	publicationType: ['publication_type', 'publicationtype', 'item_type', 'itemtype'],
	translator: ['translator', 'translators'],
	isbn: ['isbn'],
	edition: ['edition'],
	language: ['language', 'lang'],
	originalTitle: ['original_title', 'originaltitle', 'orig_title', 'origtitle'],
	originalDatePublished: ['original_date_published', 'originaldatepublished', 'original_date', 'originaldate', 'orig_date', 'origdate'],
	originalPublisher: ['original_publisher', 'originalpublisher', 'orig_publisher', 'origpublisher'],
	originalLanguage: ['original_language', 'originallanguage', 'orig_language', 'origlanguage'],
	forewordAuthor: ['forward_author', 'forwardauthor', 'foreword_author', 'forewordauthor', 'foreward_author', 'forewardauthor'],
	concepts: ['concepts', 'concept'],
};

const SUSPICIOUS_TITLE_PATTERN = /^(?:untitled|document|full[ -]?text|microsoft word\s*-|scan(?:ned)?\b)/i;
const SUSPICIOUS_AUTHOR_PATTERN = /^(?:unknown|anonymous|microsoft office user|administrator|admin)$/i;
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9<>]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarStrings(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap((item) => scalarStrings(item));
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		const text = String(value).replace(/\s+/g, ' ').trim();
		return text ? [text] : [];
	}
	if (isRecord(value)) {
		for (const key of ['x-default', 'default', 'value', 'name']) {
			const nested = scalarStrings(value[key]);
			if (nested.length) return nested;
		}
	}
	return [];
}

function normalizedRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toLowerCase(), entry]));
}

function firstValue(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const values = scalarStrings(record[key.toLowerCase()]);
		if (values.length) return values[0];
	}
	return '';
}

function allValues(record: Record<string, unknown>, keys: string[]): string[] {
	return keys.flatMap((key) => scalarStrings(record[key.toLowerCase()]));
}

function cleanTitle(value: string): string {
	const title = value.replace(/\s+/g, ' ').trim();
	if (!title || SUSPICIOUS_TITLE_PATTERN.test(title)) return '';
	return title;
}

function cleanAuthors(values: string[]): string[] {
	return values
		.flatMap((value) => value.split(/\s*(?:;|\s+and\s+|\s+&\s+)\s*/i))
		.map((value) => value.replace(/\s+/g, ' ').trim())
		.filter((value) => value && !SUSPICIOUS_AUTHOR_PATTERN.test(value));
}

function cleanKeywords(values: string[], splitCommas: boolean): string[] {
	const seen = new Set<string>();
	const keywords: string[] = [];
	for (const value of values) {
		const withoutLabel = value.replace(/^\s*(?:author\s+)?keywords?\s*:\s*/i, '').trim();
		const parts = /[;|\r\n]/.test(withoutLabel)
			? withoutLabel.split(/\s*(?:;|\||\r?\n)+\s*/)
			: splitCommas ? withoutLabel.split(/\s*,\s*/) : [withoutLabel];
		for (const part of parts) {
			const keyword = part.replace(/\s+/g, ' ').trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2').trim();
			if (!keyword || /^https?:\/\//i.test(keyword) || /^(?:doi\s*:\s*)?10\.\d{4,9}\//i.test(keyword)) continue;
			const normalized = keyword.toLocaleLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			keywords.push(keyword);
		}
	}
	return keywords;
}

function extractYear(value: string): string {
	const match = value.match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/);
	return match?.[1] ?? '';
}

interface CopyrightStatement {
	name: string;
	year: string;
	pageText: string;
}

function normalizedFrontMatterText(value: string): string {
	return value
		.normalize('NFKC')
		.replace(/\s+/g, ' ')
		.trim();
}

function frontMatterLines(pageText: string): string[] {
	return pageText
		.normalize('NFKC')
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter(Boolean);
}

function hasCopyrightPageContext(pageText: string): boolean {
	return /(?:©|\bcopyright\b|\bCIP\s+record\b|\bpublished\s+by\b)/iu.test(pageText);
}

function hasPublicationYearContext(pageText: string): boolean {
	return /(?:©|\bcopyright\b|\bISBN(?:-1[03])?\b|\bCIP\s+record\b)/iu.test(pageText);
}

function uniqueStrings(values: string[]): string[] {
	const unique = new Map<string, string>();
	for (const value of values) {
		const cleaned = value.replace(/\s+/g, ' ').trim();
		if (cleaned) unique.set(cleaned.toLocaleLowerCase(), cleaned);
	}
	return [...unique.values()];
}

function isLikelyPersonName(value: string): boolean {
	return value.length >= 3
		&& value.length <= 100
		&& /\p{L}/u.test(value)
		&& !/\d|\b(?:press|publishing|publishers?|university|ltd|limited|inc|llc|gmbh|foundation|society|company|corporation)\b/iu.test(value);
}

function copyrightStatements(pages: string[]): CopyrightStatement[] {
	const statements: CopyrightStatement[] = [];
	for (const pageText of pages) {
		const text = normalizedFrontMatterText(pageText);
		const pattern = /(?:\bcopyright\s*(?:©|\(c\))?|©|\(c\))\s*(?:by\s+)?([^,]{2,100}?),\s*((?:1[5-9]|20|21)\d{2})\b/giu;
		for (const line of frontMatterLines(pageText)) {
			for (const match of line.matchAll(pattern)) {
				const name = match[1].replace(/\s+/g, ' ').trim();
				if (isLikelyPersonName(name)) statements.push({ name, year: match[2], pageText: text });
			}
		}
	}
	return statements;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function copyrightNameIsExplicitAuthor(statement: CopyrightStatement): boolean {
	const name = escapeRegExp(statement.name);
	return new RegExp(`(?:the\\s+right\\s+of\\s+)?${name}\\s+to\\s+be\\s+identi(?:fied|\\s+fi\\s+ed)\\s+as\\s+the\\s+author\\b`, 'iu')
		.test(statement.pageText);
}

function validIsbn(value: string): boolean {
	if (/^\d{13}$/.test(value)) {
		const sum = [...value.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
		return (10 - (sum % 10)) % 10 === Number(value[12]);
	}
	if (!/^\d{9}[\dX]$/.test(value)) return false;
	const sum = [...value].reduce((total, digit, index) => {
		const numeric = digit === 'X' ? 10 : Number(digit);
		return total + numeric * (10 - index);
	}, 0);
	return sum % 11 === 0;
}

function labelledIsbns(pages: string[]): string[] {
	const isbns: string[] = [];
	for (const pageText of pages) {
		if (!hasCopyrightPageContext(pageText)) continue;
		for (const line of frontMatterLines(pageText)) {
			const labelIndex = line.search(/\bISBN(?:-1[03])?\b/i);
			if (labelIndex < 0) continue;
			const labelledText = line.slice(labelIndex);
			const tokens = labelledText.match(/\b(?:97[89](?:[\s-]*\d){10}|\d(?:[\s-]*\d){8}[\s-]*[\dX])\b/gi) ?? [];
			for (const token of tokens) {
				const normalized = token.replace(/[^0-9X]/gi, '').toUpperCase();
				if (validIsbn(normalized)) isbns.push(normalized);
			}
		}
	}
	return uniqueStrings(isbns);
}

function frontMatterPublishers(pages: string[]): string[] {
	const publishers: string[] = [];
	const legalSuffixPattern = /\b(?:Ltd|Limited|Inc\.?|LLC|GmbH|PLC|S\.?A\.?)\.?$/iu;
	const publishingNamePattern = /\b(?:University\s+Press|Press|Publishing|Publishers|Books)(?:\s+(?:Ltd|Limited|Inc\.?|LLC|GmbH|PLC|S\.?A\.?))?\.?$/iu;
	for (const pageText of pages) {
		const hasImprintContext = /(?:\bISBN(?:-1[03])?\b|\bCIP\s+record\b|©|\bcopyright\b)/iu.test(pageText);
		for (const line of frontMatterLines(pageText)) {
			const publishedBy = line.match(/^published\s+by\s+(.{2,100}?)\.?$/i)?.[1]?.trim();
			const looksLikePublisher = publishedBy
				&& /(?:\bUniversity\s+Press\b|\bPress\b|\bPublishing\b|\bPublishers?\b|\bBooks\b|\bHouse\b|\bGroup\b|\b(?:Ltd|Limited|Inc\.?|LLC|GmbH|PLC|S\.?A\.?)$)/iu.test(publishedBy);
			if (hasImprintContext && looksLikePublisher && !/[?!]|\b(?:https?|www\.|permission\s+of)\b/i.test(publishedBy)) {
				publishers.push(publishedBy.replace(/[.,;:]+$/, ''));
				continue;
			}
			if (!hasImprintContext || line.length < 3 || line.length > 100) continue;
			if (!publishingNamePattern.test(line)) continue;
			if (!/\bUniversity\s+Press\b/iu.test(line) && !legalSuffixPattern.test(line)) continue;
			if (/\b(?:is|are|was|were|publishing\s+new)\b/iu.test(line)) continue;
			publishers.push(line.replace(/\.$/, ''));
		}
	}
	return uniqueStrings(publishers);
}

function firstPublishedYears(pages: string[]): string[] {
	return uniqueStrings(pages.flatMap((pageText) => {
		if (!hasPublicationYearContext(pageText)) return [];
		return frontMatterLines(pageText).flatMap((line) => {
			const match = line.match(/^first\s+published(?:\s+in)?\s*[:,-]?\s*((?:1[5-9]|20|21)\d{2})\b/iu);
			return match ? [match[1]] : [];
		});
	}));
}

function normalizeUrl(value: string): string {
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
	} catch {
		return '';
	}
}

export function normalizeDoi(value: string): string {
	const decoded = value
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
		.replace(/^doi\s*:\s*/i, '')
		.trim();
	const match = decoded.match(DOI_PATTERN)?.[0] ?? '';
	let normalized = match.replace(/[\s\u00a0]+/g, '').replace(/[.,;:]+$/g, '');
	for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
		while (normalized.endsWith(closing)
			&& normalized.split(closing).length > normalized.split(opening).length) {
			normalized = normalized.slice(0, -1);
		}
	}
	return normalized;
}

function uniqueDois(values: string[]): string[] {
	return Array.from(new Set(values.flatMap((value) => {
		const matches = value.match(DOI_PATTERN) ?? [];
		return matches.map((match) => normalizeDoi(match)).filter(Boolean);
	})));
}

function pageRange(start: string, end: string): string {
	if (start && end) return start === end ? start : `${start}–${end}`;
	return start || end;
}

function itemTypeLabel(itemType: string): string {
	const labels: Record<string, string> = {
		journalarticle: 'Journal article',
		book: 'Book',
		booksection: 'Book chapter',
		conferencepaper: 'Conference paper',
		thesis: 'Thesis',
		report: 'Report',
		webpage: 'Web page',
	};
	return labels[itemType.replace(/[\s_-]+/g, '').toLowerCase()] ?? itemType.trim();
}

function normalizeLabeledMetadataKey(value: string): string {
	return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseLabeledCreatorNames(value: string): string[] {
	return value
		.split(/\s*;\s*/)
		.map((name) => {
			const [familyName, givenName, ...rest] = name.split(/\s*\|\|\s*/);
			if (givenName !== undefined && rest.length === 0) return `${givenName} ${familyName}`.trim();
			return name.trim();
		})
		.filter(Boolean);
}

export function parseTranslatedBookExtraMetadata(extra: string): TranslatedBookExtraMetadata {
	const values = new Map<string, string[]>();
	for (const line of extra.split(/\r?\n/)) {
		const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
		if (!match) continue;
		const key = normalizeLabeledMetadataKey(match[1]);
		values.set(key, [...(values.get(key) ?? []), match[2].trim()]);
	}
	const all = (...keys: string[]) => keys.flatMap((key) => values.get(key) ?? []);
	const first = (...keys: string[]) => all(...keys).find(Boolean) ?? '';
	return {
		originalTitle: first('original title'),
		originalDatePublished: first('original date', 'original publication date', 'original date published'),
		originalPublisher: first('original publisher'),
		originalLanguage: first('original language'),
		forewordAuthors: all('foreword author', 'foreword by', 'forward author', 'forward by')
			.flatMap((value) => parseLabeledCreatorNames(value)),
	};
}

export function makeReadingNoteCandidate(
	field: ReadingNoteMetadataField,
	value: ReadingNoteMetadataValue,
	source: ReadingNoteMetadataSource,
	confidence: ReadingNoteMetadataConfidence,
	evidence?: string,
): ReadingNoteMetadataCandidate | null {
	if (typeof value === 'string' && !value.trim()) return null;
	if (Array.isArray(value) && !value.some((item) => item.trim())) return null;
	return { field, value, source, confidence, evidence };
}

function setCandidate(
	candidates: ReadingNoteMetadataCandidates,
	field: ReadingNoteMetadataField,
	value: ReadingNoteMetadataValue,
	source: ReadingNoteMetadataSource,
	confidence: ReadingNoteMetadataConfidence,
	evidence?: string,
): void {
	if (candidates[field]) return;
	const candidate = makeReadingNoteCandidate(field, value, source, confidence, evidence);
	if (candidate) candidates[field] = candidate;
}

export function extractEmbeddedPdfMetadata(input: EmbeddedPdfMetadataInput): ReadingNoteMetadataCandidates {
	const candidates: ReadingNoteMetadataCandidates = {};
	const info = normalizedRecord(input.info);
	const custom = normalizedRecord(info.custom);
	const xmp = normalizedRecord(input.xmp);
	const xmpKeywords = cleanKeywords([
		...cleanKeywords(allValues(xmp, ['dc:subject']), false),
		...cleanKeywords(allValues(xmp, [
			'pdf:keywords', 'xmp:keywords', 'prism:keyword', 'prism:keywords', 'citation_keywords',
		]), true),
	], false);
	const customKeywords = cleanKeywords(allValues(custom, ['keywords', 'keyword', 'author_keywords', 'subject_keywords']), true);
	const infoKeywords = cleanKeywords(allValues(info, ['keywords']), true);
	if (xmpKeywords.length) setCandidate(candidates, 'concepts', xmpKeywords, 'xmp', 'high');
	else if (infoKeywords.length) setCandidate(candidates, 'concepts', infoKeywords, 'pdf-info', 'high');
	else if (customKeywords.length) setCandidate(candidates, 'concepts', customKeywords, 'pdf-custom', 'high');

	const xmpTitle = cleanTitle(firstValue(xmp, ['dc:title', 'prism:title', 'citation_title']));
	setCandidate(candidates, 'title', xmpTitle, 'xmp', 'high');

	const xmpAuthors = cleanAuthors(allValues(xmp, ['dc:creator', 'prism:creator', 'citation_author']));
	setCandidate(candidates, 'author', xmpAuthors.join('; '), 'xmp', 'high');

	const publicationDate = firstValue(xmp, ['prism:publicationdate', 'prism:coverdate', 'citation_publication_date']);
	setCandidate(candidates, 'year', extractYear(publicationDate), 'xmp', 'high', publicationDate);

	setCandidate(candidates, 'journal', firstValue(xmp, ['prism:publicationname', 'citation_journal_title']), 'xmp', 'high');
	setCandidate(candidates, 'volume', firstValue(xmp, ['prism:volume', 'citation_volume']), 'xmp', 'high');
	setCandidate(candidates, 'issue', firstValue(xmp, ['prism:number', 'prism:issueidentifier', 'citation_issue']), 'xmp', 'high');
	const xmpPages = firstValue(xmp, ['prism:pagerange', 'citation_pages']) || pageRange(
		firstValue(xmp, ['prism:startingpage', 'citation_firstpage']),
		firstValue(xmp, ['prism:endingpage', 'citation_lastpage']),
	);
	setCandidate(candidates, 'pages', xmpPages, 'xmp', 'high');
	setCandidate(candidates, 'publisher', firstValue(xmp, ['dc:publisher', 'prism:publisher']), 'xmp', 'high');
	setCandidate(candidates, 'authorAffiliation', firstValue(xmp, ['prism:corporateauthor', 'citation_author_institution', 'author_affiliation']), 'xmp', 'review');
	setCandidate(candidates, 'citekey', firstValue(xmp, ['bibtex:citekey', 'citation_key', 'citekey']), 'xmp', 'exact');
	setCandidate(candidates, 'publicationType', firstValue(xmp, ['prism:contenttype', 'prism:aggregationtype']), 'xmp', 'review');
	setCandidate(candidates, 'translator', cleanAuthors(allValues(xmp, ['translator', 'dc:contributor'])).join('; '), 'xmp', 'review');
	setCandidate(candidates, 'isbn', firstValue(xmp, ['prism:isbn', 'isbn']), 'xmp', 'high');
	setCandidate(candidates, 'edition', firstValue(xmp, ['edition']), 'xmp', 'high');
	setCandidate(candidates, 'language', firstValue(xmp, ['dc:language']), 'xmp', 'high');
	setCandidate(candidates, 'originalTitle', firstValue(xmp, [
		'original_title', 'originaltitle', 'origtitle', 'biblatex:origtitle', 'citation_original_title',
	]), 'xmp', 'high');
	setCandidate(candidates, 'originalDatePublished', firstValue(xmp, [
		'original_date_published', 'originaldatepublished', 'original_date', 'originaldate', 'origdate',
		'biblatex:origdate', 'citation_original_date',
	]), 'xmp', 'high');
	setCandidate(candidates, 'originalPublisher', firstValue(xmp, [
		'original_publisher', 'originalpublisher', 'origpublisher', 'biblatex:origpublisher',
	]), 'xmp', 'high');
	setCandidate(candidates, 'originalLanguage', firstValue(xmp, [
		'original_language', 'originallanguage', 'origlanguage', 'biblatex:origlanguage',
	]), 'xmp', 'review');
	setCandidate(candidates, 'forewordAuthor', cleanAuthors(allValues(xmp, [
		'foreword_author', 'forewordauthor', 'forward_author', 'forwardauthor',
	])).join('; '), 'xmp', 'review');

	const xmpDoiValues = allValues(xmp, ['prism:doi', 'dc:identifier', 'citation_doi']);
	const xmpDois = uniqueDois(xmpDoiValues);
	if (xmpDois.length === 1) setCandidate(candidates, 'doi', xmpDois[0], 'xmp', 'exact');

	const sourceUrl = allValues(xmp, ['prism:url', 'dc:source', 'citation_pdf_url', 'citation_abstract_html_url'])
		.map((value) => normalizeUrl(value))
		.find((value) => value && !/^https?:\/\/(?:dx\.)?doi\.org\//i.test(value)) ?? '';
	setCandidate(candidates, 'sourceUrl', sourceUrl, 'xmp', 'high');

	setCandidate(candidates, 'title', cleanTitle(firstValue(info, ['title'])), 'pdf-info', 'high');
	setCandidate(candidates, 'author', cleanAuthors(allValues(info, ['author'])).join('; '), 'pdf-info', 'high');

	setCandidate(candidates, 'citekey', firstValue(custom, ['citekey', 'citationkey', 'citation_key', 'bibtexkey']), 'pdf-custom', 'exact');
	setCandidate(candidates, 'authorAffiliation', firstValue(custom, ['authoraffiliation', 'author_affiliation', 'affiliation']), 'pdf-custom', 'review');
	setCandidate(candidates, 'journal', firstValue(custom, ['journal', 'journaltitle', 'publicationtitle']), 'pdf-custom', 'high');
	setCandidate(candidates, 'volume', firstValue(custom, ['volume']), 'pdf-custom', 'high');
	setCandidate(candidates, 'issue', firstValue(custom, ['issue', 'number']), 'pdf-custom', 'high');
	setCandidate(candidates, 'pages', firstValue(custom, ['pages', 'pagerange']), 'pdf-custom', 'high');
	setCandidate(candidates, 'publisher', firstValue(custom, ['publisher']), 'pdf-custom', 'high');
	setCandidate(candidates, 'sourceUrl', normalizeUrl(firstValue(custom, ['sourceurl', 'source_url', 'url'])), 'pdf-custom', 'high');
	setCandidate(candidates, 'publicationType', firstValue(custom, ['publicationtype', 'publication_type', 'itemtype']), 'pdf-custom', 'review');
	setCandidate(candidates, 'translator', firstValue(custom, ['translator', 'translators']), 'pdf-custom', 'high');
	setCandidate(candidates, 'isbn', firstValue(custom, ['isbn']), 'pdf-custom', 'high');
	setCandidate(candidates, 'edition', firstValue(custom, ['edition']), 'pdf-custom', 'high');
	setCandidate(candidates, 'language', firstValue(custom, ['language']), 'pdf-custom', 'high');
	setCandidate(candidates, 'originalTitle', firstValue(custom, [
		'originaltitle', 'original_title', 'origtitle', 'orig_title',
	]), 'pdf-custom', 'high');
	setCandidate(candidates, 'originalDatePublished', firstValue(custom, [
		'originaldatepublished', 'original_date_published', 'originaldate', 'original_date', 'origdate', 'orig_date',
	]), 'pdf-custom', 'high');
	setCandidate(candidates, 'originalPublisher', firstValue(custom, [
		'originalpublisher', 'original_publisher', 'origpublisher', 'orig_publisher',
	]), 'pdf-custom', 'high');
	setCandidate(candidates, 'originalLanguage', firstValue(custom, [
		'originallanguage', 'original_language', 'origlanguage', 'orig_language',
	]), 'pdf-custom', 'review');
	setCandidate(candidates, 'forewordAuthor', cleanAuthors(allValues(custom, [
		'forewordauthor', 'foreword_author', 'forwardauthor', 'forward_author',
	])).join('; '), 'pdf-custom', 'review');

	const customPublicationDate = firstValue(custom, ['publicationdate', 'publication_date', 'published', 'issued', 'year']);
	setCandidate(candidates, 'year', extractYear(customPublicationDate), 'pdf-custom', 'high', customPublicationDate);

	const frontMatterPages = input.frontMatterPages?.length
		? input.frontMatterPages
		: input.firstPageText ? [input.firstPageText] : [];
	const isbns = labelledIsbns(frontMatterPages);
	const hasBookFrontMatter = isbns.length > 0
		|| frontMatterPages.some((pageText) => /\bCIP\s+record\s+for\s+this\s+book\b/iu.test(pageText));
	if (hasBookFrontMatter) {
		const copyrights = copyrightStatements(frontMatterPages);
		const explicitAuthors = uniqueStrings(copyrights
			.filter((statement) => copyrightNameIsExplicitAuthor(statement))
			.map((statement) => statement.name));
		if (explicitAuthors.length === 1) {
			setCandidate(candidates, 'author', explicitAuthors[0], 'front-matter', 'high', 'Copyright-page author assertion');
		} else if (!explicitAuthors.length) {
			const copyrightNames = uniqueStrings(copyrights.map((statement) => statement.name));
			if (copyrightNames.length === 1) {
				setCandidate(candidates, 'author', copyrightNames[0], 'front-matter', 'review', 'Copyright holder');
			}
		}

		const publicationYears = firstPublishedYears(frontMatterPages);
		if (publicationYears.length === 1) {
			setCandidate(candidates, 'year', publicationYears[0], 'front-matter', 'high', 'First published');
		} else if (!publicationYears.length) {
			const copyrightYears = uniqueStrings(copyrights.map((statement) => statement.year));
			if (copyrightYears.length === 1) {
				setCandidate(candidates, 'year', copyrightYears[0], 'front-matter', 'review', 'Copyright year');
			}
		}

		const publishers = frontMatterPublishers(frontMatterPages);
		if (publishers.length === 1) {
			setCandidate(candidates, 'publisher', publishers[0], 'front-matter', 'high', 'Copyright-page imprint');
		}
	}

	if (isbns.length === 1) {
		setCandidate(candidates, 'isbn', isbns[0], 'front-matter', 'high', 'Labelled ISBN');
	}

	const infoDoiValues = [
		...allValues(custom, ['doi']),
		...allValues(info, ['subject', 'keywords']),
	];
	const infoDois = uniqueDois(infoDoiValues);
	if (infoDois.length === 1) setCandidate(candidates, 'doi', infoDois[0], 'pdf-custom', 'exact');

	const firstPageDois = uniqueDois([input.firstPageText ?? frontMatterPages[0] ?? '']);
	if (firstPageDois.length === 1) setCandidate(candidates, 'doi', firstPageDois[0], 'first-page', 'high');

	setCandidate(candidates, 'title', cleanTitle(input.fileBasename), 'filename', 'review');
	return candidates;
}

export function getReferenceMetadataConfidence(
	record: ReferenceMetadataInput,
	embedded: ReadingNoteMetadataCandidates,
): ReadingNoteMetadataConfidence {
	const recordDoi = normalizeDoi(record.doi ?? '');
	const embeddedDoi = embedded.doi ? normalizeDoi(String(embedded.doi.value)) : '';
	if (recordDoi && embeddedDoi) return recordDoi === embeddedDoi ? 'exact' : 'review';

	const normalizeIsbn = (value: string) => value.replace(/[^0-9X]/gi, '').toUpperCase();
	const recordIsbn = normalizeIsbn(record.isbn ?? '');
	const embeddedIsbn = embedded.isbn ? normalizeIsbn(String(embedded.isbn.value)) : '';
	if (recordIsbn && embeddedIsbn) return recordIsbn === embeddedIsbn ? 'exact' : 'review';

	const embeddedTitle = embedded.title;
	if (embeddedTitle && embeddedTitle.source !== 'filename') {
		const normalizeTitle = (value: string) => value
			.normalize('NFKC')
			.toLocaleLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim();
		const recordTitle = normalizeTitle(record.title ?? '');
		const pdfTitle = normalizeTitle(String(embeddedTitle.value));
		if (recordTitle.length >= 12 && recordTitle === pdfTitle) return 'high';
	}

	return 'review';
}

export function candidatesFromReferenceMetadata(
	record: ReferenceMetadataInput,
	confidence: ReadingNoteMetadataConfidence = 'exact',
): ReadingNoteMetadataCandidates {
	const candidates: ReadingNoteMetadataCandidates = {};
	setCandidate(candidates, 'citekey', record.citekey ?? '', 'zotero', confidence);
	setCandidate(candidates, 'author', cleanAuthors(record.authors ?? []).join('; '), 'zotero', confidence);
	setCandidate(candidates, 'translator', cleanAuthors(record.translators ?? []).join('; '), 'zotero', confidence);
	setCandidate(candidates, 'year', record.year ?? '', 'zotero', confidence);
	setCandidate(candidates, 'title', cleanTitle(record.title ?? ''), 'zotero', confidence);
	setCandidate(candidates, 'journal', record.journal ?? '', 'zotero', confidence);
	setCandidate(candidates, 'volume', record.volume ?? '', 'zotero', confidence);
	setCandidate(candidates, 'issue', record.issue ?? '', 'zotero', confidence);
	setCandidate(candidates, 'pages', record.pages ?? '', 'zotero', confidence);
	setCandidate(candidates, 'doi', normalizeDoi(record.doi ?? ''), 'zotero', confidence);
	setCandidate(candidates, 'publisher', record.publisher ?? '', 'zotero', confidence);
	setCandidate(candidates, 'sourceUrl', normalizeUrl(record.url ?? ''), 'zotero', confidence);
	setCandidate(candidates, 'publicationType', itemTypeLabel(record.itemType ?? ''), 'zotero', confidence);
	setCandidate(candidates, 'isbn', record.isbn ?? '', 'zotero', confidence);
	setCandidate(candidates, 'edition', record.edition ?? '', 'zotero', confidence);
	setCandidate(candidates, 'language', record.language ?? '', 'zotero', confidence);
	setCandidate(candidates, 'originalTitle', record.originalTitle ?? '', 'zotero', confidence);
	setCandidate(candidates, 'originalDatePublished', record.originalDatePublished ?? '', 'zotero', confidence);
	setCandidate(candidates, 'originalPublisher', record.originalPublisher ?? '', 'zotero', confidence);
	setCandidate(candidates, 'originalLanguage', record.originalLanguage ?? '', 'zotero', 'review');
	setCandidate(candidates, 'forewordAuthor', cleanAuthors(record.forewordAuthors ?? []).join('; '), 'zotero', 'review');
	return candidates;
}

export function mergeReadingNoteCandidates(...sources: ReadingNoteMetadataCandidates[]): ReadingNoteMetadataCandidates {
	const merged: ReadingNoteMetadataCandidates = {};
	const confidenceRank: Record<ReadingNoteMetadataConfidence, number> = { review: 1, high: 2, exact: 3 };
	for (const source of sources) {
		for (const field of Object.keys(source) as ReadingNoteMetadataField[]) {
			const candidate = source[field];
			if (!candidate) continue;
			const current = merged[field];
			if (!current || confidenceRank[candidate.confidence] > confidenceRank[current.confidence]) {
				merged[field] = candidate;
			}
		}
	}
	return merged;
}

export function isBlankFrontmatterValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return !value.trim();
	if (Array.isArray(value)) return value.length === 0 || value.every((item) => isBlankFrontmatterValue(item));
	return false;
}

export function normalizedReadingNotePropertyKey(value: string): string {
	return value.toLowerCase().replace(/[\s-]+/g, '_');
}

export function isReadingNoteMetadataProperty(field: ReadingNoteMetadataField, property: string): boolean {
	const normalizedProperty = normalizedReadingNotePropertyKey(property);
	return FIELD_ALIASES[field].some((alias) => normalizedReadingNotePropertyKey(alias) === normalizedProperty);
}

export function buildReadingNoteMetadataProposals(
	frontmatter: Record<string, unknown>,
	candidates: ReadingNoteMetadataCandidates,
): ReadingNoteMetadataProposal[] {
	const proposals: ReadingNoteMetadataProposal[] = [];
	const entries = Object.entries(frontmatter);

	for (const field of Object.keys(FIELD_ALIASES) as ReadingNoteMetadataField[]) {
		const candidate = candidates[field];
		if (!candidate) continue;
		const matchingProperties = entries.filter(([key]) => isReadingNoteMetadataProperty(field, key));
		if (matchingProperties.length !== 1) continue;
		const [property, currentValue] = matchingProperties[0];
		if (!isBlankFrontmatterValue(currentValue)) continue;
		proposals.push({ ...candidate, property });
	}

	return proposals;
}

export function formatReadingNoteMetadataValue(value: ReadingNoteMetadataValue): string {
	return Array.isArray(value) ? value.join('; ') : String(value);
}
