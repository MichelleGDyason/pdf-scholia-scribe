import { EditorPosition, MarkdownView, Notice, Platform, TFile, getLinkpath, requestUrl } from 'obsidian';

import { PDFPlusLibSubmodule } from './submodule';


export type ScholiaCitationStyle = 'asa' | 'harvard' | 'apa' | 'numeric';
export type ScholiaCitationTextMode = 'default' | 'year-only';
export type ScholiaReferenceSearchSource = 'all' | 'zotero' | 'vault';
export type ScholiaReferenceListType = 'bullet' | 'numbered';
export type ScholiaReferenceSource = 'vault' | 'zotero' | 'vault+zotero' | 'unknown';

export interface ScholiaReferenceRecord {
	source: ScholiaReferenceSource;
	citekey: string;
	zoteroKey: string;
	vaultPath: string;
	title: string;
	authors: string[];
	year: string;
	reference: string;
	itemType: string;
	publisher: string;
	containerTitle: string;
	place: string;
	pages: string;
	doi: string;
	url: string;
	properties?: Record<string, any>;
}

type CitationRequest = Partial<Pick<ScholiaReferenceRecord, 'citekey' | 'zoteroKey' | 'vaultPath'>> & {
	pdfPath?: string;
};

type ManagedBlockRange = {
	start: number;
	end: number;
	replacement: string;
};


const MANAGED_REFERENCE_START = '<!-- PDF Scholia Scribe references: start -->';
const MANAGED_REFERENCE_END = '<!-- PDF Scholia Scribe references: end -->';

const CITEKEY_KEYS = [
	'citekey', 'citeKey', 'citationKey', 'citation_key', 'bibtexKey', 'bibtex_key',
	'zoteroCitekey', 'zotero_citekey', 'betterBibtexKey', 'better_bibtex_key',
];
const ZOTERO_ITEM_KEY_KEYS = ['zoteroKey', 'zotero_key', 'zoteroItemKey', 'zotero_item_key', 'itemKey', 'item_key'];
const AUTHOR_KEYS = ['author', 'authors', 'creator', 'creators', 'by', 'writer', 'writers'];
const YEAR_KEYS = ['year', 'date', 'published', 'publicationDate', 'publication_date', 'publicationYear', 'publication_year', 'issued'];
const TITLE_KEYS = ['title', 'shortTitle', 'short_title', 'name'];
const REFERENCE_KEYS = ['reference', 'references', 'bibliography', 'bibliographyEntry', 'bibliography_entry', 'citationFull', 'citation_full'];
const PUBLISHER_KEYS = ['publisher', 'press'];
const CONTAINER_TITLE_KEYS = ['containerTitle', 'container-title', 'journal', 'journalTitle', 'journal_title', 'publicationTitle', 'publication_title', 'bookTitle', 'book_title'];
const PLACE_KEYS = ['place', 'location', 'publisherPlace', 'publisher_place'];
const PAGES_KEYS = ['pages', 'pageRange', 'page_range'];
const DOI_KEYS = ['doi', 'DOI'];
const URL_KEYS = ['url', 'URL', 'source_url', 'sourceUrl'];
const PDF_LINK_KEYS = ['PDF', 'pdf', 'sourcePdf', 'source_pdf', 'pdfFile', 'pdf_file', 'file'];


function emptyRecord(source: ScholiaReferenceSource): ScholiaReferenceRecord {
	return {
		source,
		citekey: '',
		zoteroKey: '',
		vaultPath: '',
		title: '',
		authors: [],
		year: '',
		reference: '',
		itemType: '',
		publisher: '',
		containerTitle: '',
		place: '',
		pages: '',
		doi: '',
		url: '',
	};
}

function findProperty(properties: Record<string, any>, keys: string[]) {
	const normalized = keys.map((key) => key.toLowerCase());
	for (const [key, value] of Object.entries(properties)) {
		if (normalized.includes(key.toLowerCase())) return value;
	}
	return undefined;
}

function flattenPropertyValue(value: unknown): string[] {
	if (value === null || value === undefined) return [];

	if (Array.isArray(value)) {
		return value.flatMap((item) => flattenPropertyValue(item));
	}

	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.family === 'string' || typeof record.given === 'string') {
			return [`${record.given ?? ''} ${record.family ?? ''}`.trim()].filter(Boolean);
		}
		if (typeof record.lastName === 'string' || typeof record.firstName === 'string') {
			return [`${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()].filter(Boolean);
		}
		if (typeof record.name === 'string') return [record.name];
		if (typeof record.display === 'string') return [record.display];
		if (typeof record.path === 'string') return [record.path];
		return Object.values(record).flatMap((item) => flattenPropertyValue(item));
	}

	return [String(value)];
}

function firstValue(properties: Record<string, any>, keys: string[]) {
	return flattenPropertyValue(findProperty(properties, keys))
		.map((value) => cleanText(value))
		.filter(Boolean)[0] ?? '';
}

function stripLinkSyntax(value: string) {
	return value
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/^["']|["']$/g, '')
		.trim();
}

function cleanText(value: string) {
	return stripLinkSyntax(value)
		.replace(/\s+/g, ' ')
		.trim();
}

function extractYear(value: string) {
	return value.match(/(?:18|19|20|21)\d{2}/)?.[0] ?? '';
}

function getYear(properties: Record<string, any>) {
	for (const value of flattenPropertyValue(findProperty(properties, YEAR_KEYS))) {
		const year = extractYear(value);
		if (year) return year;
	}
	return '';
}

function splitAuthors(values: string[]) {
	return values
		.flatMap((value) => {
			const cleaned = cleanText(value);
			if (!cleaned) return [];
			return cleaned.split(/\s*(?:;|\s+and\s+|\s+&\s+)\s*/i);
		})
		.map((author) => author.trim())
		.filter(Boolean);
}

function getFamilyName(name: string) {
	const cleaned = cleanText(name);
	if (!cleaned) return '';
	if (cleaned.includes(',')) return cleaned.split(',')[0].trim();
	const parts = cleaned.split(/\s+/).filter(Boolean);
	return parts[parts.length - 1] ?? cleaned;
}

function formatCitationAuthor(authors: string[]) {
	const families = authors.map(getFamilyName).filter(Boolean);
	if (families.length === 0) return 'Unknown author';
	if (families.length === 1) return families[0];
	if (families.length === 2) return `${families[0]} and ${families[1]}`;
	return `${families[0]} et al.`;
}

function formatReferenceAuthor(authors: string[]) {
	if (authors.length === 0) return 'Unknown author';
	if (authors.length === 1) return authors[0];
	if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
	return `${authors.slice(0, -1).join(', ')}, and ${authors[authors.length - 1]}`;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtmlToMarkdown(value: string) {
	return value
		.replace(/<\/?(i|em)>/gi, '*')
		.replace(/<\/?(b|strong)>/gi, '**')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/div>\s*<div[^>]*>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+\n/g, '\n')
		.replace(/\n\s+/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.trim();
}

function normalizeReference(value: string) {
	return stripHtmlToMarkdown(value)
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
		.trim();
}

function mergeRecords(base: ScholiaReferenceRecord, incoming: ScholiaReferenceRecord): ScholiaReferenceRecord {
	const merged: ScholiaReferenceRecord = {
		...base,
		source: base.source === incoming.source ? base.source : base.source === 'unknown' ? incoming.source : incoming.source === 'unknown' ? base.source : 'vault+zotero',
		citekey: base.citekey || incoming.citekey,
		zoteroKey: base.zoteroKey || incoming.zoteroKey,
		vaultPath: base.vaultPath || incoming.vaultPath,
		title: base.title || incoming.title,
		authors: base.authors.length ? base.authors : incoming.authors,
		year: base.year || incoming.year,
		reference: base.reference || incoming.reference,
		itemType: base.itemType || incoming.itemType,
		publisher: base.publisher || incoming.publisher,
		containerTitle: base.containerTitle || incoming.containerTitle,
		place: base.place || incoming.place,
		pages: base.pages || incoming.pages,
		doi: base.doi || incoming.doi,
		url: base.url || incoming.url,
		properties: base.properties ?? incoming.properties,
	};
	return merged;
}

function recordIdentity(record: ScholiaReferenceRecord) {
	return (record.citekey && `citekey:${record.citekey.toLowerCase()}`)
		|| (record.zoteroKey && `zotero:${record.zoteroKey}`)
		|| (record.vaultPath && `vault:${record.vaultPath}`)
		|| `title:${record.title.toLowerCase()}-${record.year}`;
}

function requestIdentity(request: CitationRequest) {
	return (request.citekey && `citekey:${request.citekey.toLowerCase()}`)
		|| (request.zoteroKey && `zotero:${request.zoteroKey}`)
		|| (request.vaultPath && `vault:${request.vaultPath}`)
		|| (request.pdfPath && `pdf:${request.pdfPath}`)
		|| '';
}


export class ZoteroReferenceManager extends PDFPlusLibSubmodule {
	getVaultReferenceRecords() {
		const records: ScholiaReferenceRecord[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const record = this.getVaultReferenceRecord(file);
			if (record) records.push(record);
		}
		return records;
	}

	getVaultReferenceRecord(file: TFile) {
		const properties = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const citekey = firstValue(properties, CITEKEY_KEYS);
		const title = firstValue(properties, TITLE_KEYS);
		const authors = splitAuthors(flattenPropertyValue(findProperty(properties, AUTHOR_KEYS)));
		const year = getYear(properties);
		const reference = firstValue(properties, REFERENCE_KEYS);
		const zoteroKey = firstValue(properties, ZOTERO_ITEM_KEY_KEYS);

		if (!citekey && !zoteroKey && !title && !authors.length && !year && !reference) {
			return null;
		}

		return {
			...emptyRecord('vault'),
			citekey,
			zoteroKey,
			vaultPath: file.path,
			title: title || file.basename,
			authors,
			year,
			reference,
			itemType: firstValue(properties, ['itemType', 'item_type', 'type']),
			publisher: firstValue(properties, PUBLISHER_KEYS),
			containerTitle: firstValue(properties, CONTAINER_TITLE_KEYS),
			place: firstValue(properties, PLACE_KEYS),
			pages: firstValue(properties, PAGES_KEYS),
			doi: firstValue(properties, DOI_KEYS),
			url: firstValue(properties, URL_KEYS),
			properties,
		};
	}

	searchVault(query: string, vaultRecords = this.getVaultReferenceRecords()) {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return vaultRecords
			.filter((record) => {
				const haystack = [
					record.citekey,
					record.title,
					record.year,
					record.vaultPath,
					record.authors.join(' '),
				].join(' ').toLowerCase();
				return terms.every((term) => haystack.includes(term));
			})
			.slice(0, 20);
	}

	async searchReferences(query: string, source: ScholiaReferenceSearchSource = 'all') {
		const vaultRecords = this.getVaultReferenceRecords();
		const vaultMatches = source === 'zotero' ? [] : this.searchVault(query, vaultRecords);
		const zoteroMatches = source === 'vault' ? [] : await this.searchZotero(query);

		// Keep Zotero and vault records separate in search results. A noisy vault
		// note should not hide the cleaner Zotero option for the same source.
		if (source === 'zotero') {
			return this.dedupeRecords(zoteroMatches).slice(0, 25);
		}
		if (source === 'vault') {
			return this.dedupeRecords(vaultMatches).slice(0, 25);
		}
		return [
			...this.dedupeRecords(zoteroMatches),
			...this.dedupeRecords(vaultMatches),
		].slice(0, 30);
	}

	async insertCitation(view: MarkdownView, record: ScholiaReferenceRecord, page: string, mode: ScholiaCitationTextMode = 'default') {
		const label = this.formatInTextCitation(record, page, mode);
		const citation = this.buildCitationLink(record, label, view.file);
		view.editor.replaceSelection(citation);
	}

	async updateReferenceList(view: MarkdownView) {
		const file = view.file;
		if (!file) {
			new Notice(`${this.plugin.manifest.name}: Open a note before updating its reference list.`);
			return 0;
		}

		const content = view.editor.getValue();
		const vaultRecords = this.getVaultReferenceRecords();
		const requests = this.extractCitationRequests(content, file, vaultRecords);
		const records: ScholiaReferenceRecord[] = [];

		for (const request of requests) {
			const record = await this.resolveRequest(request, vaultRecords);
			if (record) records.push(record);
		}

		const deduped = this.dedupeRecords(records);
		const block = this.buildReferenceBlock(deduped);
		const range = this.getManagedReferenceRange(content, block);
		this.replaceEditorRange(view, content, range);

		return deduped.length;
	}

	extractCitationRequests(content: string, activeFile: TFile, vaultRecords: ScholiaReferenceRecord[]) {
		const source = this.removeManagedReferenceBlock(content);
		const requests: CitationRequest[] = [];
		const seen = new Set<string>();

		const add = (request: CitationRequest) => {
			const key = requestIdentity(request);
			if (!key || seen.has(key)) return;
			seen.add(key);
			requests.push(request);
		};

		for (const match of source.matchAll(/\[[^\]]+\]\((zotero:\/\/select\/items\/[^)\s]+)\)/g)) {
			const request = this.parseZoteroSelectUrl(match[1]);
			if (request) add(request);
		}

		for (const match of source.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
			const rawLinktext = match[1].split('|')[0].trim();
			const linkpath = getLinkpath(rawLinktext);
			const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkpath, activeFile.path);
			if (!(targetFile instanceof TFile)) continue;

			if (targetFile.extension === 'md') {
				const record = this.getVaultReferenceRecord(targetFile);
				if (record) add({ vaultPath: record.vaultPath, citekey: record.citekey, zoteroKey: record.zoteroKey });
			} else if (targetFile.extension === 'pdf') {
				const record = this.findVaultRecordForPdf(targetFile, vaultRecords);
				if (record) {
					add({ vaultPath: record.vaultPath, citekey: record.citekey, zoteroKey: record.zoteroKey, pdfPath: targetFile.path });
				} else {
					add({ pdfPath: targetFile.path });
				}
			}
		}

		for (const match of source.matchAll(/(^|[^\w.])@([A-Za-z][A-Za-z0-9_:.#$%&+?<>~/-]*)/g)) {
			add({ citekey: match[2] });
		}

		return requests;
	}

	async resolveRequest(request: CitationRequest, vaultRecords: ScholiaReferenceRecord[]) {
		let record: ScholiaReferenceRecord | null = null;

		if (request.vaultPath) {
			record = vaultRecords.find((candidate) => candidate.vaultPath === request.vaultPath) ?? null;
		}
		if (!record && request.citekey) {
			record = vaultRecords.find((candidate) => candidate.citekey.toLowerCase() === request.citekey!.toLowerCase()) ?? null;
		}
		if (!record && request.zoteroKey) {
			record = vaultRecords.find((candidate) => candidate.zoteroKey === request.zoteroKey) ?? null;
		}
		if (!record && request.pdfPath) {
			const pdfFile = this.app.vault.getAbstractFileByPath(request.pdfPath);
			if (pdfFile instanceof TFile) record = this.findVaultRecordForPdf(pdfFile, vaultRecords);
		}

		let zoteroRecord: ScholiaReferenceRecord | null = null;
		if (request.zoteroKey || record?.zoteroKey) {
			zoteroRecord = await this.getZoteroRecordByItemKey(request.zoteroKey || record!.zoteroKey);
		}
		if (!zoteroRecord && (request.citekey || record?.citekey)) {
			zoteroRecord = await this.getZoteroRecordByCitekey(request.citekey || record!.citekey);
		}

		if (record && zoteroRecord) return mergeRecords(record, zoteroRecord);
		if (record) return record;
		if (zoteroRecord) return zoteroRecord;

		if (request.citekey) {
			return { ...emptyRecord('unknown'), citekey: request.citekey, title: request.citekey };
		}
		if (request.pdfPath) {
			const file = this.app.vault.getAbstractFileByPath(request.pdfPath);
			if (file instanceof TFile) {
				return { ...emptyRecord('vault'), title: file.basename };
			}
		}
		return null;
	}

	findVaultRecordForZoteroRecord(record: ScholiaReferenceRecord, vaultRecords: ScholiaReferenceRecord[]) {
		if (record.citekey) {
			const byCitekey = vaultRecords.find((candidate) => candidate.citekey.toLowerCase() === record.citekey.toLowerCase());
			if (byCitekey) return byCitekey;
		}
		if (record.zoteroKey) {
			const byZoteroKey = vaultRecords.find((candidate) => candidate.zoteroKey === record.zoteroKey);
			if (byZoteroKey) return byZoteroKey;
		}
		const title = record.title.toLowerCase();
		return vaultRecords.find((candidate) => {
			return !!title && candidate.title.toLowerCase() === title && (!record.year || !candidate.year || record.year === candidate.year);
		}) ?? null;
	}

	findVaultRecordForPdf(pdf: TFile, vaultRecords: ScholiaReferenceRecord[]) {
		return vaultRecords.find((record) => {
			const properties = record.properties ?? {};
			const values = [
				...flattenPropertyValue(findProperty(properties, [this.settings.proxyMDProperty])),
				...flattenPropertyValue(findProperty(properties, PDF_LINK_KEYS)),
			];

			return values.some((value) => {
				const linkpath = getLinkpath(stripLinkSyntax(value));
				const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkpath, record.vaultPath);
				return targetFile?.path === pdf.path
					|| linkpath === pdf.path
					|| linkpath === pdf.name
					|| linkpath === pdf.basename;
			});
		}) ?? null;
	}

	async searchZotero(query: string) {
		if (!query.trim()) return [];
		const encoded = encodeURIComponent(query.trim());
		const items = await this.requestZoteroJson(`/api/users/0/items/top?format=json&include=data&limit=20&q=${encoded}`);
		if (!Array.isArray(items)) return [];
		return items
			.map((item) => this.recordFromZoteroItem(item))
			.filter((record): record is ScholiaReferenceRecord => !!record)
			.filter((record) => record.itemType !== 'attachment' && record.itemType !== 'note');
	}

	async getZoteroRecordByItemKey(itemKey: string) {
		if (!itemKey) return null;
		const encoded = encodeURIComponent(itemKey);
		const style = encodeURIComponent(this.settings.zoteroBibliographyStyle || 'apa');
		const item = await this.requestZoteroJson(`/api/users/0/items/${encoded}?format=json&include=data,bib&style=${style}`);
		return this.recordFromZoteroItem(item);
	}

	async getZoteroRecordByCitekey(citekey: string) {
		if (!citekey) return null;
		const records = await this.searchZotero(citekey);
		const record = records.find((record) => record.citekey.toLowerCase() === citekey.toLowerCase()) ?? null;
		if (record?.zoteroKey) {
			return await this.getZoteroRecordByItemKey(record.zoteroKey) ?? record;
		}
		return record;
	}

	async requestZoteroJson(path: string) {
		const base = this.settings.zoteroLocalApiBaseUrl.replace(/\/+$/, '') || 'http://127.0.0.1:23119';
		const url = base + path;
		let requestUrlError: unknown = null;

		try {
			const response = await requestUrl({
				url,
				throw: false,
			});
			if (response.status >= 400) return null;
			return response.json;
		} catch (err) {
			requestUrlError = err;
		}

		const nodeResult = await this.requestZoteroJsonWithNode(url);
		if (nodeResult !== null) return nodeResult;

		console.warn(`${this.plugin.manifest.name}: Zotero local API request failed.`, requestUrlError);
		return null;
	}

	async requestZoteroJsonWithNode(url: string) {
		if (!Platform.isDesktopApp) return null;
		const nodeRequire = (window as any).require as ((moduleName: string) => any) | undefined;
		if (!nodeRequire) return null;

		return await new Promise<unknown | null>((resolve) => {
			let settled = false;
			const finish = (value: unknown | null) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};

			try {
				const parsed = new URL(url);
				const client = nodeRequire(parsed.protocol === 'https:' ? 'https' : 'http');
				const request = client.get(url, { headers: { Accept: 'application/json' } }, (response: any) => {
					let body = '';
					response.setEncoding('utf8');
					response.on('data', (chunk: string) => {
						body += chunk;
					});
					response.on('end', () => {
						if ((response.statusCode ?? 0) >= 400) {
							finish(null);
							return;
						}
						try {
							finish(JSON.parse(body));
						} catch {
							finish(null);
						}
					});
				});
				request.setTimeout(5000, () => {
					request.destroy();
					finish(null);
				});
				request.on('error', () => finish(null));
			} catch {
				finish(null);
			}
		});
	}

	recordFromZoteroItem(item: any): ScholiaReferenceRecord | null {
		const data = item?.data ?? item;
		if (!data || typeof data !== 'object') return null;

		const creators = Array.isArray(data.creators) ? data.creators : [];
		const authorCreators = creators.filter((creator: any) => !creator.creatorType || ['author', 'bookAuthor'].includes(creator.creatorType));
		const fallbackCreators = authorCreators.length ? authorCreators : creators.filter((creator: any) => creator.creatorType === 'editor');
		const authors = fallbackCreators
			.map((creator: any) => {
				if (creator.name) return creator.name;
				return `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim();
			})
			.filter(Boolean);

		const record = {
			...emptyRecord('zotero'),
			citekey: data.citationKey || this.parseCitationKeyFromExtra(data.extra ?? ''),
			zoteroKey: data.key || item?.key || '',
			title: cleanText(data.title ?? ''),
			authors,
			year: extractYear(data.date ?? ''),
			reference: item?.bib ? normalizeReference(item.bib) : '',
			itemType: data.itemType ?? '',
			publisher: cleanText(data.publisher ?? ''),
			containerTitle: cleanText(data.publicationTitle ?? data.bookTitle ?? data.proceedingsTitle ?? ''),
			place: cleanText(data.place ?? ''),
			pages: cleanText(data.pages ?? ''),
			doi: cleanText(data.DOI ?? data.doi ?? ''),
			url: cleanText(data.url ?? ''),
		};

		if (!record.title && !record.citekey && !record.zoteroKey) return null;
		return record;
	}

	parseCitationKeyFromExtra(extra: string) {
		for (const line of extra.split(/\r?\n/)) {
			const match = line.match(/^\s*Citation Key\s*:\s*(.+?)\s*$/i);
			if (match) return match[1].trim();
		}
		return '';
	}

	parseZoteroSelectUrl(url: string): CitationRequest | null {
		const rawTarget = decodeURIComponent(url.replace(/^zotero:\/\/select\/items\//, '').split(/[?#]/)[0]);
		if (!rawTarget) return null;
		if (rawTarget.startsWith('@')) return { citekey: rawTarget.slice(1) };
		if (rawTarget.startsWith('bbt:')) return { citekey: rawTarget.slice('bbt:'.length) };
		const itemKeyMatch = rawTarget.match(/^(?:\d+_)?([A-Z0-9]{8,})$/i);
		if (itemKeyMatch) return { zoteroKey: itemKeyMatch[1] };
		return null;
	}

	formatInTextCitation(record: ScholiaReferenceRecord, page: string, mode: ScholiaCitationTextMode = 'default') {
		const style = this.settings.zoteroInTextCitationStyle as ScholiaCitationStyle;
		const author = formatCitationAuthor(record.authors);
		const year = record.year || 'n.d.';
		const pagePart = page.trim();
		const number = '?';

		if (mode === 'year-only') {
			if (style === 'apa' || style === 'harvard') {
				return `(${year}${pagePart ? `, p. ${pagePart}` : ''})`;
			}
			if (style === 'numeric') {
				return `[${number}${pagePart ? `, p. ${pagePart}` : ''}]`;
			}
			return `(${year}${pagePart ? `:${pagePart}` : ''})`;
		}

		if (style === 'apa') {
			return `(${author}, ${year}${pagePart ? `, p. ${pagePart}` : ''})`;
		}
		if (style === 'harvard') {
			return `(${author} ${year}${pagePart ? `, p. ${pagePart}` : ''})`;
		}
		if (style === 'numeric') {
			return `[${number}${pagePart ? `, p. ${pagePart}` : ''}]`;
		}
		return `(${author} ${year}${pagePart ? `:${pagePart}` : ''})`;
	}

	buildCitationLink(record: ScholiaReferenceRecord, label: string, activeFile: TFile | null) {
		if (record.vaultPath && this.settings.zoteroPreferVaultLinks) {
			const file = this.app.vault.getAbstractFileByPath(record.vaultPath);
			if (file instanceof TFile) {
				const linktext = this.app.metadataCache.fileToLinktext(file, activeFile?.path ?? '');
				return `[[${linktext}|${label}]]`;
			}
		}

		if (record.zoteroKey) {
			return `[${label}](zotero://select/items/0_${record.zoteroKey})`;
		}
		if (record.citekey) {
			return `[${label}](zotero://select/items/@${encodeURIComponent(record.citekey)})`;
		}
		return label;
	}

	buildReferenceBlock(records: ScholiaReferenceRecord[]) {
		const lines = records.length
			? records.map((record, index) => this.formatReferenceListItem(record, index))
			: ['No citations found in this note.'];
		return `${MANAGED_REFERENCE_START}\n${lines.join('\n')}\n${MANAGED_REFERENCE_END}`;
	}

	formatReferenceListItem(record: ScholiaReferenceRecord, index: number) {
		const marker = this.settings.zoteroReferenceListType === 'numbered' ? `${index + 1}.` : '-';
		return `${marker} ${this.formatReference(record)}`;
	}

	formatReference(record: ScholiaReferenceRecord) {
		if (record.reference) return normalizeReference(record.reference);

		const author = formatReferenceAuthor(record.authors);
		const year = record.year || 'n.d.';
		const title = record.title ? `*${record.title}*` : record.citekey || 'Untitled source';
		const pieces = [`${author}.`, `${year}.`, `${title}.`];

		if (record.containerTitle) pieces.push(record.containerTitle + '.');
		if (record.publisher) pieces.push(record.publisher + '.');
		if (record.place) pieces.push(record.place + '.');
		if (record.pages) pieces.push(record.pages + '.');
		if (record.doi) pieces.push(`https://doi.org/${record.doi.replace(/^https?:\/\/doi\.org\//i, '')}`);
		else if (record.url) pieces.push(record.url);

		return pieces.join(' ').replace(/\s+/g, ' ').trim();
	}

	getManagedReferenceRange(content: string, block: string): ManagedBlockRange {
		const existingStart = content.indexOf(MANAGED_REFERENCE_START);
		const existingEnd = content.indexOf(MANAGED_REFERENCE_END);
		if (existingStart >= 0 && existingEnd > existingStart) {
			return {
				start: existingStart,
				end: existingEnd + MANAGED_REFERENCE_END.length,
				replacement: block,
			};
		}

		const heading = this.settings.zoteroReferenceListHeading.trim() || 'References';
		const headingMatch = new RegExp(`(^|\\n)(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`, 'im').exec(content);
		if (headingMatch) {
			const headingLineEnd = content.indexOf('\n', headingMatch.index + headingMatch[0].length);
			const insertAt = headingLineEnd === -1 ? content.length : headingLineEnd + 1;
			return {
				start: insertAt,
				end: insertAt,
				replacement: `\n${block}\n`,
			};
		}

		const prefix = content.trimEnd().length ? '\n\n' : '';
		return {
			start: content.length,
			end: content.length,
			replacement: `${prefix}## ${heading}\n\n${block}\n`,
		};
	}

	replaceEditorRange(view: MarkdownView, content: string, range: ManagedBlockRange) {
		const from = this.offsetToPos(content, range.start);
		const to = this.offsetToPos(content, range.end);
		const scroll = view.editor.getScrollInfo();
		view.editor.replaceRange(range.replacement, from, to, 'pdf-scholia-scribe-reference-list');
		view.editor.scrollTo(scroll.left, scroll.top);
	}

	offsetToPos(content: string, offset: number): EditorPosition {
		const before = content.slice(0, offset);
		const lines = before.split('\n');
		return {
			line: lines.length - 1,
			ch: lines[lines.length - 1].length,
		};
	}

	removeManagedReferenceBlock(content: string) {
		const start = content.indexOf(MANAGED_REFERENCE_START);
		const end = content.indexOf(MANAGED_REFERENCE_END);
		if (start < 0 || end <= start) return content;
		return content.slice(0, start) + content.slice(end + MANAGED_REFERENCE_END.length);
	}

	dedupeRecords(records: ScholiaReferenceRecord[]) {
		const map = new Map<string, ScholiaReferenceRecord>();
		for (const record of records) {
			const key = recordIdentity(record);
			const existing = map.get(key);
			map.set(key, existing ? mergeRecords(existing, record) : record);
		}
		return Array.from(map.values());
	}
}
