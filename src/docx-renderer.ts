const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_DOCX_ENTRY_SIZE = 32 * 1024 * 1024;

interface ZipEntry {
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

interface DocxRenderResult {
	warnings: string[];
}

const getUint16 = (view: DataView, offset: number): number => {
	if (offset < 0 || offset + 2 > view.byteLength) throw new Error('The DOCX archive is truncated.');
	return view.getUint16(offset, true);
};

const getUint32 = (view: DataView, offset: number): number => {
	if (offset < 0 || offset + 4 > view.byteLength) throw new Error('The DOCX archive is truncated.');
	return view.getUint32(offset, true);
};

const findEndOfCentralDirectory = (view: DataView): number => {
	const minimumSize = 22;
	for (let offset = view.byteLength - minimumSize; offset >= Math.max(0, view.byteLength - minimumSize - 0xffff); offset--) {
		if (getUint32(view, offset) === 0x06054b50) return offset;
	}
	throw new Error('This file is not a supported DOCX archive.');
};

const listZipEntries = (source: ArrayBuffer): Map<string, ZipEntry> => {
	const view = new DataView(source);
	const endOffset = findEndOfCentralDirectory(view);
	const entryCount = getUint16(view, endOffset + 10);
	const directorySize = getUint32(view, endOffset + 12);
	const directoryOffset = getUint32(view, endOffset + 16);
	if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		throw new Error('ZIP64 DOCX archives are not supported. Save a standard DOCX copy and try again.');
	}
	if (directoryOffset + directorySize > view.byteLength) throw new Error('The DOCX archive has an invalid central directory.');

	const decoder = new TextDecoder('utf-8');
	const entries = new Map<string, ZipEntry>();
	let offset = directoryOffset;
	for (let index = 0; index < entryCount; index++) {
		if (getUint32(view, offset) !== 0x02014b50) throw new Error('The DOCX archive has an invalid entry.');
		const compressionMethod = getUint16(view, offset + 10);
		const compressedSize = getUint32(view, offset + 20);
		const uncompressedSize = getUint32(view, offset + 24);
		const nameLength = getUint16(view, offset + 28);
		const extraLength = getUint16(view, offset + 30);
		const commentLength = getUint16(view, offset + 32);
		const localHeaderOffset = getUint32(view, offset + 42);
		const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
		if (entryEnd > view.byteLength) throw new Error('The DOCX archive has a truncated entry name.');
		const name = decoder.decode(new Uint8Array(source, offset + 46, nameLength));
		if (uncompressedSize > MAX_DOCX_ENTRY_SIZE) {
			throw new Error('This DOCX contains an entry that is too large to display safely.');
		}
		entries.set(name, { compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
		offset = entryEnd;
	}
	return entries;
};

const readZipEntry = async (source: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> => {
	const view = new DataView(source);
	if (getUint32(view, entry.localHeaderOffset) !== 0x04034b50) throw new Error('The DOCX archive has an invalid file header.');
	const nameLength = getUint16(view, entry.localHeaderOffset + 26);
	const extraLength = getUint16(view, entry.localHeaderOffset + 28);
	const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
	const end = start + entry.compressedSize;
	if (end > source.byteLength) throw new Error('The DOCX archive has truncated file data.');
	const compressed = source.slice(start, end);

	if (entry.compressionMethod === 0) return new Uint8Array(compressed);
	if (entry.compressionMethod !== 8) throw new Error('This DOCX uses an unsupported compression method.');
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This Obsidian version cannot safely decompress DOCX files. Update Obsidian and try again.');
	}
	const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	const result = new Uint8Array(await new Response(stream).arrayBuffer());
	if (result.byteLength !== entry.uncompressedSize) throw new Error('The DOCX archive did not decompress as expected.');
	return result;
};

const parseXml = (data: Uint8Array, filename: string): Document => {
	const document = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(data), 'application/xml');
	if (document.querySelector('parsererror')) throw new Error(`${filename} is not valid XML.`);
	return document;
};

const directChildren = (element: Element, name: string): Element[] =>
	Array.from(element.children).filter(child => child.namespaceURI === WORD_NAMESPACE && child.localName === name);

const firstDirectChild = (element: Element, name: string): Element | null => directChildren(element, name)[0] ?? null;

const wordValue = (element: Element | null): string | null =>
	element?.getAttributeNS(WORD_NAMESPACE, 'val') ?? element?.getAttribute('w:val') ?? null;

const hasRunProperty = (runProperties: Element | null, name: string): boolean => {
	const property = runProperties ? firstDirectChild(runProperties, name) : null;
	return property !== null && wordValue(property) !== '0' && wordValue(property) !== 'none';
};

const appendRun = (parent: HTMLElement, run: Element): void => {
	const properties = firstDirectChild(run, 'rPr');
	let target = parent;
	if (hasRunProperty(properties, 'b')) target = target.createEl('strong');
	if (hasRunProperty(properties, 'i')) target = target.createEl('em');
	if (hasRunProperty(properties, 'u')) target = target.createEl('u');
	if (hasRunProperty(properties, 'strike')) target = target.createEl('s');
	const alignment = wordValue(firstDirectChild(properties ?? run, 'vertAlign'));
	if (alignment === 'superscript') target = target.createEl('sup');
	if (alignment === 'subscript') target = target.createEl('sub');

	for (const child of Array.from(run.children)) {
		if (child.namespaceURI !== WORD_NAMESPACE) continue;
		if (child.localName === 't' || child.localName === 'delText' || child.localName === 'instrText') target.appendText(child.textContent ?? '');
		else if (child.localName === 'tab') target.appendText('\t');
		else if (child.localName === 'br' || child.localName === 'cr') target.createEl('br');
		else if (child.localName === 'drawing' || child.localName === 'pict') target.createSpan({ cls: 'scholia-docx-embedded-object', text: '[embedded object]' });
		else if (child.localName === 'commentReference') target.createEl('sup', { cls: 'scholia-word-comment-reference', text: 'Comment' });
	}
};

const appendInlineChildren = (parent: HTMLElement, source: Element, relationships: Map<string, string>): void => {
	for (const child of Array.from(source.children)) {
		if (child.namespaceURI !== WORD_NAMESPACE) continue;
		if (child.localName === 'r') appendRun(parent, child);
		else if (child.localName === 'hyperlink') {
			const relationshipId = child.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? child.getAttribute('r:id');
			const targetUrl = relationshipId ? relationships.get(relationshipId) : undefined;
			const target = targetUrl && /^(?:https?:|mailto:)/i.test(targetUrl)
				? parent.createEl('a', { attr: { href: targetUrl, rel: 'noopener noreferrer', target: '_blank' } })
				: parent;
			appendInlineChildren(target, child, relationships);
		} else if (child.localName === 'fldSimple' || child.localName === 'smartTag' || child.localName === 'sdt') {
			appendInlineChildren(parent, child, relationships);
		}
	}
};

const paragraphTag = (paragraph: Element): keyof HTMLElementTagNameMap => {
	const style = wordValue(firstDirectChild(firstDirectChild(paragraph, 'pPr') ?? paragraph, 'pStyle')) ?? '';
	const heading = style.match(/^heading\s*([1-6])$/i)?.[1];
	return heading ? `h${heading}` as keyof HTMLElementTagNameMap : 'p';
};

const renderParagraph = (parent: HTMLElement, paragraph: Element, relationships: Map<string, string>): void => {
	const element = parent.createEl(paragraphTag(paragraph), { cls: 'scholia-docx-paragraph' });
	const properties = firstDirectChild(paragraph, 'pPr');
	if (properties && firstDirectChild(properties, 'numPr')) {
		element.addClass('scholia-docx-list-paragraph');
		element.createSpan({ cls: 'scholia-docx-list-marker', text: '• ' });
	}
	appendInlineChildren(element, paragraph, relationships);
	if (!element.textContent && !element.querySelector('br, .scholia-docx-embedded-object')) element.appendText('\u00a0');
};

const renderTable = (parent: HTMLElement, table: Element, relationships: Map<string, string>): void => {
	const renderedTable = parent.createEl('table', { cls: 'scholia-docx-table' });
	const body = renderedTable.createEl('tbody');
	for (const row of directChildren(table, 'tr')) {
		const renderedRow = body.createEl('tr');
		for (const cell of directChildren(row, 'tc')) {
			const renderedCell = renderedRow.createEl('td');
			for (const paragraph of directChildren(cell, 'p')) renderParagraph(renderedCell, paragraph, relationships);
		}
	}
};

const readRelationships = async (source: ArrayBuffer, entries: Map<string, ZipEntry>): Promise<Map<string, string>> => {
	const relationshipEntry = entries.get('word/_rels/document.xml.rels');
	if (!relationshipEntry) return new Map();
	const document = parseXml(await readZipEntry(source, relationshipEntry), 'document relationships');
	const relationships = new Map<string, string>();
	for (const relationship of Array.from(document.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship'))) {
		if (relationship.getAttribute('TargetMode') !== 'External') continue;
		const id = relationship.getAttribute('Id');
		const target = relationship.getAttribute('Target');
		if (id && target && /^(?:https?:|mailto:)/i.test(target)) relationships.set(id, target);
	}
	return relationships;
};

export const renderDocxDocument = async (source: ArrayBuffer, destination: HTMLElement): Promise<DocxRenderResult> => {
	const entries = listZipEntries(source);
	const documentEntry = entries.get('word/document.xml');
	if (!documentEntry) throw new Error('This DOCX does not contain its main document content.');
	const document = parseXml(await readZipEntry(source, documentEntry), 'document.xml');
	const body = document.getElementsByTagNameNS(WORD_NAMESPACE, 'body')[0];
	if (!body) throw new Error('This DOCX does not contain a document body.');
	const relationships = await readRelationships(source, entries);
	const article = destination.createEl('article', { cls: 'scholia-docx-page' });
	let embeddedObjectCount = 0;
	for (const child of Array.from(body.children)) {
		if (child.namespaceURI !== WORD_NAMESPACE) continue;
		if (child.localName === 'p') renderParagraph(article, child, relationships);
		else if (child.localName === 'tbl') renderTable(article, child, relationships);
		else if (child.localName === 'sectPr') continue;
		else embeddedObjectCount++;
	}
	if (!article.children.length) article.createEl('p', { text: 'This Word document does not contain readable document text.' });
	const warnings = embeddedObjectCount ? ['Some advanced Word objects were not rendered. The original DOCX remains unchanged.'] : [];
	return { warnings };
};
