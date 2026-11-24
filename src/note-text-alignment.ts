import { MarkdownView, Menu, Modal, Notice, Setting, TFile } from 'obsidian';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

import type PDFPlus from 'main';
import {
	getHeadingIndentDepthAtLine,
	getMarkdownHeadingIndentDepths,
	getNoteTextAlignment,
	isNoteHeadingIndentEnabled,
	markdownHasNoteHeadingIndentClass,
	NOTE_TEXT_ALIGNMENTS,
	NoteTextAlignment,
	setNoteHeadingIndentClass,
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

const HEADING_INDENT_CLASSES = Array.from({ length: 6 }, (_value, index) => `scholia-heading-indent-${index + 1}`);
const READING_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const READING_BLOCK_SELECTOR = 'p, ul, ol, blockquote, pre, table, .math-block';
const READING_NODE_SELECTOR = `${READING_HEADING_SELECTOR}, ${READING_BLOCK_SELECTOR}`;

function isMarkdownFile(file: TFile | null): file is TFile {
	return file?.extension.toLowerCase() === 'md';
}

function getFileCssClasses(plugin: PDFPlus, file: TFile): unknown {
	const frontmatter: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
	if (!frontmatter || typeof frontmatter !== 'object') return undefined;
	return (frontmatter as Record<string, unknown>).cssclasses;
}

function getHeadingLevel(element: HTMLElement): number | null {
	const match = /^H([1-6])$/.exec(element.tagName);
	return match ? Number(match[1]) : null;
}

function setHeadingIndentClass(element: HTMLElement, depth: number) {
	element.removeClasses(HEADING_INDENT_CLASSES);
	if (depth >= 1 && depth <= 6) element.addClass(HEADING_INDENT_CLASSES[depth - 1]);
}

function decorateReadingSection(element: HTMLElement, initialDepth: number) {
	const nodes = [
		...(element.matches(READING_NODE_SELECTOR) ? [element] : []),
		...Array.from(element.querySelectorAll<HTMLElement>(READING_NODE_SELECTOR)),
	];
	let depth = initialDepth;

	for (const node of nodes) {
		const parentBlock = node.parentElement?.closest<HTMLElement>(READING_BLOCK_SELECTOR);
		if (parentBlock && (parentBlock === element || element.contains(parentBlock))) continue;

		const headingLevel = getHeadingLevel(node);
		if (headingLevel !== null) {
			depth = headingLevel;
			setHeadingIndentClass(node, 0);
		} else {
			setHeadingIndentClass(node, depth);
		}
	}
}

function buildHeadingIndentDecorations(view: EditorView): DecorationSet {
	const markdown = view.state.doc.toString();
	if (!markdownHasNoteHeadingIndentClass(markdown)) return Decoration.none;
	const depths = getMarkdownHeadingIndentDepths(markdown);
	const decorations = [];
	for (let index = 0; index < depths.length; index++) {
		const depth = depths[index];
		if (!depth) continue;
		const line = view.state.doc.line(index + 1);
		decorations.push(Decoration.line({ class: HEADING_INDENT_CLASSES[depth - 1] }).range(line.from));
	}
	return Decoration.set(decorations);
}

const headingIndentEditorExtension = ViewPlugin.fromClass(class {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildHeadingIndentDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged) this.decorations = buildHeadingIndentDecorations(update.view);
	}
}, {
	decorations: (value) => value.decorations,
});

export class NoteTextAlignmentModal extends Modal {
	constructor(private plugin: PDFPlus, private file: TFile) {
		super(plugin.app);
	}

	onOpen() {
		this.contentEl.addClass('scholia-note-alignment-modal');
		this.setTitle('Note text layout');
		this.contentEl.createEl('p', {
			text: `Choose the alignment and heading indentation for ${this.file.basename}. These apply in editing and reading views.`,
			cls: 'setting-item-description',
		});

		let current: NoteTextAlignment;
		let headingIndentEnabled: boolean;
		try {
			const cssclasses = getFileCssClasses(this.plugin, this.file);
			current = getNoteTextAlignment(cssclasses);
			headingIndentEnabled = isNoteHeadingIndentEnabled(cssclasses);
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

		new Setting(this.contentEl)
			.setName('Indent text under headings')
			.setDesc('Keep headings at the margin, then indent their text by heading level: heading 1 once, heading 2 twice, through heading 6.')
			.addToggle((toggle) => {
				toggle
					.setValue(headingIndentEnabled)
					.onChange(async (enabled) => {
						try {
							await this.setHeadingIndentation(enabled);
						} catch (error) {
							toggle.setValue(!enabled);
							this.showError(error);
						}
					});
			});
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

	private async setHeadingIndentation(enabled: boolean) {
		await this.plugin.app.fileManager.processFrontMatter(this.file, (frontmatter: MutableFrontmatter) => {
			frontmatter.cssclasses = setNoteHeadingIndentClass(frontmatter.cssclasses, enabled);
		});
		new Notice(`${this.plugin.manifest.name}: Heading-based text indentation is now ${enabled ? 'on' : 'off'} for ${this.file.basename}.`);
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
				.setTitle('Set note text layout...')
				.setIcon('align-justify')
				.onClick(() => openAlignmentPicker(file));
		});
		menu.addItem((item) => {
			let enabled = false;
			try {
				enabled = isNoteHeadingIndentEnabled(getFileCssClasses(plugin, file));
			} catch {
				// Keep the item available so selecting it can show the actionable frontmatter error.
			}
			item
				.setTitle('Indent text under headings')
				.setIcon('list-tree')
				.setChecked(enabled)
				.onClick(() => {
					void setHeadingIndentation(file, !enabled);
				});
		});
	};
	const setHeadingIndentation = async (file: TFile, enabled: boolean) => {
		try {
			await plugin.app.fileManager.processFrontMatter(file, (frontmatter: MutableFrontmatter) => {
				frontmatter.cssclasses = setNoteHeadingIndentClass(frontmatter.cssclasses, enabled);
			});
			new Notice(`${plugin.manifest.name}: Heading-based text indentation is now ${enabled ? 'on' : 'off'} for ${file.basename}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`${plugin.manifest.name}: Could not change heading indentation. ${message}`);
		}
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

	plugin.addCommand({
		id: 'toggle-heading-based-text-indentation',
		name: 'Toggle text indentation under headings for current note',
		icon: 'list-tree',
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!isMarkdownFile(file)) return false;
			if (!checking) {
				try {
					const enabled = isNoteHeadingIndentEnabled(getFileCssClasses(plugin, file));
					void setHeadingIndentation(file, !enabled);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					new Notice(`${plugin.manifest.name}: Could not change heading indentation. ${message}`);
				}
			}
			return true;
		},
	});

	plugin.registerEditorExtension(headingIndentEditorExtension);
	plugin.registerMarkdownPostProcessor((element, context) => {
		const section = context.getSectionInfo(element);
		if (!section) return;
		const headings = plugin.app.metadataCache.getCache(context.sourcePath)?.headings;
		decorateReadingSection(element, getHeadingIndentDepthAtLine(headings, section.lineStart));
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
