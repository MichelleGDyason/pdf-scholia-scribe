import { FileView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from 'obsidian';

import type PDFPlus from 'main';
import { renderDocxDocument } from 'docx-renderer';
import {
	ScholiaAnnotation,
	ScholiaAnnotationModal,
	ScholiaAnnotationStore,
	ScholiaDocumentKind,
	TextQuoteAnchor,
	createAnnotationId,
} from 'document-annotations';


export const SCHOLIA_DOCUMENT_VIEW_TYPE = 'scholia-document-view';
export const SCHOLIA_DOCUMENT_EXTENSIONS = ['docx', 'gdoc', 'txt', 'text', 'doc'];

interface GoogleDocumentReference {
	url: string;
	documentId: string | null;
}

const getTextOffset = (root: HTMLElement, container: Node, offset: number): number => {
	const range = root.ownerDocument.createRange();
	range.selectNodeContents(root);
	range.setEnd(container, offset);
	return range.cloneContents().textContent?.length ?? 0;
};

const createTextQuoteAnchor = (root: HTMLElement, selection: Selection): TextQuoteAnchor | null => {
	if (selection.rangeCount !== 1 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return null;

	let start = getTextOffset(root, range.startContainer, range.startOffset);
	let end = getTextOffset(root, range.endContainer, range.endOffset);
	const fullText = root.textContent ?? '';
	const selectedText = fullText.slice(start, end);
	const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
	const trailingWhitespace = selectedText.length - selectedText.trimEnd().length;
	start += leadingWhitespace;
	end -= trailingWhitespace;
	const exact = fullText.slice(start, end);
	if (!exact) return null;
	return {
		start,
		end,
		exact,
		prefix: fullText.slice(Math.max(0, start - 48), start),
		suffix: fullText.slice(end, end + 48),
	};
};

const resolveTextQuoteAnchor = (text: string, anchor: TextQuoteAnchor): { start: number; end: number } | null => {
	if (text.slice(anchor.start, anchor.end) === anchor.exact) return { start: anchor.start, end: anchor.end };
	let best: { start: number; end: number; score: number } | null = null;
	let start = text.indexOf(anchor.exact);
	while (start !== -1) {
		const end = start + anchor.exact.length;
		let score = 0;
		if (anchor.prefix && text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix) score += 2;
		if (anchor.suffix && text.slice(end, end + anchor.suffix.length) === anchor.suffix) score += 2;
		score -= Math.min(1, Math.abs(start - anchor.start) / Math.max(1, text.length));
		if (!best || score > best.score) best = { start, end, score };
		start = text.indexOf(anchor.exact, start + 1);
	}
	return best ? { start: best.start, end: best.end } : null;
};

const highlightAnnotation = (root: HTMLElement, annotation: ScholiaAnnotation): void => {
	if (!annotation.anchor || !annotation.quote) return;
	const resolved = resolveTextQuoteAnchor(root.textContent ?? '', annotation.anchor);
	if (!resolved) return;

	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Array<{ node: Text; start: number; end: number }> = [];
	let cursor = 0;
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		const start = cursor;
		cursor += node.data.length;
		if (cursor > resolved.start && start < resolved.end) nodes.push({ node, start, end: cursor });
	}

	for (const entry of nodes.reverse()) {
		const localStart = Math.max(0, resolved.start - entry.start);
		const localEnd = Math.min(entry.node.data.length, resolved.end - entry.start);
		if (localStart >= localEnd) continue;
		const selectedNode = entry.node.splitText(localStart);
		selectedNode.splitText(localEnd - localStart);
		const mark = createEl('mark');
		mark.className = `scholia-document-highlight is-${annotation.status}`;
		mark.dataset.annotationId = annotation.id;
		selectedNode.replaceWith(mark);
		mark.appendChild(selectedNode);
	}
};

const parseGoogleDocumentReference = (raw: string): GoogleDocumentReference | null => {
	let url = raw.trim();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === 'object' && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			const candidate = record.url ?? record.doc_url ?? record.document_url;
			if (typeof candidate === 'string') url = candidate;
			if (!url && typeof record.doc_id === 'string') url = `https://docs.google.com/document/d/${record.doc_id}/edit`;
		}
	} catch {
		// Some Google Drive clients store the sharing URL as plain text instead of JSON.
	}
	if (!/^https:\/\/docs\.google\.com\//i.test(url)) return null;
	let documentId = url.match(/\/document\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
	if (!documentId) {
		try {
			documentId = new URL(url).searchParams.get('id');
		} catch {
			return null;
		}
	}
	return { url, documentId };
};

export class ScholiaDocumentView extends FileView {
	private documentEl: HTMLElement | null = null;
	private annotationsEl: HTMLElement | null = null;
	private annotations: ScholiaAnnotation[] = [];
	private annotationNote: TFile | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PDFPlus,
		private annotationStore: ScholiaAnnotationStore,
	) {
		super(leaf);
	}

	getViewType(): string {
		return SCHOLIA_DOCUMENT_VIEW_TYPE;
	}

	getIcon(): string {
		return this.file?.extension === 'gdoc' ? 'file-cloud' : 'file-text';
	}

	canAcceptExtension(extension: string): boolean {
		return SCHOLIA_DOCUMENT_EXTENSIONS.includes(extension.toLowerCase());
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('scholia-document-view');
		const toolbar = this.contentEl.createDiv('scholia-document-toolbar');
		const title = toolbar.createDiv('scholia-document-title');
		setIcon(title.createSpan('scholia-document-title-icon'), this.getIcon());
		title.createSpan({ text: file.basename });
		const actions = toolbar.createDiv('scholia-document-actions');

		const layout = this.contentEl.createDiv('scholia-document-layout');
		this.documentEl = layout.createDiv('scholia-document-content');
		this.annotationsEl = layout.createEl('aside', { cls: 'scholia-document-annotations' });

		try {
			if (file.extension === 'docx') await this.renderDocx(file, actions);
			else if (file.extension === 'gdoc') await this.renderGoogleDoc(file, actions);
			else if (file.extension === 'txt' || file.extension === 'text') await this.renderText(file, actions);
			else this.renderLegacyDoc(actions);
		} catch (error) {
			console.error(error);
			this.renderError('This document could not be displayed. The source file was not changed.');
		}

		await this.reloadAnnotations();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.documentEl = null;
		this.annotationsEl = null;
		this.annotations = [];
		this.annotationNote = null;
		await super.onUnloadFile(file);
	}

	private async renderDocx(file: TFile, actions: HTMLElement): Promise<void> {
		if (!this.documentEl) return;
		const annotateButton = this.createActionButton(actions, 'highlighter', 'Annotate selection');
		annotateButton.addEventListener('click', () => this.annotateSelection('docx'));
		const noteButton = this.createActionButton(actions, 'message-square-plus', 'Add document note');
		noteButton.addEventListener('click', () => this.addDocumentNote('docx'));

		const result = await renderDocxDocument(await this.app.vault.readBinary(file), this.documentEl);
		if (result.warnings.length) {
			const details = this.documentEl.createEl('details', { cls: 'scholia-document-conversion-notes' });
			details.createEl('summary', { text: `${result.warnings.length} document rendering note${result.warnings.length === 1 ? '' : 's'}` });
			const list = details.createEl('ul');
			for (const warning of result.warnings) list.createEl('li', { text: warning });
		}
	}

	private async renderText(file: TFile, actions: HTMLElement): Promise<void> {
		if (!this.documentEl) return;
		const annotateButton = this.createActionButton(actions, 'highlighter', 'Annotate selection');
		annotateButton.addEventListener('click', () => this.annotateSelection('text'));
		const text = await this.app.vault.cachedRead(file);
		this.documentEl.createEl('pre', { text, cls: 'scholia-plain-text' });
	}

	private async renderGoogleDoc(file: TFile, actions: HTMLElement): Promise<void> {
		if (!this.documentEl) return;
		const raw = await this.app.vault.cachedRead(file);
		const reference = parseGoogleDocumentReference(raw);
		if (!reference) {
			this.renderError('This .gdoc file does not contain a recognised Google Docs URL.');
			return;
		}

		const openButton = this.createActionButton(actions, 'external-link', 'Open in Google Docs');
		openButton.addEventListener('click', () => window.open(reference.url, '_blank'));
		const noteButton = this.createActionButton(actions, 'message-square-plus', 'Add portal note');
		noteButton.addEventListener('click', () => this.addDocumentNote('gdoc', true));

		const explanation = this.documentEl.createDiv('scholia-google-docs-note');
		explanation.createEl('strong', { text: 'Google collaboration stays native.' });
		explanation.appendText(' Use Google Docs comments and suggestions in the embedded editor; Scholia portal notes are for research context shared through this vault.');

		if (reference.documentId) {
			const iframe = this.documentEl.createEl('iframe', { cls: 'scholia-google-doc-frame' });
			iframe.src = `https://docs.google.com/document/d/${reference.documentId}/edit?rm=minimal&embedded=true`;
			iframe.title = file.basename;
			iframe.setAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts');
			iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
		} else {
			this.documentEl.createEl('p', { text: 'Open this document in Google Docs to view and collaborate.' });
		}
	}

	private renderLegacyDoc(actions: HTMLElement): void {
		if (!this.documentEl) return;
		const panel = this.documentEl.createDiv('scholia-document-empty-state');
		setIcon(panel.createDiv(), 'file-warning');
		panel.createEl('h2', { text: 'Convert this legacy Word file to DOCX' });
		panel.createEl('p', { text: 'The old .doc format does not provide reliable text anchors. Open it in Word or LibreOffice, save a .docx copy, and annotate that copy here. The original file remains untouched.' });
		if (Platform.isMobile) actions.addClass('is-mobile');
	}

	private renderError(message: string): void {
		if (!this.documentEl) return;
		this.documentEl.empty();
		const panel = this.documentEl.createDiv('scholia-document-empty-state');
		setIcon(panel.createDiv(), 'circle-alert');
		panel.createEl('p', { text: message });
	}

	private createActionButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const button = parent.createEl('button', { cls: 'clickable-icon scholia-document-action', attr: { 'aria-label': label } });
		setIcon(button, icon);
		button.createSpan({ text: label });
		return button;
	}

	private annotateSelection(sourceKind: ScholiaDocumentKind): void {
		if (!this.file || !this.documentEl) return;
		const selection = this.documentEl.ownerDocument.getSelection();
		const anchor = selection ? createTextQuoteAnchor(this.documentEl, selection) : null;
		if (!selection || !anchor) {
			new Notice('Select a passage in the document first.');
			return;
		}
		this.openAnnotationModal({ sourceKind, quote: anchor.exact, anchor });
	}

	private addDocumentNote(sourceKind: ScholiaDocumentKind, allowQuoteEditing = false): void {
		if (!this.file) return;
		this.openAnnotationModal({ sourceKind, quote: '', allowQuoteEditing });
	}

	private openAnnotationModal(options: {
		sourceKind: ScholiaDocumentKind;
		quote: string;
		anchor?: TextQuoteAnchor;
		allowQuoteEditing?: boolean;
	}): void {
		const file = this.file;
		if (!file) return;
		const defaultAuthor = this.plugin.settings.author && this.plugin.settings.author !== 'PDF Scholia Scribe'
			? this.plugin.settings.author
			: 'Me';
		new ScholiaAnnotationModal({
			app: this.app,
			title: options.anchor ? 'Annotate selected passage' : 'Add document note',
			quote: options.quote,
			author: defaultAuthor,
			allowQuoteEditing: options.allowQuoteEditing,
			onSubmit: async ({ quote, comment, author }) => {
				const annotation: ScholiaAnnotation = {
					version: 1,
					id: createAnnotationId(),
					sourcePath: file.path,
					sourceKind: options.sourceKind,
					quote,
					comment,
					author,
					createdAt: new Date().toISOString(),
					status: 'open',
					anchor: options.anchor,
				};
				this.annotationNote = await this.annotationStore.add(annotation);
				this.annotations.push(annotation);
				if (this.documentEl) highlightAnnotation(this.documentEl, annotation);
				this.renderAnnotationRail();
				new Notice('Annotation added to the Scholia collaboration portal.');
			},
		}).open();
	}

	private async reloadAnnotations(): Promise<void> {
		if (!this.file || !this.annotationsEl) return;
		this.annotations = await this.annotationStore.listForSource(this.file.path);
		const note = this.app.vault.getAbstractFileByPath(this.annotationStore.getAnnotationPath(this.file.path));
		this.annotationNote = note instanceof TFile ? note : null;
		if (this.documentEl) {
			for (const annotation of this.annotations) highlightAnnotation(this.documentEl, annotation);
		}
		this.renderAnnotationRail();
	}

	private renderAnnotationRail(): void {
		if (!this.annotationsEl) return;
		this.annotationsEl.empty();
		const heading = this.annotationsEl.createDiv('scholia-annotation-rail-heading');
		heading.createEl('h3', { text: 'Discussion' });
		heading.createSpan({ text: String(this.annotations.length), cls: 'scholia-annotation-count' });
		if (!this.annotations.length) {
			this.annotationsEl.createEl('p', { text: 'Select text to annotate it, or add a document-level note.', cls: 'scholia-annotation-empty' });
			return;
		}

		for (const annotation of this.annotations) {
			const card = this.annotationsEl.createDiv(`scholia-annotation-card is-${annotation.status}`);
			card.dataset.annotationId = annotation.id;
			const metadata = card.createDiv('scholia-annotation-meta');
			metadata.createEl('strong', { text: annotation.author });
			metadata.createEl('time', { text: new Date(annotation.createdAt).toLocaleString(), attr: { datetime: annotation.createdAt } });
			if (annotation.quote) card.createEl('blockquote', { text: annotation.quote });
			card.createEl('p', { text: annotation.comment });
			const actions = card.createDiv('scholia-annotation-card-actions');
			const showButton = actions.createEl('button', { text: 'Show passage' });
			showButton.addEventListener('click', () => this.revealAnnotation(annotation.id));
			const statusButton = actions.createEl('button', { text: annotation.status === 'open' ? 'Resolve' : 'Reopen' });
			statusButton.addEventListener('click', () => void this.toggleStatus(annotation));
			if (this.annotationNote) {
				const noteButton = actions.createEl('button', { text: 'Open thread note' });
				noteButton.addEventListener('click', () => {
					if (this.annotationNote) void this.app.workspace.getLeaf(true).openFile(this.annotationNote);
				});
			}
		}
	}

	private async toggleStatus(annotation: ScholiaAnnotation): Promise<void> {
		if (!this.annotationNote) return;
		await this.annotationStore.setStatus(
			this.annotationNote,
			annotation.id,
			annotation.status === 'open' ? 'resolved' : 'open',
		);
		const status = annotation.status === 'open' ? 'resolved' : 'open';
		this.annotations = this.annotations.map((current) => current.id === annotation.id ? { ...current, status } : current);
		this.updateAnnotationHighlightStatus(annotation.id, status);
		this.renderAnnotationRail();
	}

	/** Scroll the document to one persisted text anchor without reconstructing the viewer. */
	private revealAnnotation(annotationId: string): void {
		const marks = this.getAnnotationMarks(annotationId);
		const firstMark = marks[0];
		if (!firstMark) {
			new Notice('This annotation no longer matches text in the current document version.');
			return;
		}
		firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
		for (const mark of marks) mark.addClass('is-focused');
		window.setTimeout(() => {
			for (const mark of marks) mark.removeClass('is-focused');
		}, 1800);
	}

	private updateAnnotationHighlightStatus(annotationId: string, status: ScholiaAnnotation['status']): void {
		for (const mark of this.getAnnotationMarks(annotationId)) {
			mark.removeClass('is-open', 'is-resolved');
			mark.addClass(`is-${status}`);
		}
	}

	private getAnnotationMarks(annotationId: string): HTMLElement[] {
		if (!this.documentEl) return [];
		return Array.from(this.documentEl.querySelectorAll<HTMLElement>(`mark.scholia-document-highlight[data-annotation-id="${annotationId}"]`));
	}
}
