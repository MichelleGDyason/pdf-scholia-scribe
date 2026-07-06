import { ButtonComponent, MarkdownView, Setting, TextComponent } from 'obsidian';

import { PDFPlusModal } from './base-modal';
import { ScholiaCitationTextMode, ScholiaReferenceRecord, ScholiaReferenceSearchSource } from 'lib/zotero-references';


export class ZoteroCitationModal extends PDFPlusModal {
	view: MarkdownView;
	queryInput: TextComponent | null = null;
	pageInput: TextComponent | null = null;
	resultsEl: HTMLElement | null = null;
	statusEl: HTMLElement | null = null;
	source: ScholiaReferenceSearchSource = 'all';
	textMode: ScholiaCitationTextMode = 'default';

	constructor(plugin: ConstructorParameters<typeof PDFPlusModal>[0], view: MarkdownView) {
		super(plugin);
		this.view = view;
	}

	onOpen() {
		super.onOpen();

		this.titleEl.setText(`${this.plugin.manifest.name}: Insert citation`);

		new Setting(this.contentEl)
			.setName('Search Zotero and vault notes')
			.setDesc('Type an author, title, year, or citekey.')
			.addText((text) => {
				this.queryInput = text;
				text.setPlaceholder('Deleuze Nietzsche 1983');
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

		new Setting(this.contentEl)
			.setName('Page number')
			.setDesc('Optional. Leave blank for a citation without a page.')
			.addText((text) => {
				this.pageInput = text;
				text.setPlaceholder('124');
				text.inputEl.size = 8;
			});

		new Setting(this.contentEl)
			.setName('Search in')
			.setDesc('Use Zotero only when your vault has too many duplicate or incomplete source notes.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('all', 'Zotero and vault notes')
					.addOption('zotero', 'Zotero only')
					.addOption('vault', 'Vault notes only')
					.setValue(this.source)
					.onChange((value) => {
						this.source = value as ScholiaReferenceSearchSource;
					});
			});

		new Setting(this.contentEl)
			.setName('Citation wording')
			.setDesc('Use date only when you have already named the author in your sentence.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('default', 'Author and date')
					.addOption('year-only', 'Date only')
					.setValue(this.textMode)
					.onChange((value) => {
						this.textMode = value as ScholiaCitationTextMode;
					});
			});

		this.statusEl = this.contentEl.createDiv();
		this.resultsEl = this.contentEl.createDiv('pdf-scholia-zotero-results');
	}

	async search() {
		const query = this.queryInput?.getValue().trim() ?? '';
		if (!query) {
			this.setStatus('Type something to search for.');
			return;
		}

		this.setStatus('Searching Zotero and vault notes...');
		this.resultsEl?.empty();

		const records = await this.plugin.lib.zoteroReferences.searchReferences(query, this.source);
		if (!records.length) {
			this.setStatus('No matching Zotero item or vault note found.');
			return;
		}

		this.setStatus(`${records.length} result${records.length === 1 ? '' : 's'} found.`);
		for (const record of records) {
			this.renderResult(record);
		}
	}

	renderResult(record: ScholiaReferenceRecord) {
		const rowEl = this.resultsEl?.createDiv('pdf-scholia-zotero-result');
		if (!rowEl) return;
		rowEl.addClass(`pdf-scholia-zotero-result-${record.source}`);

		const mainEl = rowEl.createDiv();
		mainEl.createEl('strong', { text: record.title || record.citekey || 'Untitled source' });

		rowEl.createDiv({
			cls: 'pdf-scholia-zotero-result-source',
			text: this.getSourceLabel(record),
		});

		const details = [
			record.authors.join(', '),
			record.year,
			record.citekey ? `@${record.citekey}` : '',
			record.source,
		].filter(Boolean).join(' - ');
		if (details) rowEl.createDiv({ text: details });
		if (record.vaultPath) rowEl.createDiv({ text: record.vaultPath });

		new ButtonComponent(rowEl)
			.setButtonText('Insert')
			.setCta()
			.onClick(async () => {
				await this.plugin.lib.zoteroReferences.insertCitation(this.view, record, this.pageInput?.getValue() ?? '', this.textMode);
				this.close();
			});
	}

	getSourceLabel(record: ScholiaReferenceRecord) {
		if (record.source === 'zotero') return 'Zotero';
		if (record.source === 'vault+zotero') return 'Vault note with Zotero match';
		if (record.source === 'vault') {
			const missing = [
				record.authors.length ? '' : 'author',
				record.year ? '' : 'year',
			].filter(Boolean);
			return missing.length ? `Vault note - missing ${missing.join(' and ')}` : 'Vault note';
		}
		return 'Unresolved citation key';
	}

	setStatus(text: string) {
		if (this.statusEl) this.statusEl.setText(text);
	}
}
