import { ButtonComponent, MarkdownView, Notice, Setting, TextComponent } from 'obsidian';

import { PDFPlusModal } from './base-modal';
import { ScholiaReferenceRecord, ScholiaZoteroPdf } from 'lib/zotero-references';


export class ZoteroAnnotationImportModal extends PDFPlusModal {
	view: MarkdownView;
	queryInput: TextComponent | null = null;
	resultsEl: HTMLElement | null = null;
	statusEl: HTMLElement | null = null;
	selectionEl: HTMLElement | null = null;
	importButton: ButtonComponent | null = null;
	selectedPdfs = new Map<string, ScholiaZoteroPdf>();

	constructor(plugin: ConstructorParameters<typeof PDFPlusModal>[0], view: MarkdownView) {
		super(plugin);
		this.view = view;
	}

	onOpen() {
		super.onOpen();

		this.titleEl.setText(`${this.plugin.manifest.name}: Import Zotero annotations`);
		this.contentEl.addClass('pdf-scholia-zotero-annotation-import');
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `Choose Zotero PDF attachments to import into ${this.view.file?.path ?? 'the active note'}. Scholia also includes Zotero notes containing annotations from those PDFs. Re-importing refreshes the managed sections.`,
		});

		new Setting(this.contentEl)
			.setName('Find a Zotero source')
			.setDesc('Search by author, title, year, or citation key, then load its PDF attachments.')
			.addText((text) => {
				this.queryInput = text;
				text.setPlaceholder('Deleuze 1983');
				text.inputEl.size = 34;
				this.component.registerDomEvent(text.inputEl, 'keydown', (evt) => {
					if (evt.key === 'Enter') void this.search().catch(console.error);
				});
				window.setTimeout(() => text.inputEl.focus());
			})
			.addButton((button) => {
				button
					.setButtonText('Search')
					.setCta()
					.onClick(() => this.search());
			});

		this.statusEl = this.contentEl.createDiv('pdf-scholia-zotero-import-status');
		this.resultsEl = this.contentEl.createDiv('pdf-scholia-zotero-results');
		this.selectionEl = this.contentEl.createDiv('pdf-scholia-zotero-import-selection');

		const actions = this.contentEl.createDiv('modal-button-container');
		new ButtonComponent(actions)
			.setButtonText('Cancel')
			.onClick(() => this.close());
		this.importButton = new ButtonComponent(actions)
			.setButtonText('Import selected files')
			.setCta()
			.setDisabled(true)
			.onClick(() => this.importSelected());
		this.updateSelectionSummary();
	}

	async search() {
		const query = this.queryInput?.getValue().trim() ?? '';
		if (!query) {
			this.setStatus('Type an author, title, year, or citation key.');
			return;
		}

		this.setStatus('Searching the Zotero library...');
		this.resultsEl?.empty();
		const records = await this.lib.zoteroReferences.searchZoteroAnnotationSources(query);
		if (!records.length) {
			this.setStatus('No matching Zotero source found. Make sure Zotero is open and its local API is enabled.');
			return;
		}

		this.setStatus(`${records.length} source${records.length === 1 ? '' : 's'} found. Load the source whose PDFs you want.`);
		for (const record of records) this.renderSource(record);
	}

	renderSource(record: ScholiaReferenceRecord) {
		const rowEl = this.resultsEl?.createDiv('pdf-scholia-zotero-result pdf-scholia-zotero-import-source');
		if (!rowEl) return;

		const summaryEl = rowEl.createDiv('pdf-scholia-zotero-import-source-summary');
		summaryEl.createEl('strong', { text: record.title || record.citekey || 'Untitled source' });
		const details = [
			record.authors.join(', '),
			record.year,
			record.citekey ? `@${record.citekey}` : '',
		].filter(Boolean).join(' · ');
		if (details) summaryEl.createDiv({ text: details });

		const pdfsEl = rowEl.createDiv('pdf-scholia-zotero-import-pdfs');
		const loadButton = new ButtonComponent(rowEl);
		loadButton
			.setButtonText('Load attachments')
			.onClick(async () => {
				loadButton.setDisabled(true).setButtonText('Loading...');
				pdfsEl.empty();
				try {
					const pdfs = await this.lib.zoteroReferences.getAnnotatedPdfsForSource(record);
					if (!pdfs.length) {
						pdfsEl.createDiv({
							cls: 'setting-item-description',
							text: 'No PDF attachments found for this source.',
						});
						loadButton.setButtonText('Reload attachments');
						return;
					}
					for (const pdf of pdfs) this.renderPdf(pdf, pdfsEl);
					this.updateSelectionSummary();
					loadButton.setButtonText('Reload attachments');
				} catch (error) {
					console.error(error);
					pdfsEl.createDiv({
						cls: 'setting-item-description',
						text: 'The PDF annotations could not be loaded. Make sure Zotero is open.',
					});
					loadButton.setButtonText('Try again');
				} finally {
					loadButton.setDisabled(false);
				}
			});
	}

	renderPdf(pdf: ScholiaZoteroPdf, parent: HTMLElement) {
		const labelEl = parent.createEl('label', { cls: 'pdf-scholia-zotero-import-pdf' });
		const checkbox = labelEl.createEl('input', { type: 'checkbox' });
		const wasSelected = this.selectedPdfs.has(pdf.attachmentKey);
		checkbox.checked = wasSelected;
		if (wasSelected) this.selectedPdfs.set(pdf.attachmentKey, pdf);
		const textEl = labelEl.createDiv();
		textEl.createEl('strong', { text: pdf.attachmentTitle });
		textEl.createEl('small', {
			text: `${pdf.annotations.length} PDF annotation${pdf.annotations.length === 1 ? '' : 's'} · ${pdf.notes.length} Zotero note${pdf.notes.length === 1 ? '' : 's'}${pdf.annotations.length || pdf.notes.length ? '' : ' — selecting this PDF will refresh an existing section to empty'}`,
		});
		this.component.registerDomEvent(checkbox, 'change', () => {
			if (checkbox.checked) this.selectedPdfs.set(pdf.attachmentKey, pdf);
			else this.selectedPdfs.delete(pdf.attachmentKey);
			this.updateSelectionSummary();
		});
	}

	importSelected() {
		const pdfs = Array.from(this.selectedPdfs.values());
		if (!pdfs.length) {
			new Notice(`${this.plugin.manifest.name}: Select at least one Zotero PDF.`);
			return;
		}

		const result = this.lib.zoteroReferences.importZoteroAnnotations(this.view, pdfs);
		new Notice(`${this.plugin.manifest.name}: Imported ${result.annotationCount} PDF annotation${result.annotationCount === 1 ? '' : 's'} and ${result.noteCount} Zotero note${result.noteCount === 1 ? '' : 's'} containing ${result.noteAnnotationCount} embedded annotation${result.noteAnnotationCount === 1 ? '' : 's'} from ${result.pdfCount} PDF${result.pdfCount === 1 ? '' : 's'}.`);
		this.close();
	}

	updateSelectionSummary() {
		const pdfCount = this.selectedPdfs.size;
		const pdfs = Array.from(this.selectedPdfs.values());
		const annotationCount = pdfs
			.reduce((count, pdf) => count + pdf.annotations.length, 0);
		const notes = new Map(pdfs.flatMap((pdf) => pdf.notes).map((note) => [note.key, note]));
		const noteAnnotationCount = Array.from(notes.values())
			.reduce((count, note) => count + note.annotationCount, 0);
		if (this.selectionEl) {
			this.selectionEl.setText(pdfCount
				? `${pdfCount} PDF${pdfCount === 1 ? '' : 's'} selected · ${annotationCount} PDF annotation${annotationCount === 1 ? '' : 's'} · ${notes.size} Zotero note${notes.size === 1 ? '' : 's'} (${noteAnnotationCount} embedded annotation${noteAnnotationCount === 1 ? '' : 's'})`
				: 'No PDFs selected.');
		}
		this.importButton
			?.setDisabled(pdfCount === 0)
			.setButtonText(pdfCount === 0 ? 'Import selected files' : `Import ${pdfCount} PDF${pdfCount === 1 ? '' : 's'}`);
	}

	setStatus(text: string) {
		this.statusEl?.setText(text);
	}
}
