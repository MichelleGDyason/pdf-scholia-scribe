export type AnnotationProvider = 'kindle' | 'apple-books' | 'apple-preview';

export type ImportedAnnotationType =
	| 'highlight'
	| 'underline'
	| 'strikeout'
	| 'squiggly'
	| 'note'
	| 'text'
	| 'ink'
	| 'shape'
	| 'stamp'
	| 'bookmark'
	| 'unknown';

export interface ImportedAnnotation {
	provider: AnnotationProvider;
	documentId: string;
	annotationId: string;
	sourceAnnotationId: string;
	type: ImportedAnnotationType;
	text: string;
	comment: string;
	color: string;
	colorLabel: string;
	page: number | null;
	pageLabel: string;
	locationStart: number | null;
	locationEnd: number | null;
	locationLabel: string;
	createdAt: string;
	modifiedAt: string;
	author: string;
	sourceLink: string;
	sourcePath: string;
	rawMetadata: string;
}

export interface AnnotationDocument {
	provider: AnnotationProvider;
	documentId: string;
	title: string;
	author: string;
	sourcePath: string;
	annotations: ImportedAnnotation[];
	warnings: string[];
}

type ParsedEntry = {
	title: string;
	author: string;
	type: ImportedAnnotationType;
	text: string;
	comment: string;
	color: string;
	colorLabel: string;
	page: number | null;
	pageLabel: string;
	locationStart: number | null;
	locationEnd: number | null;
	locationLabel: string;
	createdAt: string;
	modifiedAt: string;
	sourceLink: string;
	rawMetadata: string;
	warning: string;
};

const KINDLE_SEPARATOR = /^\s*={8,}\s*$/m;
const APPLE_BOOKS_SEPARATOR = /^\s*(?:={6,}|-{6,})\s*$/m;

function normalizeNewlines(value: string) {
	return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function normalizedIdentityPart(value: string) {
	return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function fallbackHash(value: string) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Returns a short, deterministic identifier without including source text in managed markers. */
export async function stableImportId(value: string) {
	const normalized = normalizedIdentityPart(value);
	const cryptoApi = typeof crypto === 'undefined' ? undefined : crypto;
	if (cryptoApi?.subtle) {
		const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
		return Array.from(new Uint8Array(digest).slice(0, 12))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
	}
	return fallbackHash(normalized);
}

/** Hashes imported file bytes so renamed copies refresh the same managed document section. */
export async function stableImportIdFromBytes(value: ArrayBuffer) {
	const cryptoApi = typeof crypto === 'undefined' ? undefined : crypto;
	if (cryptoApi?.subtle) {
		const digest = await cryptoApi.subtle.digest('SHA-256', value);
		return Array.from(new Uint8Array(digest).slice(0, 12))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
	}
	let hash = 0x811c9dc5;
	for (const byte of new Uint8Array(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseTitleAndAuthor(value: string) {
	const line = value.trim();
	const match = /^(.*?)\s+\(([^()]*)\)\s*$/.exec(line);
	if (!match) return { title: line, author: '' };
	return { title: match[1].trim(), author: match[2].trim() };
}

function parseKindleType(metadata: string): ImportedAnnotationType {
	if (/\bhighlight\b/i.test(metadata)) return 'highlight';
	if (/\bnote\b/i.test(metadata)) return 'note';
	if (/\bbookmark\b/i.test(metadata)) return 'bookmark';
	return 'unknown';
}

function parseNumber(value: string | undefined) {
	if (!value) return null;
	const parsed = Number.parseInt(value.replace(/[^\d]/g, ''), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function kindleLocatorKey(entry: ParsedEntry) {
	if (entry.locationStart !== null) return `location:${entry.locationStart}-${entry.locationEnd ?? entry.locationStart}`;
	if (entry.pageLabel) return `page:${normalizedIdentityPart(entry.pageLabel)}`;
	return '';
}

function emptyParsedEntry(): ParsedEntry {
	return {
		title: '',
		author: '',
		type: 'unknown',
		text: '',
		comment: '',
		color: '',
		colorLabel: '',
		page: null,
		pageLabel: '',
		locationStart: null,
		locationEnd: null,
		locationLabel: '',
		createdAt: '',
		modifiedAt: '',
		sourceLink: '',
		rawMetadata: '',
		warning: '',
	};
}

function parseKindleEntry(block: string): ParsedEntry | null {
	const lines = normalizeNewlines(block).split('\n');
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	if (lines.length < 2) return null;

	const titleAndAuthor = parseTitleAndAuthor(lines[0]);
	const metadataIndex = lines.findIndex((line, index) => index > 0 && /^\s*-\s*/.test(line));
	if (metadataIndex < 0) return null;
	const metadata = lines[metadataIndex].replace(/^\s*-\s*/, '').trim();
	const text = lines.slice(metadataIndex + 1).join('\n').trim();
	const type = parseKindleType(metadata);
	const pageMatch = /\bpage\s+([^|]+)/i.exec(metadata);
	const locationMatch = /\blocation\s+([\d,.]+)(?:\s*[-–]\s*([\d,.]+))?/i.exec(metadata);
	const dateMatch = /\bAdded\s+on\s+(.+)$/i.exec(metadata);
	const pageLabel = pageMatch?.[1].trim() ?? '';
	const locationStart = parseNumber(locationMatch?.[1]);
	const locationEnd = parseNumber(locationMatch?.[2]) ?? locationStart;
	const locationLabel = locationStart === null
		? ''
		: locationEnd !== null && locationEnd !== locationStart
			? `${locationStart}-${locationEnd}`
			: locationStart.toString();

	return {
		...emptyParsedEntry(),
		...titleAndAuthor,
		type,
		text,
		page: parseNumber(pageLabel),
		pageLabel,
		locationStart,
		locationEnd,
		locationLabel,
		createdAt: dateMatch?.[1].trim() ?? '',
		rawMetadata: metadata,
		warning: type === 'unknown'
			? 'An entry type was not recognised, possibly because the export uses a language Scholia does not yet parse.'
			: '',
	};
}

function dedupeParsedEntries(entries: ParsedEntry[]) {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = [
			entry.type,
			entry.rawMetadata,
			entry.text,
			entry.comment,
			entry.pageLabel,
			entry.locationLabel,
		].map(normalizedIdentityPart).join('\u241f');
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function pairKindleNotes(entries: ParsedEntry[]) {
	const consumed = new Set<number>();
	for (let index = 0; index < entries.length; index++) {
		const note = entries[index];
		if (note.type !== 'note' || !note.text) continue;
		const locator = kindleLocatorKey(note);
		if (!locator) continue;
		const candidates = [index - 1, index + 1];
		const highlightIndex = candidates.find((candidate) => {
			const entry = entries[candidate];
			return entry?.type === 'highlight' && kindleLocatorKey(entry) === locator;
		});
		if (highlightIndex === undefined) continue;
		const highlight = entries[highlightIndex];
		highlight.comment = [highlight.comment, note.text].filter(Boolean).join('\n\n');
		consumed.add(index);
	}
	return entries.filter((_entry, index) => !consumed.has(index));
}

async function buildDocuments(provider: AnnotationProvider, sourcePath: string, entries: ParsedEntry[]) {
	const grouped = new Map<string, ParsedEntry[]>();
	for (const entry of entries) {
		const key = [entry.title || sourcePath, entry.author].map(normalizedIdentityPart).join('\u241f');
		const group = grouped.get(key) ?? [];
		group.push(entry);
		grouped.set(key, group);
	}

	const documents: AnnotationDocument[] = [];
	for (const group of grouped.values()) {
		const first = group[0];
		const title = first.title || sourcePath.replace(/\.[^.]+$/, '') || 'Untitled document';
		const documentId = await stableImportId(`${provider}\u241f${title}\u241f${first.author}`);
		const annotations: ImportedAnnotation[] = [];
		for (const entry of group) {
			const annotationId = await stableImportId([
				provider,
				documentId,
				entry.type,
				entry.rawMetadata,
				entry.text,
				entry.comment,
			].join('\u241f'));
			annotations.push({
				provider,
				documentId,
				annotationId,
				sourceAnnotationId: '',
				type: entry.type,
				text: entry.text,
				comment: entry.comment,
				color: entry.color,
				colorLabel: entry.colorLabel,
				page: entry.page,
				pageLabel: entry.pageLabel,
				locationStart: entry.locationStart,
				locationEnd: entry.locationEnd,
				locationLabel: entry.locationLabel,
				createdAt: entry.createdAt,
				modifiedAt: entry.modifiedAt,
				author: entry.author,
				sourceLink: entry.sourceLink,
				sourcePath,
				rawMetadata: entry.rawMetadata,
			});
		}
		documents.push({
			provider,
			documentId,
			title,
			author: first.author,
			sourcePath,
			annotations,
			warnings: Array.from(new Set(group.map((entry) => entry.warning).filter(Boolean))),
		});
	}
	return documents;
}

/** Parses a Kindle `My Clippings.txt` export without accessing an Amazon account. */
export async function parseKindleClippings(text: string, sourcePath = 'My Clippings.txt') {
	const blocks = normalizeNewlines(text).split(KINDLE_SEPARATOR);
	const parsed = blocks.map(parseKindleEntry).filter((entry): entry is ParsedEntry => entry !== null);
	const byDocument = new Map<string, ParsedEntry[]>();
	for (const entry of parsed) {
		const key = [entry.title, entry.author].map(normalizedIdentityPart).join('\u241f');
		const group = byDocument.get(key) ?? [];
		group.push(entry);
		byDocument.set(key, group);
	}
	const prepared = Array.from(byDocument.values())
		.flatMap((entries) => pairKindleNotes(dedupeParsedEntries(entries)));
	return buildDocuments('kindle', sourcePath, prepared);
}

const HTML_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeHtmlEntities(value: string) {
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] === '#') {
			const radix = entity[1].toLowerCase() === 'x' ? 16 : 10;
			const number = Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix);
			return Number.isFinite(number) ? String.fromCodePoint(number) : match;
		}
		return HTML_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

export function appleBooksExportToText(value: string) {
	const normalized = normalizeNewlines(value);
	if (!/<[a-z][\s\S]*>/i.test(normalized)) return normalized;
	return decodeHtmlEntities(normalized
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
		.replace(/<\s*(?:br|hr)\b[^>]*>/gi, '\n')
		.replace(/<\/(?:p|div|li|blockquote|h[1-6])\s*>/gi, '\n\n')
		.replace(/<[^>]+>/g, ''))
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function stripWrappingQuote(value: string) {
	const trimmed = value.trim();
	const pairs: [string, string][] = [['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]];
	for (const [start, end] of pairs) {
		if (trimmed.startsWith(start) && trimmed.endsWith(end) && trimmed.length > start.length + end.length) {
			return trimmed.slice(start.length, -end.length).trim();
		}
	}
	return trimmed;
}

function labelledValue(lines: string[], labels: string[]) {
	const expression = new RegExp(`^(?:${labels.join('|')})\\s*:\\s*(.+)$`, 'i');
	for (const line of lines) {
		const match = expression.exec(line.trim());
		if (match) return match[1].trim();
	}
	return '';
}

function parseAppleBooksBlock(block: string, fallbackTitle: string): ParsedEntry | null {
	const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
	if (!lines.length) return null;
	const title = labelledValue(lines, ['book', 'title']) || fallbackTitle;
	const author = labelledValue(lines, ['author', 'by']);
	const note = labelledValue(lines, ['note', 'comment']);
	const colorLabel = labelledValue(lines, ['color', 'colour']);
	const pageLabel = labelledValue(lines, ['page']);
	const locationLabel = labelledValue(lines, ['location']);
	const chapter = labelledValue(lines, ['chapter']);
	const date = labelledValue(lines, ['date', 'added']);
	const explicitHighlight = labelledValue(lines, ['highlight', 'quote', 'text']);
	const labelled = /^(?:book|title|author|by|note|comment|colou?r|page|location|chapter|date|added|highlight|quote|text)\s*:/i;
	const unlabelled = lines.filter((line) => !labelled.test(line));
	const text = stripWrappingQuote(explicitHighlight || unlabelled.join('\n'));
	if (!text && !note) return null;
	const locationMatch = /([\d,.]+)(?:\s*[-–]\s*([\d,.]+))?/.exec(locationLabel);
	const rawMetadata = [
		pageLabel ? `Page: ${pageLabel}` : '',
		locationLabel ? `Location: ${locationLabel}` : '',
		chapter ? `Chapter: ${chapter}` : '',
		date ? `Date: ${date}` : '',
		colorLabel ? `Colour: ${colorLabel}` : '',
	].filter(Boolean).join(' | ');
	return {
		...emptyParsedEntry(),
		title,
		author,
		type: text ? 'highlight' : 'note',
		text,
		comment: note,
		colorLabel,
		page: parseNumber(pageLabel),
		pageLabel,
		locationStart: parseNumber(locationMatch?.[1]),
		locationEnd: parseNumber(locationMatch?.[2]) ?? parseNumber(locationMatch?.[1]),
		locationLabel,
		createdAt: date,
		rawMetadata,
		warning: rawMetadata || explicitHighlight || note
			? ''
			: 'Apple Books shared text had no labelled metadata; Scholia preserved the text using the file name as its document title.',
	};
}

function parseAppleExcerpt(text: string, fallbackTitle: string): ParsedEntry | null {
	const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
	const excerptIndex = lines.findIndex((line) => /^Excerpt From$/i.test(line));
	if (excerptIndex < 1) return null;
	const quote = lines.slice(0, excerptIndex).join('\n');
	const title = lines[excerptIndex + 1] || fallbackTitle;
	const author = lines[excerptIndex + 2] && !/copyright/i.test(lines[excerptIndex + 2])
		? lines[excerptIndex + 2]
		: '';
	return {
		...emptyParsedEntry(),
		title,
		author,
		type: 'highlight',
		text: stripWrappingQuote(quote),
		rawMetadata: 'Apple Books shared excerpt',
	};
}

/** Parses pasted/shared Apple Books text or HTML. PDFs are handled by the common PDF adapter. */
export async function parseAppleBooksExport(value: string, sourcePath = 'Apple Books shared text') {
	const text = appleBooksExportToText(value);
	const fallbackTitle = sourcePath.replace(/\.(?:html?|txt)$/i, '') || 'Apple Books';
	const excerpt = parseAppleExcerpt(text, fallbackTitle);
	const separated = text.split(APPLE_BOOKS_SEPARATOR);
	const sections = separated.length > 1
		? separated
		: (() => {
			const lines = text.split('\n');
			const highlightStarts = lines
				.map((line, index) => /^(?:highlight|quote|text)\s*:/i.test(line.trim()) ? index : -1)
				.filter((index) => index >= 0);
			if (highlightStarts.length > 1) {
				const header = lines.slice(0, highlightStarts[0]);
				return highlightStarts.map((start, index) => [
					...header,
					...lines.slice(start, highlightStarts[index + 1]),
				].join('\n'));
			}
			const starts = lines
				.map((line, index) => /^(?:book|title)\s*:/i.test(line.trim()) ? index : -1)
				.filter((index) => index >= 0);
			if (starts.length < 2) return [text];
			return starts.map((start, index) => lines.slice(start, starts[index + 1]).join('\n'));
		})();
	const globalLines = text.split('\n').map((line) => line.trim()).filter(Boolean);
	const globalTitle = labelledValue(globalLines, ['book', 'title']) || fallbackTitle;
	const globalAuthor = labelledValue(globalLines, ['author', 'by']);
	const blocks = excerpt
		? [excerpt]
		: sections
			.map((block) => parseAppleBooksBlock(block, globalTitle))
			.filter((entry): entry is ParsedEntry => entry !== null);
	for (const block of blocks) {
		if (!block.author) block.author = globalAuthor;
	}
	return buildDocuments('apple-books', sourcePath, dedupeParsedEntries(blocks));
}
