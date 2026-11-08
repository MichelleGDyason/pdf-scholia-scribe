import { FileView, MarkdownView, Notice, TFile, getLinkpath, parseYaml } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';

import { collectPdfFrontMatterPages } from './pdf-front-matter-text';
import { PDFPlusLibSubmodule } from './submodule';
import {
	buildReadingNoteMetadataProposals,
	candidatesFromReferenceMetadata,
	extractEmbeddedPdfMetadata,
	getReferenceMetadataConfidence,
	isBlankFrontmatterValue,
	isReadingNoteMetadataProperty,
	makeReadingNoteCandidate,
	mergeReadingNoteCandidates,
	ReadingNoteMetadataCandidates,
	ReadingNoteMetadataProposal,
} from './reading-note-metadata-core';
import { ReadingNoteMetadataPreviewModal, ReadingNotePdfSuggestModal } from 'modals';

type UnknownRecord = Record<string, unknown>;

const FRONT_MATTER_PAGE_LIMIT = 12;
const FRONT_MATTER_PAGE_CHARACTER_LIMIT = 50_000;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenStrings(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap((item) => flattenStrings(item));
	if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
	if (isRecord(value)) return Object.values(value).flatMap((item) => flattenStrings(item));
	return [];
}

function pdfLinkPath(value: string): string {
	const wikilink = value.match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
	if (wikilink) return wikilink[1].trim();
	return getLinkpath(value.replace(/^['"]|['"]$/g, '').trim());
}

function metadataMap(value: unknown): Record<string, unknown> {
	if (!value) return {};
	const metadata: Record<string, unknown> = {};
	const metadataObject = value as { getRaw?: () => unknown, [Symbol.iterator]?: unknown };
	const raw = typeof metadataObject.getRaw === 'function' ? metadataObject.getRaw() : null;
	if (typeof raw === 'string' && typeof DOMParser !== 'undefined') {
		const document = new DOMParser().parseFromString(raw, 'application/xml');
		if (!document.querySelector('parsererror')) {
			for (const element of Array.from(document.getElementsByTagName('*'))) {
				const namespace = element.namespaceURI ?? '';
				const prefix = /purl\.org\/dc\/elements/i.test(namespace)
					? 'dc'
					: /prismstandard\.org\/namespaces\/basic/i.test(namespace) ? 'prism' : element.prefix;
				if (!prefix || !element.localName) continue;
				const key = `${prefix}:${element.localName}`.toLowerCase();
				const listItems = Array.from(element.children)
					.flatMap((child) => Array.from(child.children))
					.filter((child) => child.localName.toLowerCase() === 'li');
				const defaultItem = listItems.find((item) => item.getAttribute('xml:lang')?.toLowerCase() === 'x-default');
				const values = listItems.map((item) => item.textContent?.trim() ?? '').filter(Boolean);
				const resource = element.getAttributeNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'resource');
				const text = defaultItem?.textContent?.trim() || resource?.trim() || element.textContent?.trim() || '';
				if (values.length && key !== 'dc:title') metadata[key] = values;
				else if (text) metadata[key] = text;
				for (const attribute of Array.from(element.attributes)) {
					if (!attribute.prefix || attribute.prefix === 'xmlns' || attribute.prefix === 'rdf') continue;
					const attributeNamespace = attribute.namespaceURI ?? '';
					const attributePrefix = /purl\.org\/dc\/elements/i.test(attributeNamespace)
						? 'dc'
						: /prismstandard\.org\/namespaces\/basic/i.test(attributeNamespace) ? 'prism' : attribute.prefix;
					const attributeKey = `${attributePrefix}:${attribute.localName}`.toLowerCase();
					if (attribute.value.trim()) metadata[attributeKey] = attribute.value.trim();
				}
			}
		}
	}
	if (typeof metadataObject[Symbol.iterator] === 'function') {
		for (const entry of value as Iterable<unknown>) {
			if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
			const key = entry[0].toLowerCase();
			if (!(key in metadata)) metadata[key] = entry[1];
		}
	}
	return metadata;
}

export class ReadingNoteMetadataManager extends PDFPlusLibSubmodule {
	getTargetNote(explicitNote?: TFile | null): TFile | null {
		if (explicitNote?.extension === 'md') return explicitNote;
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile?.extension === 'md') return activeFile;

		const visibleNotes = this.getVisibleFiles('md');
		if (this.plugin.lastActiveMarkdownFile && visibleNotes.includes(this.plugin.lastActiveMarkdownFile)) {
			return this.plugin.lastActiveMarkdownFile;
		}
		return visibleNotes.length === 1 ? visibleNotes[0] : null;
	}

	canFill(explicitNote?: TFile | null): boolean {
		return this.getTargetNote(explicitNote) !== null;
	}

	async openPreview(explicitNote?: TFile | null, explicitPdf?: TFile | null): Promise<void> {
		const note = this.getTargetNote(explicitNote);
		if (!note) {
			new Notice(`${this.plugin.manifest.name}: Open the reading note you want to fill.`);
			return;
		}

		const frontmatter = this.getFrontmatter(note);
		const pdf = explicitPdf?.extension === 'pdf'
			? explicitPdf
			: await this.resolvePdf(note, frontmatter, explicitNote == null);
		if (!pdf) return;

		new Notice(`${this.plugin.manifest.name}: Reading metadata from ${pdf.name}…`, 2500);
		const [embeddedCandidates, zoteroMatch] = await Promise.all([
			this.extractPdfCandidates(pdf),
			this.lib.zoteroReferences.findZoteroMetadataForPdfFile(pdf).catch((error) => {
				console.warn(`${this.plugin.manifest.name}: Zotero metadata lookup was unavailable.`, error);
				return null;
			}),
		]);
		const zoteroRecord = zoteroMatch?.record ?? null;
		const referenceMetadata = zoteroRecord
			? {
					citekey: zoteroRecord.citekey,
				authors: zoteroRecord.authors,
				translators: zoteroRecord.translators,
				year: zoteroRecord.year,
				title: zoteroRecord.title,
				journal: zoteroRecord.containerTitle,
				volume: zoteroRecord.volume,
				issue: zoteroRecord.issue,
				pages: zoteroRecord.pages,
				doi: zoteroRecord.doi,
				publisher: zoteroRecord.publisher,
				url: zoteroRecord.url,
				itemType: zoteroRecord.itemType,
					isbn: zoteroRecord.isbn,
					edition: zoteroRecord.edition,
					language: zoteroRecord.language,
					originalTitle: zoteroRecord.originalTitle,
					originalDatePublished: zoteroRecord.originalDatePublished,
					originalPublisher: zoteroRecord.originalPublisher,
					originalLanguage: zoteroRecord.originalLanguage,
					forewordAuthors: zoteroRecord.forewordAuthors,
				}
			: null;
		const zoteroCandidates = referenceMetadata
			? candidatesFromReferenceMetadata(
				referenceMetadata,
				zoteroMatch?.confidence === 'exact'
					? 'exact'
					: getReferenceMetadataConfidence(referenceMetadata, embeddedCandidates),
			)
			: {};
		const pdfLink = this.app.metadataCache.fileToLinktext(pdf, note.path);
		const pdfLinkCandidate = makeReadingNoteCandidate('pdf', `[[${pdfLink}]]`, 'pdf-link', 'exact');
		const linkCandidates: ReadingNoteMetadataCandidates = pdfLinkCandidate ? { pdf: pdfLinkCandidate } : {};
		const candidates = mergeReadingNoteCandidates(zoteroCandidates, embeddedCandidates, linkCandidates);
		const proposals = buildReadingNoteMetadataProposals(frontmatter, candidates);

		if (!proposals.length) {
			new Notice(`${this.plugin.manifest.name}: No supported empty properties could be filled from this PDF.`);
			return;
		}

		new ReadingNoteMetadataPreviewModal(
			this.plugin,
			note,
			pdf,
			proposals,
			async (selected) => this.applyProposals(note, selected),
		).open();
	}

	private getFrontmatter(note: TFile): UnknownRecord {
		let properties: UnknownRecord = {
			...(this.app.metadataCache.getFileCache(note)?.frontmatter ?? {}),
		};
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file !== note) return;
			const match = view.getViewData().match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
			if (!match) return;
			try {
				const parsed = parseYaml(match[1]) as unknown;
				if (isRecord(parsed)) properties = { ...properties, ...parsed };
			} catch (error) {
				console.warn(`${this.plugin.manifest.name}: Could not read the open note's frontmatter.`, error);
			}
		});
		return properties;
	}

	private getVisibleFiles(extension: 'md' | 'pdf'): TFile[] {
		const files: TFile[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!leaf.containerEl.isShown()) return;
			const view = leaf.view;
			if (!(view instanceof FileView) || !(view.file instanceof TFile) || view.file.extension !== extension) return;
			if (!files.includes(view.file)) files.push(view.file);
		});
		return files;
	}

	private getPdfLinkedInFrontmatter(note: TFile, frontmatter: UnknownRecord): { file: TFile | null, hasValue: boolean } {
		const values = Object.entries(frontmatter)
			.filter(([key]) => isReadingNoteMetadataProperty('pdf', key))
			.flatMap(([, value]) => flattenStrings(value));
		for (const value of values) {
			const linkpath = pdfLinkPath(value);
			const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, note.path)
				?? this.app.vault.getAbstractFileByPath(linkpath);
			if (target instanceof TFile && target.extension === 'pdf') return { file: target, hasValue: true };
		}
		return { file: null, hasValue: values.length > 0 };
	}

	private getSameGroupPdfs(note: TFile): TFile[] {
		const mostRecentLeaf = this.app.workspace.getMostRecentLeaf();
		let noteLeaf = mostRecentLeaf?.view instanceof FileView && mostRecentLeaf.view.file === note
			? mostRecentLeaf
			: null;
		if (!noteLeaf) {
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (noteLeaf || !leaf.containerEl.isShown()) return;
				const view = leaf.view;
				if (view instanceof FileView && view.file === note) noteLeaf = leaf;
			});
		}
		if (!noteLeaf?.group) return [];
		return this.app.workspace.getGroupLeaves(noteLeaf.group)
			.map((leaf) => leaf.view instanceof FileView ? leaf.view.file : null)
			.filter((file): file is TFile => file instanceof TFile && file.extension === 'pdf');
	}

	private async resolvePdf(
		note: TFile,
		frontmatter: UnknownRecord,
		preferActivePdf: boolean,
	): Promise<TFile | null> {
		const linked = this.getPdfLinkedInFrontmatter(note, frontmatter);
		if (linked.file) return linked.file;
		if (linked.hasValue) {
			new Notice(`${this.plugin.manifest.name}: The note's PDF property does not resolve to a PDF in this vault.`);
			return null;
		}

		const activeFile = this.app.workspace.getActiveFile();
		if (preferActivePdf && activeFile?.extension === 'pdf') return activeFile;

		const sameGroup = this.getSameGroupPdfs(note);
		if (sameGroup.length === 1) return sameGroup[0];
		if (sameGroup.length > 1) return await this.choosePdf(sameGroup);

		const visiblePdfs = this.getVisibleFiles('pdf');
		if (visiblePdfs.length === 1) return visiblePdfs[0];
		if (visiblePdfs.length > 1) return await this.choosePdf(visiblePdfs);

		new Notice(`${this.plugin.manifest.name}: Open the source PDF beside this note, then run the command again.`);
		return null;
	}

	private async choosePdf(files: TFile[]): Promise<TFile | null> {
		return await new Promise<TFile | null>((resolve) => {
			new ReadingNotePdfSuggestModal(this.plugin, files, resolve).open();
		});
	}

	private async extractPdfCandidates(pdf: TFile): Promise<ReadingNoteMetadataCandidates> {
		let document: PDFDocumentProxy | null = null;
		try {
			document = await this.lib.loadPDFDocument(pdf);
			const result = await document.getMetadata() as { info?: unknown, metadata?: unknown };
			const frontMatterPages = await collectPdfFrontMatterPages(document, {
				pageLimit: FRONT_MATTER_PAGE_LIMIT,
				characterLimit: FRONT_MATTER_PAGE_CHARACTER_LIMIT,
				onError: (pageNumber, phase, error) => {
					console.warn(`${this.plugin.manifest.name}: Could not ${phase} PDF front-matter page ${pageNumber} from ${pdf.path}.`, error);
				},
			});
			return extractEmbeddedPdfMetadata({
				info: result.info,
				xmp: metadataMap(result.metadata),
				firstPageText: frontMatterPages[0] ?? '',
				frontMatterPages,
				fileBasename: pdf.basename,
			});
		} finally {
			await document?.destroy();
		}
	}

	private async applyProposals(note: TFile, proposals: ReadingNoteMetadataProposal[]): Promise<void> {
		if (!proposals.length) {
			new Notice(`${this.plugin.manifest.name}: No properties were selected.`);
			return;
		}
		let filled = 0;
		let skipped = 0;
		try {
			await this.app.fileManager.processFrontMatter(note, (frontmatter: UnknownRecord) => {
				for (const proposal of proposals) {
					if (!Object.prototype.hasOwnProperty.call(frontmatter, proposal.property)
						|| !isBlankFrontmatterValue(frontmatter[proposal.property])) {
						skipped++;
						continue;
					}
					frontmatter[proposal.property] = proposal.value;
					filled++;
				}
			});
		} catch (error) {
			console.error(`${this.plugin.manifest.name}: Failed to fill reading-note properties.`, error);
			new Notice(`${this.plugin.manifest.name}: The properties could not be updated. Check that the note's YAML is valid.`);
			throw error;
		}
		const skippedText = skipped ? ` ${skipped} changed property ${skipped === 1 ? 'was' : 'were'} left alone.` : '';
		new Notice(`${this.plugin.manifest.name}: Filled ${filled} empty ${filled === 1 ? 'property' : 'properties'}.${skippedText}`);
	}
}
