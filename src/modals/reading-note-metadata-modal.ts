import { FuzzySuggestModal, Setting, TFile } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusModal } from './base-modal';
import {
	formatReadingNoteMetadataValue,
	ReadingNoteMetadataProposal,
	ReadingNoteMetadataSource,
} from 'lib/reading-note-metadata-core';

const SOURCE_LABELS: Record<ReadingNoteMetadataSource, string> = {
	'pdf-link': 'PDF link',
	zotero: 'Zotero',
	xmp: 'embedded PDF metadata',
	'pdf-info': 'PDF document information',
	'pdf-custom': 'custom PDF metadata',
	'first-page': 'first-page text',
	'front-matter': 'PDF front matter',
	filename: 'PDF file name',
};

type ApplyReadingNoteMetadata = (proposals: ReadingNoteMetadataProposal[]) => Promise<void> | void;

export class ReadingNoteMetadataPreviewModal extends PDFPlusModal {
	private selectedProperties = new Set<string>();

	constructor(
		plugin: PDFPlus,
		private note: TFile,
		private pdf: TFile,
		private proposals: ReadingNoteMetadataProposal[],
		private applyProposals: ApplyReadingNoteMetadata,
	) {
		super(plugin);
	}

	onOpen(): void {
		super.onOpen();
		this.titleEl.setText('Fill empty reading-note properties');
		this.contentEl.createEl('p', {
			text: `Note: ${this.note.path}`,
		});
		this.contentEl.createEl('p', {
			text: `PDF: ${this.pdf.path}`,
		});
		this.contentEl.createEl('p', {
			text: 'Only properties that already exist and are still empty will be filled. Existing values are never replaced.',
		});

		for (const proposal of this.proposals) {
			const selectedByDefault = proposal.confidence !== 'review';
			if (selectedByDefault) this.selectedProperties.add(proposal.property);

			new Setting(this.contentEl)
				.setName(proposal.property)
				.setDesc(`${formatReadingNoteMetadataValue(proposal.value)} — ${SOURCE_LABELS[proposal.source]}${proposal.confidence === 'review' ? ' (please check)' : ''}`)
				.addToggle((toggle) => toggle
					.setValue(selectedByDefault)
					.onChange((value) => {
						if (value) this.selectedProperties.add(proposal.property);
						else this.selectedProperties.delete(proposal.property);
					}));
		}

		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton((button) => button
				.setCta()
				.setButtonText('Fill selected properties')
				.onClick(async () => {
					button.setDisabled(true);
					const selected = this.proposals.filter((proposal) => this.selectedProperties.has(proposal.property));
					try {
						await this.applyProposals(selected);
						this.close();
					} catch (error) {
						console.error(`${this.plugin.manifest.name}: Failed to apply reading-note metadata.`, error);
						button.setDisabled(false);
					}
				}));
	}
}

type ChoosePdfCallback = (file: TFile | null) => void;

export class ReadingNotePdfSuggestModal extends FuzzySuggestModal<TFile> {
	private chosen = false;

	constructor(
		plugin: PDFPlus,
		private files: TFile[],
		private choose: ChoosePdfCallback,
		placeholder = 'Choose the PDF whose metadata should fill this note',
	) {
		super(plugin.app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.chosen = true;
		this.choose(file);
	}

	onClose(): void {
		super.onClose();
		if (!this.chosen) this.choose(null);
	}
}
