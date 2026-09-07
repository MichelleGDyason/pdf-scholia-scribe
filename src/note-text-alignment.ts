import { MarkdownView, Menu, Modal, Notice, Setting, TFile } from 'obsidian';

import type PDFPlus from 'main';
import {
	getNoteTextAlignment,
	NOTE_TEXT_ALIGNMENTS,
	NoteTextAlignment,
	setNoteTextAlignmentClass,
} from 'note-text-alignment-core';

const ALIGNMENT_LABELS: Record<NoteTextAlignment, string> = {
	left: 'Left',
	center: 'Centre',
	right: 'Right',
	justify: 'Justified',
};

const ALIGNMENT_DESCRIPTIONS: Record<NoteTextAlignment, string> = {
	left: 'Align each line with the left margin.',
	center: 'Centre each line between the margins.',
	right: 'Align each line with the right margin.',
	justify: 'Space words so prose meets both margins.',
};

type MutableFrontmatter = Record<string, unknown>;

function isMarkdownFile(file: TFile | null): file is TFile {
	return file?.extension.toLowerCase() === 'md';
}

export class NoteTextAlignmentModal extends Modal {
	constructor(private plugin: PDFPlus, private file: TFile) {
		super(plugin.app);
	}

	onOpen() {
		this.contentEl.addClass('scholia-note-alignment-modal');
		this.setTitle('Note text alignment');
		this.contentEl.createEl('p', {
			text: `Choose the alignment for ${this.file.basename}. This applies to the whole note in editing and reading views.`,
			cls: 'setting-item-description',
		});

		let current: NoteTextAlignment;
		try {
			current = getNoteTextAlignment(this.plugin.app.metadataCache.getFileCache(this.file)?.frontmatter?.cssclasses);
		} catch (error) {
			this.close();
			this.showError(error);
			return;
		}

		for (const alignment of NOTE_TEXT_ALIGNMENTS) {
			const isCurrent = alignment === current;
			new Setting(this.contentEl)
				.setName(`${ALIGNMENT_LABELS[alignment]}${isCurrent ? ' (current)' : ''}`)
				.setDesc(ALIGNMENT_DESCRIPTIONS[alignment])
				.addButton((button) => {
					button
						.setButtonText('Apply')
						.onClick(() => {
							void this.applyAlignment(alignment);
						});
					if (isCurrent) button.setCta();
				});
		}
	}

	private async applyAlignment(alignment: NoteTextAlignment) {
		try {
			await this.plugin.app.fileManager.processFrontMatter(this.file, (frontmatter: MutableFrontmatter) => {
				frontmatter.cssclasses = setNoteTextAlignmentClass(frontmatter.cssclasses, alignment);
			});
			this.close();
			new Notice(`${this.plugin.manifest.name}: ${this.file.basename} is now ${ALIGNMENT_LABELS[alignment].toLowerCase()} aligned.`);
		} catch (error) {
			this.showError(error);
		}
	}

	private showError(error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`${this.plugin.manifest.name}: Could not change note alignment. ${message}`);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export function registerNoteTextAlignment(plugin: PDFPlus) {
	const openAlignmentPicker = (file: TFile | null) => {
		if (isMarkdownFile(file)) new NoteTextAlignmentModal(plugin, file).open();
	};
	const addAlignmentMenuItem = (menu: Menu, file: TFile) => {
		menu.addItem((item) => {
			item
				.setTitle('Set note text alignment...')
				.setIcon('align-justify')
				.onClick(() => openAlignmentPicker(file));
		});
	};
	const getReadingViewFile = (target: EventTarget | null) => {
		const targetEl = target as HTMLElement | null;
		if (!targetEl || typeof targetEl.closest !== 'function') return null;
		const readingViewEl = targetEl.closest<HTMLElement>('.markdown-reading-view');
		if (!readingViewEl) return null;

		let file: TFile | null = null;
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (file) return;
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(readingViewEl)) {
				file = view.file;
			}
		});
		return isMarkdownFile(file) ? file : null;
	};

	plugin.addCommand({
		id: 'set-note-text-alignment',
		name: 'Set text alignment for current note',
		icon: 'align-justify',
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!isMarkdownFile(file)) return false;
			if (!checking) openAlignmentPicker(file);
			return true;
		},
	});

	plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, _editor, info) => {
		const file = info.file;
		if (!isMarkdownFile(file)) return;
		addAlignmentMenuItem(menu, file);
	}));

	plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
		if (!(file instanceof TFile) || !isMarkdownFile(file)) return;
		addAlignmentMenuItem(menu, file);
	}));

	// Reading view has no public Obsidian context-menu event equivalent to `editor-menu`.
	// Handle only that surface; editing view and the file explorer continue to use the
	// public workspace events above. The leaf lookup keeps popout-window notes accurate.
	plugin.lib.registerGlobalDomEvent(plugin, 'contextmenu', (event) => {
		const file = getReadingViewFile(event.target);
		if (!file) return;

		event.preventDefault();
		event.stopPropagation();
		const menu = new Menu();
		addAlignmentMenuItem(menu, file);
		menu.showAtMouseEvent(event);
	}, { capture: true });
}
