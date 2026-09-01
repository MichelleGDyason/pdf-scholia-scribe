import { ButtonComponent, MarkdownView, Notice, Setting, TextAreaComponent } from 'obsidian';

import { PDFPlusModal } from './base-modal';
import { ZoteroAnnotationImportModal } from './zotero-annotation-import-modal';
import type { AnnotationDocument, ReadingAppImportSource } from 'lib/annotation-import';

type ModalImportSource = 'zotero' | ReadingAppImportSource;

const SOURCE_HELP: Record<ModalImportSource, string> = {
	zotero: 'Search your open Zotero library and import PDF annotations plus related Zotero notes.',
	kindle: 'Choose My Clippings.txt or an annotated/searchable PDF exported from Kindle Scribe.',
	'apple-books': 'Choose shared text, HTML, or an annotated PDF. You can also paste shared highlights and notes below.',
	'apple-preview': 'Choose PDFs saved by Apple Preview with editable annotations. Flattened PDFs cannot expose their annotation objects.',
};

const SOURCE_ACCEPT: Record<ReadingAppImportSource, string> = {
	kindle: '.txt,.pdf,text/plain,application/pdf',
	'apple-books': '.txt,.html,.htm,.pdf,text/plain,text/html,application/pdf',
	'apple-preview': '.pdf,application/pdf',
};

function documentKey(document: AnnotationDocument) {
	return `${document.provider}:${document.documentId}`;
}

export class AnnotationImportModal extends PDFPlusModal {
	view: MarkdownView;
	source: ModalImportSource = 'kindle';
	files: File[] = [];
	documents: AnnotationDocument[] = [];
	selectedDocuments = new Set<string>();
	fileInput: HTMLInputElement | null = null;
	pasteInput: TextAreaComponent | null = null;
	helpEl: HTMLElement | null = null;
	pasteContainerEl: HTMLElement | null = null;
	statusEl: HTMLElement | null = null;
	previewEl: HTMLElement | null = null;
	parseButton: ButtonComponent | null = null;
	importButton: ButtonComponent | null = null;

	constructor(plugin: ConstructorParameters<typeof PDFPlusModal>[0], view: MarkdownView) {
		super(plugin);
		this.view = view;
	}

	onOpen() {
		super.onOpen();
		this.titleEl.setText(`${this.plugin.manifest.name}: Import reading annotations`);
		this.contentEl.addClass('pdf-scholia-annotation-import');
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `Import annotations into ${this.view.file?.path ?? 'the active Markdown note'}. Scholia preserves the available text, comments, colours, pages or locations, dates, and source identity in refreshable managed sections.`,
		});

		new Setting(this.contentEl)
			.setName('Annotation source')
			.setDesc('Choose the app that produced the export.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('zotero', 'Zotero')
					.addOption('kindle', 'Kindle')
					.addOption('apple-books', 'Apple Books')
					.addOption('apple-preview', 'Apple Preview')
					.setValue(this.source)
					.onChange((value) => {
						this.source = value as ModalImportSource;
						this.resetSelection();
						this.updateSourceUi();
					});
			});

		this.helpEl = this.contentEl.createDiv({ cls: 'pdf-scholia-import-help setting-item-description' });

		const fileSetting = new Setting(this.contentEl)
			.setName('Export files')
			.setDesc('You can select more than one file. Files are read locally and are not uploaded.');
		this.fileInput = fileSetting.controlEl.createEl('input', { type: 'file' });
		this.fileInput.multiple = true;
		this.component.registerDomEvent(this.fileInput, 'change', () => {
			this.files = Array.from(this.fileInput?.files ?? []);
			this.setStatus(this.files.length
				? `${this.files.length} file${this.files.length === 1 ? '' : 's'} ready to inspect.`
				: 'No files selected.');
		});

		this.pasteContainerEl = this.contentEl.createDiv('pdf-scholia-import-paste');
		new Setting(this.pasteContainerEl)
			.setName('Paste Apple Books highlights or notes')
			.setDesc('Optional: paste shared text or HTML instead of choosing a file.')
			.addTextArea((text) => {
				this.pasteInput = text;
				text.setPlaceholder('Paste shared Apple Books text here...');
				text.inputEl.rows = 7;
				text.inputEl.cols = 48;
			});

		this.statusEl = this.contentEl.createDiv('pdf-scholia-import-status');
		this.previewEl = this.contentEl.createDiv('pdf-scholia-import-preview');

		const actions = this.contentEl.createDiv('modal-button-container');
		new ButtonComponent(actions).setButtonText('Cancel').onClick(() => this.close());
		this.parseButton = new ButtonComponent(actions)
			.setButtonText('Inspect exports')
			.onClick(() => this.inspectExports());
		this.importButton = new ButtonComponent(actions)
			.setButtonText('Import selected documents')
			.setCta()
			.setDisabled(true)
			.onClick(() => this.importSelected());

		this.updateSourceUi();
	}

	resetSelection() {
		this.files = [];
		this.documents = [];
		this.selectedDocuments.clear();
		if (this.fileInput) this.fileInput.value = '';
		this.pasteInput?.setValue('');
		this.previewEl?.empty();
		this.importButton?.setDisabled(true).setButtonText('Import selected documents');
	}

	updateSourceUi() {
		this.helpEl?.setText(SOURCE_HELP[this.source]);
		const isZotero = this.source === 'zotero';
		if (this.fileInput) {
			this.fileInput.disabled = isZotero;
			if (this.source === 'zotero') this.fileInput.accept = '';
			else {
				const source: ReadingAppImportSource = this.source;
				this.fileInput.accept = SOURCE_ACCEPT[source];
			}
		}
		this.pasteContainerEl?.toggle(this.source === 'apple-books');
		this.parseButton?.setButtonText(isZotero ? 'Open Zotero importer' : 'Inspect exports');
		this.importButton?.setDisabled(true);
		this.setStatus(isZotero ? 'Zotero must be open with its local API enabled.' : 'Choose one or more export files.');
	}

	async inspectExports() {
		if (this.source === 'zotero') {
			this.close();
			new ZoteroAnnotationImportModal(this.plugin, this.view).open();
			return;
		}
		const pasted = this.source === 'apple-books' ? this.pasteInput?.getValue().trim() ?? '' : '';
		if (!this.files.length && !pasted) {
			this.setStatus('Choose an export file or paste Apple Books text first.');
			return;
		}

		this.setStatus('Reading annotations locally...');
		this.previewEl?.empty();
		this.parseButton?.setDisabled(true);
		try {
			const documents = await this.lib.annotationImports.parseFiles(this.source, this.files);
			if (pasted) documents.push(...await this.lib.annotationImports.parseAppleBooksText(pasted));
			this.documents = this.lib.annotationImports.mergeDocuments(documents);
			this.selectedDocuments = new Set(this.documents.map(documentKey));
			this.renderPreview();
			const count = this.documents.reduce((total, document) => total + document.annotations.length, 0);
			this.setStatus(this.documents.length
				? `${this.documents.length} document${this.documents.length === 1 ? '' : 's'} found with ${count} annotation${count === 1 ? '' : 's'}. Review notices before importing.`
				: 'No annotation documents were recognised in the selected exports.');
		} catch (error) {
			console.error(error);
			this.documents = [];
			this.selectedDocuments.clear();
			this.setStatus(error instanceof Error ? error.message : 'The selected exports could not be read.');
		} finally {
			this.parseButton?.setDisabled(false);
			this.updateImportButton();
		}
	}

	renderPreview() {
		this.previewEl?.empty();
		for (const document of this.documents) {
			const label = this.previewEl?.createEl('label', { cls: 'pdf-scholia-import-document' });
			if (!label) continue;
			const checkbox = label.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.selectedDocuments.has(documentKey(document));
			const summary = label.createDiv();
			summary.createEl('strong', { text: document.title });
			summary.createEl('small', {
				text: [
					document.author,
					document.sourcePath,
					`${document.annotations.length} annotation${document.annotations.length === 1 ? '' : 's'}`,
				].filter(Boolean).join(' · '),
			});
			for (const warning of document.warnings) {
				summary.createEl('small', { cls: 'pdf-scholia-import-warning', text: warning });
			}
			this.component.registerDomEvent(checkbox, 'change', () => {
				if (checkbox.checked) this.selectedDocuments.add(documentKey(document));
				else this.selectedDocuments.delete(documentKey(document));
				this.updateImportButton();
			});
		}
	}

	updateImportButton() {
		const count = this.selectedDocuments.size;
		this.importButton
			?.setDisabled(count === 0)
			.setButtonText(count ? `Import ${count} document${count === 1 ? '' : 's'}` : 'Import selected documents');
	}

	importSelected() {
		const documents = this.documents.filter((document) => this.selectedDocuments.has(documentKey(document)));
		if (!documents.length) {
			new Notice(`${this.plugin.manifest.name}: Select at least one document.`);
			return;
		}
		const result = this.lib.annotationImports.importDocuments(this.view, documents);
		new Notice(`${this.plugin.manifest.name}: Imported ${result.annotationCount} annotation${result.annotationCount === 1 ? '' : 's'} from ${result.documentCount} document${result.documentCount === 1 ? '' : 's'}${result.warningCount ? ` with ${result.warningCount} import notice${result.warningCount === 1 ? '' : 's'}` : ''}.`);
		this.close();
	}

	setStatus(text: string) {
		this.statusEl?.setText(text);
	}
}
