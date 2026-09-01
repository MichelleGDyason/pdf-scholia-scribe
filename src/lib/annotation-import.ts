import { EditorPosition, MarkdownView } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';

import { PDFPlusLibSubmodule } from './submodule';
import {
	AnnotationDocument,
	AnnotationProvider,
	ImportedAnnotation,
	ImportedAnnotationType,
	parseAppleBooksExport,
	parseKindleClippings,
	stableImportId,
	stableImportIdFromBytes,
} from './annotation-import-core';

export type { AnnotationDocument, AnnotationProvider, ImportedAnnotation } from './annotation-import-core';

export type ReadingAppImportSource = 'kindle' | 'apple-books' | 'apple-preview';

export interface AnnotationImportResult {
	documentCount: number;
	annotationCount: number;
	warningCount: number;
}

type PDFString = { str?: string };

type PDFJsAnnotation = {
	id?: string;
	subtype?: string;
	annotationType?: number;
	color?: number[] | Uint8ClampedArray | null;
	contentsObj?: PDFString;
	titleObj?: PDFString;
	creationDate?: string | null;
	modificationDate?: string | null;
	fieldType?: string;
	fieldName?: string;
	textContent?: string[];
};

type PDFInfo = {
	Title?: unknown;
	Author?: unknown;
};

type ManagedBlockRange = {
	start: number;
	end: number;
	replacement: string;
};

const MANAGED_IMPORTS_START = '<!-- PDF Scholia Scribe reading-app annotations: start -->';
const MANAGED_IMPORTS_END = '<!-- PDF Scholia Scribe reading-app annotations: end -->';
const TEXT_MARKUP_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut']);
const SILENTLY_IGNORED_SUBTYPES = new Set(['Link', 'Popup', 'Widget']);
const SHAPE_SUBTYPES = new Set(['Line', 'Square', 'Circle', 'PolyLine', 'Polygon', 'Caret']);

function stringValue(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function safeMarkdownText(value: string) {
	return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeMarkdownLinkLabel(value: string) {
	return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function annotationTypeForSubtype(subtype: string): ImportedAnnotationType {
	switch (subtype) {
		case 'Highlight': return 'highlight';
		case 'Underline': return 'underline';
		case 'Squiggly': return 'squiggly';
		case 'StrikeOut': return 'strikeout';
		case 'Text': return 'note';
		case 'FreeText': return 'text';
		case 'Ink': return 'ink';
		case 'Stamp': return 'stamp';
		default: return SHAPE_SUBTYPES.has(subtype) ? 'shape' : 'unknown';
	}
}

function annotationTypeLabel(type: ImportedAnnotationType) {
	switch (type) {
		case 'highlight': return 'Highlight';
		case 'underline': return 'Underline';
		case 'squiggly': return 'Squiggly underline';
		case 'strikeout': return 'Strikeout';
		case 'note': return 'Note';
		case 'text': return 'Text box';
		case 'ink': return 'Ink / handwriting';
		case 'shape': return 'Shape';
		case 'stamp': return 'Stamp';
		case 'bookmark': return 'Bookmark';
		default: return 'Annotation';
	}
}

function providerLabel(provider: AnnotationProvider) {
	switch (provider) {
		case 'kindle': return 'Kindle';
		case 'apple-books': return 'Apple Books';
		case 'apple-preview': return 'Apple Preview';
	}
}

function componentToByte(value: number) {
	const scaled = value <= 1 ? value * 255 : value;
	return Math.max(0, Math.min(255, Math.round(scaled)));
}

function pdfColorToHex(value: PDFJsAnnotation['color']) {
	if (!value || value.length < 3) return '';
	return `#${Array.from(value).slice(0, 3)
		.map((component) => componentToByte(component).toString(16).padStart(2, '0'))
		.join('')}`;
}

function normalizedColor(annotation: ImportedAnnotation) {
	if (/^#[0-9a-f]{6}$/i.test(annotation.color)) return annotation.color.toLowerCase();
	const named: Record<string, string> = {
		yellow: '#ffd400', green: '#63c174', blue: '#5aa9e6', pink: '#ff7eb6',
		purple: '#a78bfa', orange: '#ff9f43', red: '#ef6461',
	};
	return named[annotation.colorLabel.trim().toLocaleLowerCase()] ?? '#a0a0a0';
}

function blockquote(value: string) {
	return safeMarkdownText(value).split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function isPdfFile(file: File) {
	return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isTextFile(file: File) {
	return /^text\//i.test(file.type) || /\.(?:txt|html?)$/i.test(file.name);
}

export class AnnotationImportManager extends PDFPlusLibSubmodule {
	async parseFiles(source: ReadingAppImportSource, files: File[]) {
		const documents: AnnotationDocument[] = [];
		for (const file of files) {
			if (isPdfFile(file)) {
				documents.push(await this.parseAnnotatedPdf(file, source));
				continue;
			}
			if (source === 'kindle' && isTextFile(file)) {
				documents.push(...await parseKindleClippings(await file.text(), file.name));
				continue;
			}
			if (source === 'apple-books' && isTextFile(file)) {
				documents.push(...await parseAppleBooksExport(await file.text(), file.name));
				continue;
			}
			throw new TypeError(`${file.name} is not a supported ${providerLabel(source)} export.`);
		}
		return this.mergeDocuments(documents);
	}

	async parseAppleBooksText(value: string) {
		return await parseAppleBooksExport(value);
	}

	mergeDocuments(documents: AnnotationDocument[]) {
		const merged = new Map<string, AnnotationDocument>();
		for (const document of documents) {
			const key = `${document.provider}:${document.documentId}`;
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, { ...document, annotations: [...document.annotations], warnings: [...document.warnings] });
				continue;
			}
			const annotations = new Map(existing.annotations.map((annotation) => [annotation.annotationId, annotation]));
			for (const annotation of document.annotations) annotations.set(annotation.annotationId, annotation);
			existing.annotations = Array.from(annotations.values());
			existing.warnings = Array.from(new Set([...existing.warnings, ...document.warnings]));
		}
		return Array.from(merged.values());
	}

	async parseAnnotatedPdf(file: File, provider: AnnotationProvider): Promise<AnnotationDocument> {
		const buffer = await file.arrayBuffer();
		const documentId = await stableImportIdFromBytes(buffer.slice(0));
		let doc: PDFDocumentProxy | null = null;
		try {
			doc = await this.lib.loadPDFDocumentFromArrayBuffer(buffer.slice(0));
			const metadata = await doc.getMetadata();
			const info = metadata.info as PDFInfo;
			const title = stringValue(info.Title) || file.name.replace(/\.pdf$/i, '') || 'Untitled PDF';
			const author = stringValue(info.Author);
			const pageLabels = await doc.getPageLabels();
			const annotations: ImportedAnnotation[] = [];
			const warnings = new Set<string>();
			let skippedSensitive = 0;
			let unsupported = 0;

			for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
				const page = await doc.getPage(pageNumber);
				const [pageAnnotations, extractedText] = await Promise.all([
					page.getAnnotations() as Promise<PDFJsAnnotation[]>,
					this.lib.highlight.extract.getAnnotatedTextsInPage(page),
				]);
				for (let index = 0; index < pageAnnotations.length; index++) {
					const annotation = pageAnnotations[index];
					const subtype = stringValue(annotation.subtype);
					if (subtype === 'Redact' || (subtype === 'Widget' && annotation.fieldType === 'Sig')) {
						skippedSensitive++;
						continue;
					}
					if (SILENTLY_IGNORED_SUBTYPES.has(subtype)) continue;
					if (subtype === 'FileAttachment') {
						unsupported++;
						continue;
					}

					const type = annotationTypeForSubtype(subtype);
					const originalId = stringValue(annotation.id);
					const extracted = originalId ? extractedText.get(originalId) : undefined;
					const contents = stringValue(annotation.contentsObj?.str);
					const freeText = annotation.textContent?.join('\n').trim() || contents;
					const text = TEXT_MARKUP_SUBTYPES.has(subtype)
						? extracted?.text ?? ''
						: subtype === 'FreeText' ? freeText : '';
					const comment = subtype === 'FreeText' ? '' : contents;
					if (type === 'unknown' && !text && !comment) {
						unsupported++;
						continue;
					}
					if (type === 'unknown') unsupported++;
					const rawIdentity = [
						documentId, originalId, subtype, pageNumber.toString(), index.toString(), text, comment,
					].join('\u241f');
					annotations.push({
						provider,
						documentId,
						annotationId: await stableImportId(originalId ? `${documentId}\u241f${originalId}` : rawIdentity),
						sourceAnnotationId: originalId,
						type,
						text,
						comment,
						color: pdfColorToHex(annotation.color),
						colorLabel: '',
						page: pageNumber,
						pageLabel: pageLabels?.[pageNumber - 1] || pageNumber.toString(),
						locationStart: null,
						locationEnd: null,
						locationLabel: '',
						createdAt: stringValue(annotation.creationDate),
						modifiedAt: stringValue(annotation.modificationDate),
						author: stringValue(annotation.titleObj?.str),
						sourceLink: '',
						sourcePath: file.name,
						rawMetadata: subtype ? `PDF annotation subtype: ${subtype}` : 'PDF annotation',
					});
				}
			}

			if (skippedSensitive) {
				warnings.add(`${skippedSensitive} PDF signature field or redaction annotation${skippedSensitive === 1 ? ' was' : 's were'} skipped for privacy and safety.`);
			}
			if (unsupported) {
				warnings.add(`${unsupported} unsupported PDF annotation${unsupported === 1 ? ' was' : 's were'} not imported.`);
			}
			if (!annotations.length) {
				warnings.add('No editable PDF annotations were found. The PDF may be unannotated or its annotations may have been flattened into the page image.');
			}
			return { provider, documentId, title, author, sourcePath: file.name, annotations, warnings: Array.from(warnings) };
		} finally {
			await doc?.destroy();
		}
	}

	importDocuments(view: MarkdownView, documents: AnnotationDocument[]): AnnotationImportResult {
		const selected = documents.filter((document) => document.documentId);
		if (!selected.length) return { documentCount: 0, annotationCount: 0, warningCount: 0 };
		const content = view.editor.getValue();
		const block = this.buildManagedImportBlock(content, selected, view);
		const range = this.getManagedImportRange(content, block);
		this.replaceEditorRange(view, content, range);
		return {
			documentCount: selected.length,
			annotationCount: selected.reduce((count, document) => count + document.annotations.length, 0),
			warningCount: selected.reduce((count, document) => count + document.warnings.length, 0),
		};
	}

	buildManagedImportBlock(content: string, documents: AnnotationDocument[], view: MarkdownView) {
		const existingStart = content.indexOf(MANAGED_IMPORTS_START);
		const existingEnd = content.indexOf(MANAGED_IMPORTS_END);
		let body = existingStart >= 0 && existingEnd > existingStart
			? content.slice(existingStart + MANAGED_IMPORTS_START.length, existingEnd).trim()
			: '';

		for (const document of documents) {
			const start = this.documentSectionStart(document);
			const end = this.documentSectionEnd(document);
			const section = this.formatDocument(document, view);
			const currentStart = body.indexOf(start);
			const currentEnd = body.indexOf(end, currentStart + start.length);
			if (currentStart >= 0 && currentEnd > currentStart) {
				body = `${body.slice(0, currentStart)}${section}${body.slice(currentEnd + end.length)}`.trim();
			} else {
				body = body ? `${body.trimEnd()}\n\n${section}` : section;
			}
		}

		return `${MANAGED_IMPORTS_START}\n${body}\n${MANAGED_IMPORTS_END}`;
	}

	formatDocument(document: AnnotationDocument, view: MarkdownView) {
		const title = safeMarkdownText(document.title).replace(/\r?\n/g, ' ');
		const details = [
			providerLabel(document.provider),
			document.author ? safeMarkdownText(document.author) : '',
			document.sourcePath ? `Source: ${safeMarkdownText(document.sourcePath)}` : '',
			`${document.annotations.length} annotation${document.annotations.length === 1 ? '' : 's'}`,
		].filter(Boolean).join(' · ');
		const warnings = document.warnings.flatMap((warning) => [
			'> [!warning] Import notice',
			blockquote(warning),
			'',
		]);
		const annotations = document.annotations.length
			? document.annotations.map((annotation, index) => this.formatAnnotation(annotation, index, view)).join('\n\n')
			: '*No editable annotations found.*';
		return [
			this.documentSectionStart(document),
			`### ${title}`,
			'',
			details,
			'',
			...warnings,
			annotations,
			this.documentSectionEnd(document),
		].join('\n');
	}

	formatAnnotation(annotation: ImportedAnnotation, index: number, view: MarkdownView) {
		const label = annotationTypeLabel(annotation.type);
		const locator = this.formatLocator(annotation, view);
		const heading = locator ? `#### ${index + 1}. ${label} · ${locator}` : `#### ${index + 1}. ${label}`;
		const color = normalizedColor(annotation);
		const body = annotation.text
			? `<mark class="scholia-import-highlight" data-scholia-annotation-color="${color}" style="--scholia-import-color: ${color}; background-color: ${color}55;">${escapeHtml(annotation.text).replace(/\r?\n/g, '<br>')}</mark>`
			: `<span class="scholia-import-annotation-label" style="--scholia-import-color: ${color}; border-color: ${color};">${label}</span>`;
		const comment = annotation.comment
			? ['> [!note] Comment', blockquote(annotation.comment), '']
			: [];
		const inkNotice = annotation.type === 'ink' && !annotation.text
			? ['*The ink annotation remains in the source PDF. Scholia records its page, colour, and comment but does not perform handwriting recognition.*', '']
			: [];
		const metadata = [
			`<span class="scholia-import-color-swatch" aria-label="Annotation colour ${color}" style="--scholia-import-color: ${color}; background-color: ${color};"></span>`,
			annotation.color ? `\`${annotation.color}\`` : annotation.colorLabel ? safeMarkdownText(annotation.colorLabel) : 'Colour not supplied',
			annotation.author ? `By ${safeMarkdownText(annotation.author)}` : '',
			annotation.createdAt ? `Created ${safeMarkdownText(annotation.createdAt)}` : '',
			annotation.modifiedAt ? `Modified ${safeMarkdownText(annotation.modifiedAt)}` : '',
			annotation.rawMetadata ? safeMarkdownText(annotation.rawMetadata) : '',
		].filter(Boolean).join(' · ');
		return [
			`<!-- scholia-import-annotation:v1:${annotation.provider}:${annotation.annotationId} -->`,
			heading,
			'',
			`> ${body}`,
			'',
			...comment,
			...inkNotice,
			metadata,
		].join('\n');
	}

	formatLocator(annotation: ImportedAnnotation, view: MarkdownView) {
		const parts: string[] = [];
		if (annotation.page !== null || annotation.pageLabel) {
			const pageLabel = annotation.pageLabel || annotation.page?.toString() || 'Unknown page';
			const link = this.resolveVaultPdfLink(annotation, pageLabel, view);
			parts.push(link || `Page ${safeMarkdownText(pageLabel)}`);
		}
		if (annotation.locationLabel) parts.push(`Location ${safeMarkdownText(annotation.locationLabel)}`);
		if (annotation.sourceLink) {
			parts.push(`[Open source](${annotation.sourceLink})`);
		}
		return parts.join(' · ');
	}

	resolveVaultPdfLink(annotation: ImportedAnnotation, pageLabel: string, view: MarkdownView) {
		if (!annotation.sourcePath || annotation.page === null) return '';
		const matches = this.app.vault.getFiles().filter((file) => {
			return file.extension.toLocaleLowerCase() === 'pdf'
				&& (file.path === annotation.sourcePath || file.name === annotation.sourcePath);
		});
		if (matches.length !== 1) return '';
		const linktext = this.app.metadataCache.fileToLinktext(matches[0], view.file?.path ?? '');
		const annotationParameter = annotation.sourceAnnotationId
			? `&annotation=${encodeURIComponent(annotation.sourceAnnotationId)}`
			: '';
		const subpath = `#page=${annotation.page}${annotationParameter}`;
		return `[[${linktext}${subpath}|Page ${escapeMarkdownLinkLabel(pageLabel)}]]`;
	}

	documentSectionStart(document: AnnotationDocument) {
		return `<!-- scholia-import:${document.provider}:${document.documentId}:start -->`;
	}

	documentSectionEnd(document: AnnotationDocument) {
		return `<!-- scholia-import:${document.provider}:${document.documentId}:end -->`;
	}

	getManagedImportRange(content: string, block: string): ManagedBlockRange {
		const existingStart = content.indexOf(MANAGED_IMPORTS_START);
		const existingEnd = content.indexOf(MANAGED_IMPORTS_END);
		if (existingStart >= 0 && existingEnd > existingStart) {
			return { start: existingStart, end: existingEnd + MANAGED_IMPORTS_END.length, replacement: block };
		}
		const heading = 'Reading app annotations';
		const headingMatch = /(^|\n)(#{1,6})\s+Reading app annotations\s*$/im.exec(content);
		if (headingMatch) {
			const headingLineEnd = content.indexOf('\n', headingMatch.index + headingMatch[0].length);
			const insertAt = headingLineEnd === -1 ? content.length : headingLineEnd + 1;
			return { start: insertAt, end: insertAt, replacement: `\n${block}\n` };
		}
		const prefix = content.trimEnd().length ? '\n\n' : '';
		return { start: content.length, end: content.length, replacement: `${prefix}## ${heading}\n\n${block}\n` };
	}

	replaceEditorRange(view: MarkdownView, content: string, range: ManagedBlockRange) {
		const scroll = view.editor.getScrollInfo();
		view.editor.replaceRange(
			range.replacement,
			this.offsetToPos(content, range.start),
			this.offsetToPos(content, range.end),
			'pdf-scholia-scribe-reading-app-annotations',
		);
		view.editor.scrollTo(scroll.left, scroll.top);
	}

	offsetToPos(content: string, offset: number): EditorPosition {
		const lines = content.slice(0, offset).split('\n');
		return { line: lines.length - 1, ch: lines[lines.length - 1].length };
	}
}
