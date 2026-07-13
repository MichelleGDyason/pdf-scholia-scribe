import { Constructor, EventRef, Events, FileSystemAdapter, Keymap, Menu, Notice, ObsidianProtocolData, PaneType, Platform, Plugin, SettingTab, TFile, Workspace, WorkspaceLeaf, addIcon, apiVersion, loadPdfJs, normalizePath, requireApiVersion } from 'obsidian';
import type { Editor, MarkdownFileInfo, MarkdownView } from 'obsidian';
import * as pdflib from '@cantoo/pdf-lib';

import { patchPDFView, patchPDFInternals, patchBacklink, patchWorkspace, patchPagePreview, patchPDFInternalFromPDFEmbed, patchMenu } from 'patchers';
import { PDFPlusLib } from 'lib';
import { AutoCopyMode } from 'auto-copy';
import { ColorPalette } from 'color-palette';
import { DomManager } from 'dom-manager';
import { PDFCroppedEmbed } from 'pdf-cropped-embed';
import { DEFAULT_SETTINGS, NamedTemplate, PDFPlusSettings, PDFPlusSettingTab } from 'settings';
import { subpathToParams, focusObsidian, isTargetHTMLElement, KeysOfType } from 'utils';
import { DestArray, PDFEmbed, PDFView, PDFViewerChild, PDFViewerComponent, PDFViewState, Rect } from 'typings';
import { InstallerVersionModal } from 'modals';
import { PDFExternalLinkPostProcessor, PDFInternalLinkPostProcessor, PDFOutlineItemPostProcessor, PDFThumbnailItemPostProcessor } from 'post-process';
import { BibliographyManager } from 'bib';
import { DataviewInlineFieldsModal, withFilesWithInlineFields } from 'lib/dataview';
import { hasPagePreviewModifierSettings } from 'lib/page-preview-contract';


type WorkspaceWithProtocolUnregister = Workspace & {
	unregisterObsidianProtocolHandler?: (action: string) => void;
};

/**
 * Handles one externally supplied `obsidian://` callback without trusting its payload type.
 *
 * Obsidian's published handler type permits any return and does not document a consumed result.
 * This plugin narrows that to `void | Promise<void>` without catching or awaiting it, so thrown
 * errors and rejected Promises retain the existing handling. Review this boundary if Obsidian
 * changes its protocol registration contract.
 */
type PDFPlusObsidianProtocolCallback = (params: unknown) => void | Promise<void>;

/**
 * Authoritative payload contract for the plugin-internal `PDFPlus.events` bus.
 *
 * Obsidian's `Events` class accepts arbitrary names and payloads, so this map keeps emitters and
 * listeners synchronized without changing its synchronous dispatch, ordering, mutation, or error
 * behavior. Listener results are ignored. Add or update an entry here whenever an internal event
 * name or payload changes.
 */
interface PDFPlusEventMap {
	/** Reports the highlighted PDF location and preserves the originating viewer-child identity. */
	highlight: [data: {
		type: 'selection' | 'annotation';
		source: 'obsidian' | 'pdf-plus';
		pageNumber: number;
		child: PDFViewerChild;
	}];
	/** Shares one palette instance so the other palettes can synchronize their current state. */
	'color-palette-state-change': [data: { source: ColorPalette }];
	/** Requests plugin-owned DOM integrations to remount after the DOM manager reloads. */
	'update-dom': [];
	/** Reports the explicit PDF theme-adaptation state selected from the viewer toolbar. */
	'adapt-to-theme-change': [data: { adapt: boolean }];
}

/**
 * Names supported by the plugin-internal event bus.
 *
 * Deriving this alias from `PDFPlusEventMap` prevents event names from drifting away from their
 * argument tuples.
 */
type PDFPlusEventName = keyof PDFPlusEventMap;

/**
 * Listener for one plugin-internal event and its exact argument tuple.
 *
 * Obsidian dispatches these listeners synchronously through `Events`; return values are ignored,
 * Promise results are not awaited, and thrown errors retain the underlying `Events` behavior.
 */
type PDFPlusEventCallback<Name extends PDFPlusEventName> = (...args: PDFPlusEventMap[Name]) => void;

/**
 * Obsidian Workspace events consumed through `registerOneTimeEvent()`.
 *
 * These are external events rather than members of `PDFPlusEventMap`, so they cannot accidentally
 * be emitted through `PDFPlus.trigger()`. Their tuples mirror Obsidian's published Workspace API
 * and must be reviewed if those overloads change.
 */
interface PDFPlusOneTimeWorkspaceEventMap {
	/** Reports the newly active leaf, or `null` when no leaf is active. */
	'active-leaf-change': [leaf: WorkspaceLeaf | null];
	/** Forwards the paste event, target editor, and owning Markdown view or file information. */
	'editor-paste': [event: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo];
}

/**
 * Workspace event names supported by the plugin's one-time registration helper.
 *
 * Derivation from `PDFPlusOneTimeWorkspaceEventMap` keeps each external name tied to its exact
 * Obsidian argument tuple.
 */
type PDFPlusOneTimeWorkspaceEventName = keyof PDFPlusOneTimeWorkspaceEventMap;

/**
 * Callback invoked once after a mapped Obsidian Workspace event reaches the helper.
 *
 * The optional context is supplied as `this`. Results, including Promises, are ignored; removal
 * happens only after a synchronous return, so recursive calls and thrown errors preserve the
 * existing wrapper semantics.
 */
type PDFPlusOneTimeWorkspaceEventCallback<Name extends PDFPlusOneTimeWorkspaceEventName> = (
	this: unknown,
	...args: PDFPlusOneTimeWorkspaceEventMap[Name]
) => void;

type WorkspaceLayoutNode = {
	state?: {
		type?: string;
		state?: Partial<PDFViewState>;
	};
	children?: WorkspaceLayoutNode[];
};

const isSavedPDFViewState = (state: Partial<PDFViewState> | undefined): state is PDFViewState => {
	return typeof state?.file === 'string' && typeof state.page === 'number';
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

/**
 * Validates decoded query data received from an external `obsidian://` URI.
 *
 * Obsidian documents this payload as a string map containing `action`; query values are already
 * decoded, while missing keys stay absent and empty values remain empty strings. Unknown string
 * keys are accepted unchanged. Rejecting non-string entries prevents unsafe forwarding without
 * coercion; this guard must be reviewed if Obsidian changes decoding or repeated-key semantics.
 */
const isObsidianProtocolData = (value: unknown): value is ObsidianProtocolData => {
	return isRecord(value)
		&& typeof value.action === 'string'
		&& Object.values(value).every((entry) => typeof entry === 'string');
};

const hasErrorCode = (err: unknown): err is { code: string } => {
	return isRecord(err) && typeof err.code === 'string';
};

const collectPDFViewStates = (node: WorkspaceLayoutNode | undefined, states: PDFViewState[]) => {
	if (!node) return;

	if (node.state?.type === 'pdf' && isSavedPDFViewState(node.state.state)) {
		states.push({ ...node.state.state });
	}

	node.children?.forEach((child) => collectPDFViewStates(child, states));
};

export default class PDFPlus extends Plugin {
	/** The core internal API. Not intended to be used by other plugins. */
	lib: PDFPlusLib = new PDFPlusLib(this);
	/** User's preferences. */
	settings: PDFPlusSettings;
	/** The plugin setting tab. */
	settingTab: PDFPlusSettingTab;
	events: Events = new Events();
	/** Manages DOMs and event handlers introduced by this plugin. */
	domManager: DomManager;
	/** When loaded, just selecting a range of text in a PDF viewer will run the `copy-link-to-selection` command. */
	autoCopyMode: AutoCopyMode;
	/** A ribbon icon to toggle auto-focus mode */
	autoFocusToggleIconEl: HTMLElement | null = null;
	/** A ribbon icon to toggle auto-paste mode */
	autoPasteToggleIconEl: HTMLElement | null = null;
	/** PDF++ relies on monkey-patching several aspects of Obsidian's internals. This property keeps track of the patching status (succeeded or not). */
	patchStatus = {
		workspace: false,
		pagePreview: false,
		pdfView: false,
		pdfInternals: false,
		pdfOutlineViewer: false,
		backlink: false
	};
	/** 
	 * When no PDF view or PDF embed is opened at the moment the plugin is loaded, the PDF internals will
	 * patched when the user opens a PDF link for the first time.
	 * After patching, the `onPDFInternalsPatchSuccess` function (defined in src/patchers/pdf-internals.ts) will be called,
	 * in which `PDFViewerComponent.loadFile(file, subpath)` will be re-executed in order to refresh the PDF view and reflect the patch.
	 * However, `PDFViewerComponent` does not have the information of the subpath to be opened at the moment, so we need to store it here
	 * so that we can pass it to `loadFile` when the patch is successful.
	 * 
	 * Without this, when the user opens a link to PDF selection or annotation, it will not be highlighted (Obsidian-native highlight, not PDF++ highlight)
	 * properly if it is the first time the user opens a PDF link.
	 */
	subpathWhenPatched?: string;
	/** Same as `subpathWhenPatched`, but scoped to the leaf that triggered delayed PDF internals patching. */
	subpathsWhenPatched: WeakMap<WorkspaceLeaf, string> = new WeakMap();
	/** Per-leaf PDF view states captured before the PDF internals patch reloads existing viewers. */
	pdfViewStatesWhenPatched: WeakMap<WorkspaceLeaf, PDFViewState> = new WeakMap();
	private savedPDFViewStatesByFilePath: Map<string, PDFViewState[]> = new Map();
	classes: {
		PDFView?: Constructor<PDFView>;
		PDFViewerComponent?: Constructor<PDFViewerComponent>;
		PDFViewerChild?: Constructor<PDFViewerChild>;
		PDFEmbed?: Constructor<PDFEmbed>;
	} = {};
	/** 
	 * Tracks the markdown file that a link to a PDF text selection or an annotation was pasted into for the last time. 
	 * Used for auto-pasting.
	 */
	lastPasteFile: TFile | null = null;
	lastActiveMarkdownFile: TFile | null = null;
	/** Tracks the PDFViewerChild instance that an annotation popup was rendered on for the last time. */
	lastAnnotationPopupChild: PDFViewerChild | null = null;
	/** Stores the file and the explicit destination array corresponding to the last link copied with the "Copy link to current page view" command */
	lastCopiedDestInfo: { file: TFile, destArray: DestArray } | { file: TFile, destName: string } | null = null;
	vimrc: string | null = null;
	citationIdRegex: RegExp;
	/** Maps a `div.pdf-container` element to the corresponding `PDFViewerChild` object. */
	// In most use cases of this map, the goal is also achieved by using lib.workspace.iteratePDFViewerChild.
	// However, **before PDF++ 0.40.18**, a PDF embed inside a Canvas text node cannot be handled by the function, so we needed this map.
	// As of 0.40.18, the function can handle it, but I will keep this map as it could be advantageous
	// in terms of performance (it can avoid iteration over all PDFViewerChild objects).
	// Also, there is a saying "if it ain't broke, don't fix it."
	pdfViewerChildren: Map<HTMLElement, PDFViewerChild> = new Map();
	/** Stores all the shown context menu objects. Used to close all visible menus programatically. */
	shownMenus: Set<Menu> = new Set();
	textDivFirstIdx: number;
	/** Whether the current version of Obsidian has the focus bug (see https://forum.obsidian.md/t/pdf-view-loses-focus-after-closing-command-palette-causing-some-commands-to-fail-to-run/97973). */
	obsidianHasFocusBug: boolean;
	/** Whether the current version of Obsidian has the text selection bug (see https://github.com/RyotaUshio/obsidian-pdf-plus/discussions/450). */
	obsidianHasTextSelectionBug: boolean;
	requiresDataviewInlineFieldsMigration = false;
	isDebugMode: boolean = false;
	private obsidianProtocolAction = 'pdf-scholia-scribe';

	async onload() {
		this.checkVersion();

		this.addIcons();

		await loadPdfJs();

		await this.loadSettings();
		await this.saveSettings();
		await this.captureSavedWorkspacePDFViewStates();

		this.domManager = this.addChild(new DomManager(this));
		this.domManager.registerCalloutRenderer();

		this.registerRibbonIcons();

		this.patchObsidian();

		this.registerPDFEmbedCreator();

		this.registerHoverLinkSources();

		this.registerCommands();

		this.registerGlobalVariables();

		this.registerEvents();

		this.startTrackingActiveMarkdownFile();

		this.registerPluginObsidianProtocolHandler();

		this.addSettingTab(this.settingTab = new PDFPlusSettingTab(this));

		this.registerStyleSettings();

		this.checkDeprecatedSettings();
			void this.checkDataviewInlineFields();

		this.registerAutoCheckForUpdates();
	}

	registerPluginObsidianProtocolHandler() {
		const workspace = this.app.workspace as WorkspaceWithProtocolUnregister;
		workspace.unregisterObsidianProtocolHandler?.(this.obsidianProtocolAction);
		const handler: PDFPlusObsidianProtocolCallback = (params) => this.obsidianProtocolHandler(params);
		this.registerObsidianProtocolHandler(this.obsidianProtocolAction, handler);
	}

	onunload() {
		void this.cleanUpResources().catch(console.error);
	}

	/** Perform clean-ups not registered explicitly. */
	async cleanUpResources() {
		await this.cleanUpAnystyleFiles();
	}

	/** Clean up the AnyStyle input files and their directory (.obsidian/plugins/pdf-plus/anystyle) */
	async cleanUpAnystyleFiles() {
		const adapter = this.app.vault.adapter;
		if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
			const anyStyleInputDir = this.getAnyStyleInputDir();
			if (anyStyleInputDir) {
				try {
					await adapter.rmdir(anyStyleInputDir, true);
				} catch (err) {
					if (!hasErrorCode(err) || err.code !== 'ENOENT') throw err;
				}
			}
		}
	}

	checkVersion() {
		// See:
		// https://forum.obsidian.md/t/in-1-8-0-pdf-copy-link-to-selection-fails-to-copy-proper-links-in-some-cases/93545
		// https://github.com/RyotaUshio/obsidian-pdf-plus/issues/327
		this.textDivFirstIdx = apiVersion === '1.8.0' ? 1 : 0;

		// See:
		// https://forum.obsidian.md/t/pdf-view-loses-focus-after-closing-command-palette-causing-some-commands-to-fail-to-run/97973
		this.obsidianHasFocusBug = !requireApiVersion('1.9.0');

		// See:
		// https://forum.obsidian.md/t/1-9-1-pdf-deep-links-to-some-text-selections-cannot-be-copied-text-selection-is-not-smooth/101227
		// https://github.com/RyotaUshio/obsidian-pdf-plus/discussions/450
		this.obsidianHasTextSelectionBug = requireApiVersion('1.9.0');

		InstallerVersionModal.openIfNecessary(this);
	}

	private addIcons() {
		// fill="currentColor" is necessary for the icon to inherit the color of the parent element!
		addIcon('vim', '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="48" fill="currentColor" style="letter-spacing:2; font-weight:bold;">VIM</text>');
	}

	getDefaultSettings() {
		// Use structuredClone to ensure DEFAULT_SETTINGS and its properties are intact
		return structuredClone(DEFAULT_SETTINGS);
	}

	async restoreDefaultSettings() {
		this.settings = this.getDefaultSettings();
		await this.saveSettings();
	}

	async loadSettings() {
		const savedSettings = await this.loadData() as unknown;
		this.settings = Object.assign(this.getDefaultSettings(), isRecord(savedSettings) ? savedSettings : {});

		this.setCitationIdRegex();

		// The AnyStyle path had been saved in data.json until v0.39.3, but now it's saved in the local storage
		if (!this.settings.anystylePath) {
			const anystylePathFromLocalStorage = this.loadLocalStorage('anystylePath');
			if (typeof anystylePathFromLocalStorage === 'string') {
				this.settings.anystylePath = anystylePathFromLocalStorage;
			}
		}

		/** Correct invalid settings */
		if (this.settings.defaultDisplayTextFormatIndex < 0 || this.settings.defaultDisplayTextFormatIndex >= this.settings.displayTextFormats.length) {
			this.settings.defaultDisplayTextFormatIndex = 0;
		}
		if (this.settings.defaultColorPaletteActionIndex < 0 || this.settings.defaultColorPaletteActionIndex >= this.settings.copyCommands.length) {
			this.settings.defaultColorPaletteActionIndex = 0;
		}

		this.validateAutoFocusAndAutoPasteSettings();

		for (const [name, hex] of Object.entries(this.settings.colors)) {
			this.settings.colors[name] = hex.toLowerCase();
		}

		/** migration from legacy settings */

		this.migrateIndependentSplitPDFPaneSettings();

		if (this.settings.paneTypeForFirstMDLeaf as PaneType | '' === 'split') {
			this.settings.paneTypeForFirstMDLeaf = 'right';
		}

		for (const cmd of this.settings.copyCommands) {
			// @ts-ignore
			if (Object.prototype.hasOwnProperty.call(cmd, 'format')) {
				// @ts-ignore
				cmd.template = cmd.format;
				// @ts-ignore
				delete cmd.format;
			}
		}
		this.migrateCitationCopyCommands();
		this.migrateOutlineCopySettings();
		this.migrateScholiaDefaults();

		if (Object.prototype.hasOwnProperty.call(this.settings, 'aliasFormat')) {
			this.settings.displayTextFormats.push({
				name: 'Custom',
				// @ts-ignore
				template: this.settings.aliasFormat
			});
			// @ts-ignore
			delete this.settings.aliasFormat;
		}

		if (Object.prototype.hasOwnProperty.call(this.settings, 'showCopyLinkToSearchInContextMenu')) {
			const searchSectionConfig = this.settings.contextMenuConfig.find(({ id }) => id === 'search');
			if (searchSectionConfig) {
				// @ts-ignore
				searchSectionConfig.visible &&= this.settings.showCopyLinkToSearchInContextMenu;
			}
			// @ts-ignore
			delete this.settings.showCopyLinkToSearchInContextMenu;
		}

		// @ts-ignore
		if (this.settings.showContextMenuOnMouseUpIf === 'mod') {
			this.settings.showContextMenuOnMouseUpIf = 'Mod';
		}

		this.settings.enableEditEncryptedPDF = false;

		this.renameSetting('enalbeWriteHighlightToFile', 'enablePDFEdit');

		this.renameSetting('selectToCopyToggleRibbonIcon', 'autoCopyToggleRibbonIcon');
		this.renameCommand('pdf-plus:toggle-select-to-copy', `${this.manifest.id}:toggle-auto-copy`);

		this.renameSetting('removeWhitespaceBetweenCJKChars', 'removeWhitespaceBetweenCJChars');

		this.loadContextMenuConfig();
	}

	private migrateIndependentSplitPDFPaneSettings() {
		if (!this.settings.migratedIndependentSplitPDFPanesV2) {
			this.settings.singleTabForSinglePDF = false;
			this.settings.viewSyncFollowPageNumber = false;
			this.settings.migratedIndependentSplitPDFPanesV2 = true;
		}
	}

	private renameSetting(oldId: string, newId: keyof PDFPlusSettings) {
		if (Object.prototype.hasOwnProperty.call(this.settings, oldId)) {
			// @ts-ignore
			this.settings[newId] = this.settings[oldId];
			// @ts-ignore
			delete this.settings[oldId];
		}
	}

	private renameCommand(oldId: string, newId: string) {
		const { hotkeyManager } = this.app;
		const oldHotkeys = hotkeyManager.getHotkeys(oldId);
		if (oldHotkeys) {
			hotkeyManager.removeHotkeys(oldId);
			hotkeyManager.setHotkeys(newId, oldHotkeys);
		}
	}

	private migrateCitationCopyCommands() {
		const migrateTemplate = (name: string, oldTemplates: string[], newTemplate: string) => {
			const command = this.settings.copyCommands.find((cmd) => cmd.name === name);
			if (command && oldTemplates.includes(command.template)) {
				command.template = newTemplate;
			}
		};

		const citationQuote = this.settings.copyCommands.find((cmd) => cmd.name === 'Citation quote');
		if (citationQuote?.template === '{{display}}\n> {{text}}\n{{pdfLinkMarker}}\n') {
			citationQuote.template = '{{linkWithDisplay}}\n> {{textMarkdown}}\n';
		}
		migrateTemplate('Citation quote', ['{{linkWithDisplay}}\n> {{text}}\n'], '{{linkWithDisplay}}\n> {{textMarkdown}}\n');

		const inTextCitation = this.settings.copyCommands.find((cmd) => cmd.name === 'In-text citation');
		if (
			inTextCitation?.template === '{{display}} {{pdfLinkMarker}}'
			|| inTextCitation?.template === '{{linkWithDisplay}}'
			|| inTextCitation?.template === '"{{text}}"{{linkWithDisplay}}'
			|| inTextCitation?.template === '"{{text}}" {{linkWithDisplay}}'
		) {
			inTextCitation.template = '"{{textMarkdown}}" {{linkWithDisplay}}';
		}
		migrateTemplate('Quote', ['> ({{linkWithDisplay}})\n> {{text}}\n'], '> ({{linkWithDisplay}})\n> {{textMarkdown}}\n');
		migrateTemplate(
			'Callout',
			[
				'> [!{{calloutType}}|{{color}}] {{linkWithDisplay}}\n> {{text}}\n',
				'> [!{{calloutType}}|{{color}}] {{linkWithDisplay}}\n> {{textMarkdown}}\n',
			],
			'> [!{{calloutType}}|{{color}}] {{colorLabel ? colorLabel + " - " : ""}}{{linkWithDisplay}}\n> {{textMarkdown}}\n'
		);
		migrateTemplate(
			'Quote in callout',
			[
				'> [!{{calloutType}}|{{color}}] {{linkWithDisplay}}\n> > {{text}}\n> \n> ',
				'> [!{{calloutType}}|{{color}}] {{linkWithDisplay}}\n> > {{textMarkdown}}\n> \n> ',
			],
			'> [!{{calloutType}}|{{color}}] {{colorLabel ? colorLabel + " - " : ""}}{{linkWithDisplay}}\n> > {{textMarkdown}}\n> \n> '
		);

		const citationOnly = this.settings.copyCommands.find((cmd) => cmd.name === 'Link');
		if (citationOnly?.template === '{{linkWithDisplay}}') {
			citationOnly.name = 'Citation only';
		}

		const currentDisplayFormat = this.settings.displayTextFormats[this.settings.defaultDisplayTextFormatIndex];
		if (currentDisplayFormat?.template === '{{text}}') {
			const asaIndex = this.settings.displayTextFormats.findIndex((format) => format.template === '{{citation.asa}}');
			if (asaIndex >= 0) this.settings.defaultDisplayTextFormatIndex = asaIndex;
		}
	}

	private migrateOutlineCopySettings() {
		if (this.settings.copyOutlineAsHeadingsFormat === '{{text}}\n\n{{linkWithDisplay}}') {
			this.settings.copyOutlineAsHeadingsFormat = '{{linkWithDisplay}}';
		}
		if (this.settings.copyOutlineAsHeadingsDisplayTextFormat === 'p.{{pageLabel}}') {
			this.settings.copyOutlineAsHeadingsDisplayTextFormat = '{{text}} (p.{{pageLabel}})';
		}
	}

	private migrateScholiaDefaults() {
		const staleDefaultColors = {
			'Yellow': '#ffd000',
			'Red': '#ea5252',
			'Note': '#086ddd',
			'Important': '#bb61e5',
		};
		const scholiaColors = this.getDefaultSettings().colors;
		const colorsMatch = (colors: Record<string, string>) => {
			const entries = Object.entries(colors);
			return entries.length === Object.keys(staleDefaultColors).length
				&& entries.every(([name, color]) => staleDefaultColors[name as keyof typeof staleDefaultColors] === color);
		};

		if (colorsMatch(this.settings.colors)) {
			this.settings.colors = scholiaColors;
			if (this.settings.defaultColor === 'Yellow') {
				this.settings.defaultColor = 'Great Insight!';
			} else if (this.settings.defaultColor === 'Red') {
				this.settings.defaultColor = 'Controversial';
			} else if (this.settings.defaultColor === 'Note') {
				this.settings.defaultColor = 'Conceptual information';
			} else if (this.settings.defaultColor === 'Important') {
				this.settings.defaultColor = 'argument premise';
			}
		}

		if (this.settings.autoCopyToggleRibbonIcon && this.settings.autoFocusToggleRibbonIcon && this.settings.autoPasteToggleRibbonIcon) {
			this.settings.autoCopyToggleRibbonIcon = false;
			this.settings.autoFocusToggleRibbonIcon = false;
			this.settings.autoPasteToggleRibbonIcon = false;
		}
	}

	private loadContextMenuConfig() {
		const defaultConfig = this.getDefaultSettings().contextMenuConfig;
		const config: typeof defaultConfig = [];
		for (const defaultSectionConfig of defaultConfig) {
			const existingSectionConfig = this.settings.contextMenuConfig.find(({ id }) => id === defaultSectionConfig.id);
			config.push(existingSectionConfig ?? defaultSectionConfig);
		}
		this.settings.contextMenuConfig.length = 0;
		this.settings.contextMenuConfig.push(...config);
	}

	validateAutoFocusAndAutoPasteSettings() {
		// We can't have both of them on simultaneously
		if (this.settings.autoFocus && this.settings.autoPaste) {
			this.settings.autoFocus = false;
		}
	}

	checkDeprecatedSettings() {
		if (activeDocument.querySelectorAll('.pdf-plus-deprecated-setting-notice').length > 0) {
			return;
		}

		const showNotice = (settingId: keyof PDFPlusSettings, setMessage: (fragment: DocumentFragment, linkEl: HTMLAnchorElement) => void) => {

			const notice = new Notice('', 0)
				.setMessage(createFragment((el) => {
					const linkEl = createEl('a', {
						href: 'obsidian://pdf-scholia-scribe?setting=' + settingId
					});
					el.append(this.manifest.name + ': ');
					setMessage(el, linkEl);
				}));
			notice.containerEl.addClass('pdf-plus-deprecated-setting-notice');
			notice.messageEl.setCssStyles({
				color: 'var(--text-warning)',
			});
		};

		if (this.settings.trimSelectionEmbed) {
			showNotice('trimSelectionEmbed', (el, linkEl) => {
				el.append('The option ');
				linkEl.textContent = 'Trim selection/annotation embeds';
				el.append(linkEl);
				el.append(' is deprecated and will be removed in the near future. It is recommended to disable it and use the rectangular selection tool instead.');
			});
		}

		const expressionUsesVariable = (expression: string, variable: string) => {
			const regex = new RegExp(`\\b${variable}\\b`);
			return regex.test(expression);
		};

		const templateUsesVariable = (template: string, variable: string) => {
			for (const match of template.matchAll(/{{(.*?)}}/g)) {
				if (expressionUsesVariable(match[1], variable)) {
					return true;
				}
			}
			return false;
		};

		const checkNamedTemplate = (settingId: KeysOfType<PDFPlusSettings, string | NamedTemplate[]>) => {
			const setting = this.settings[settingId];
			let shouldShowNotice = false;

			if (typeof setting === 'string') {
				shouldShowNotice = templateUsesVariable(setting, 'linkedFile') || templateUsesVariable(setting, 'linkedFileProperties');
			} else if (Array.isArray(setting)) {
				shouldShowNotice = setting.some(({ template }) => {
					return templateUsesVariable(template, 'linkedFile') || templateUsesVariable(template, 'linkedFileProperties');
				});
			}

			if (shouldShowNotice) {
				showNotice(settingId, (el, linkEl) => {
					el.append('The template variables ');
					el.createEl('code', {
						text: 'linkedFile'
					});
					el.append(' and ');
					el.createEl('code', {
						text: 'linkedFileProperties'
					});
					el.append(' are deprecated and will be removed in the near future. Please ');
					linkEl.textContent = 'Remove them from your templates';
					el.append(linkEl);
					el.append('.');
				});
			}
		};

		const settingIdsToCheck: KeysOfType<PDFPlusSettings, string | NamedTemplate[]>[] = [
			'displayTextFormats',
			'copyCommands',
			'outlineLinkDisplayTextFormat',
			'outlineLinkCopyFormat',
			'thumbnailLinkDisplayTextFormat',
			'thumbnailLinkCopyFormat',
			'copyOutlineAsHeadingsDisplayTextFormat',
			'copyOutlineAsListDisplayTextFormat',
			'copyOutlineAsListFormat',
			'copyOutlineAsHeadingsFormat',
		];
		settingIdsToCheck.forEach(checkNamedTemplate);
	}

	async checkDataviewInlineFields() {
		withFilesWithInlineFields(this, (files) => {
			if (files.length === 0) {
				this.requiresDataviewInlineFieldsMigration = false;
				return;
			}

			this.requiresDataviewInlineFieldsMigration = true;

			const notice = new Notice(
				createFragment((el) => el.append(
					`${this.manifest.name}: Please consider moving the "${this.settings.proxyMDProperty}" Dataview inline fields to the properties (YAML frontmatter).`,
					createEl('br'),
					'',
					createEl('a', {
						text: 'Open details'
					}, (a) => {
						a.onclick = () => {
							new DataviewInlineFieldsModal(this, files)
								.open();
						};
					}),
					' for more information.',
				)),
				0
			);
			notice.containerEl.addClass('pdf-plus-deprecated-setting-notice');
			notice.messageEl.setCssStyles({
				color: 'var(--text-warning)',
			});
		});
	}

	async saveSettings() {
		const settings: Partial<PDFPlusSettings> = { ...this.settings };

		// AnyStyle path: save to local storage, not to data.json
		this.saveLocalStorage('anystylePath', settings.anystylePath);
		delete settings.anystylePath;

		await this.saveData(settings);
	}

	private async captureSavedWorkspacePDFViewStates() {
		const workspacePath = normalizePath(`${this.app.vault.configDir}/workspace.json`);

		try {
			const workspaceJSON = await this.app.vault.adapter.read(workspacePath);
			const workspace = JSON.parse(workspaceJSON) as {
				main?: WorkspaceLayoutNode;
				left?: WorkspaceLayoutNode;
				right?: WorkspaceLayoutNode;
				floating?: WorkspaceLayoutNode[];
			};

			const states: PDFViewState[] = [];
			collectPDFViewStates(workspace.main, states);
			collectPDFViewStates(workspace.left, states);
			collectPDFViewStates(workspace.right, states);
			workspace.floating?.forEach((node) => collectPDFViewStates(node, states));

			const statesByFilePath = new Map<string, PDFViewState[]>();
			states.forEach((state) => {
				const fileStates = statesByFilePath.get(state.file) ?? [];
				fileStates.push(state);
				statesByFilePath.set(state.file, fileStates);
			});

			this.savedPDFViewStatesByFilePath = statesByFilePath;
		} catch (err) {
			console.warn(`${this.manifest.name}: Failed to read saved PDF workspace state.`, err);
		}
	}

	private seedSavedWorkspacePDFViewStates() {
		if (this.savedPDFViewStatesByFilePath.size === 0) return;

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() !== 'pdf') return;

			const filePath = this.lib.workspace.getFilePathFromView(leaf.view);
			const states = filePath ? this.savedPDFViewStatesByFilePath.get(filePath) : undefined;
			const state = states?.shift();
			if (state) {
				this.pdfViewStatesWhenPatched.set(leaf, { ...state });
			}
		});
	}

	loadLocalStorage(key: string) {
		return this.app.loadLocalStorage(this.manifest.id + '-' + key);
	}

	saveLocalStorage(key: string, value?: unknown) {
		this.app.saveLocalStorage(this.manifest.id + '-' + key, value);
	}

	setCitationIdRegex() {
		const sources = this.settings.citationIdPatterns
			.split(/\r?\n/)
			.filter((line) => line.trim());
		this.citationIdRegex = new RegExp(sources.join('|'));
	}

	/**
	 * Tell the Style Settings plugin to parse styles.css on load and unload
	 * so that the Style Settings pane can be updated.
	 */
	private registerStyleSettings() {
		// See https://github.com/mgmeyers/obsidian-style-settings?tab=readme-ov-file#plugin-support
		this.app.workspace.trigger('parse-style-settings');
		this.register(() => this.app.workspace.trigger('parse-style-settings'));
	}

	private registerRibbonIcons() {
		this.autoCopyMode = new AutoCopyMode(this);
		this.autoCopyMode.toggle(this.settings.autoCopy);
		this.register(() => this.autoCopyMode.unload());

		if (this.settings.autoFocusToggleRibbonIcon) {
			let menuShown = false;

			this.autoFocusToggleIconEl = this.addRibbonIcon(this.settings.autoFocusIconName, `${this.manifest.name}: Toggle auto-focus`, () => {
					if (!menuShown) void this.toggleAutoFocus();
			});
			this.autoFocusToggleIconEl.toggleClass('is-active', this.settings.autoFocus);

			this.registerDomEvent(this.autoFocusToggleIconEl, 'contextmenu', (evt) => {
				if (menuShown) return;

				const menu = new Menu();
				menu.addItem((item) => {
					item.setIcon('lucide-settings')
						.setTitle('Customize...')
						.onClick(() => {
							this.openSettingTab().scrollToHeading('auto-focus');
						});
				});
				menu.onHide(() => { menuShown = false; });
				menu.showAtMouseEvent(evt);
				menuShown = true;
			});
		}

		if (this.settings.autoPasteToggleRibbonIcon) {
			let menuShown = false;

			this.autoPasteToggleIconEl = this.addRibbonIcon(this.settings.autoPasteIconName, `${this.manifest.name}: Toggle auto-paste`, () => {
					if (!menuShown) void this.toggleAutoPaste();
			});
			this.autoPasteToggleIconEl.toggleClass('is-active', this.settings.autoPaste);
			this.registerDomEvent(this.autoPasteToggleIconEl, 'contextmenu', (evt) => {
				if (menuShown) return;

				const menu = new Menu();
				menu.addItem((item) => {
					item.setIcon('lucide-settings')
						.setTitle('Customize...')
						.onClick(() => {
							this.openSettingTab().scrollToHeading('auto-paste');
						});
				});
				menu.onHide(() => { menuShown = false; });
				menu.showAtMouseEvent(evt);
				menuShown = true;
			});
		}
	}

	toggleAutoFocusRibbonIcon(enable?: boolean) {
		const iconEl = this.autoFocusToggleIconEl;
		if (iconEl) {
			enable = enable ?? !iconEl.hasClass('is-active');
			iconEl.toggleClass('is-active', enable);
		}
	}

	toggleAutoPasteRibbonIcon(enable?: boolean) {
		const iconEl = this.autoPasteToggleIconEl;
		if (iconEl) {
			enable = enable ?? !iconEl.hasClass('is-active');
			iconEl.toggleClass('is-active', enable);
		}
	}

	async toggleAutoFocus(enable?: boolean, save?: boolean) {
		enable = enable ?? !this.settings.autoFocus;
		this.toggleAutoFocusRibbonIcon(enable);
		this.settings.autoFocus = enable;

		if (this.settings.autoFocus && this.settings.autoPaste) {
			await this.toggleAutoPaste(false, false);
		}

		if (save ?? true) {
			await this.saveSettings();
		}
	}

	async toggleAutoPaste(enable?: boolean, save?: boolean) {
		enable = enable ?? !this.settings.autoPaste;
		this.toggleAutoPasteRibbonIcon(enable);
		this.settings.autoPaste = enable;

		if (this.settings.autoPaste && this.settings.autoFocus) {
			await this.toggleAutoFocus(false, false);
		}

		if (save ?? true) {
			await this.saveSettings();
		}
	}

	private patchObsidian() {
		this.app.workspace.onLayoutReady(() => {
			this.seedSavedWorkspacePDFViewStates();
		});
		this.app.workspace.onLayoutReady(() => {
			patchWorkspace(this);
			patchPagePreview(this);
			patchMenu(this);
		});
		this.tryPatchUntilSuccess(patchPDFView);
		this.tryPatchUntilSuccess(patchPDFInternalFromPDFEmbed);
		this.tryPatchUntilSuccess(patchBacklink);
	}

	tryPatchUntilSuccess(patcher: (plugin: PDFPlus) => boolean, noticeOnFail?: () => Notice | undefined) {
		this.app.workspace.onLayoutReady(() => {
			const success = patcher(this);
			if (!success) {
				const notice = noticeOnFail?.();

				const eventRef = this.app.workspace.on('layout-change', () => {
					const success = patcher(this);
					if (success) {
						this.app.workspace.offref(eventRef);
						notice?.hide();
					}
				});
				this.registerEvent(eventRef);
			}
		});
	}

	/** 
	 * Registers an HTML element that will be refreshed when a style setting is updated
	 * and will be removed when the plugin gets unloaded. 
	 */
	registerEl<HTMLElementType extends HTMLElement>(el: HTMLElementType) {
		this.register(() => el.remove());
		return el;
	}

	loadStyle() {
		this.domManager.update();
	}

	private registerPDFEmbedCreator() {
		const originalPDFEmbedCreator = this.app.embedRegistry.embedByExtension['pdf'];

		this.register(() => {
			this.app.embedRegistry.unregisterExtension('pdf');
			this.app.embedRegistry.registerExtension('pdf', originalPDFEmbedCreator);
		});

		this.app.embedRegistry.unregisterExtension('pdf');
		this.app.embedRegistry.registerExtension('pdf', (ctx, file, subpath) => {
			const params = subpathToParams(subpath);

			let embed: PDFEmbed | PDFCroppedEmbed | null = null;

			if (params.has('rect') && params.has('page')) {
				const pageNumber = parseInt(params.get('page')!);
				const rect = params.get('rect')!.split(',').map((n) => parseFloat(n));
				const width = params.has('width') ? parseFloat(params.get('width')!) : undefined;
				const annotationId = params.get('annotation') ?? undefined;
				if (Number.isInteger(pageNumber) && rect.length === 4) {
					embed = new PDFCroppedEmbed(this, ctx, file, subpath, pageNumber, rect as Rect, width, annotationId);
				}
			}

			if (!embed) {
				embed = originalPDFEmbedCreator(ctx, file, subpath) as PDFEmbed;
				// @ts-ignore
				if (!this.classes.PDFEmbed) this.classes.PDFEmbed = embed.constructor;
				if (!this.patchStatus.pdfInternals) {
						void patchPDFInternals(this, embed.viewer).catch(console.error);
				}
			}

			// Double-lick PDF embeds to open links
			this.registerDomEvent(embed.containerEl, 'dblclick', (evt) => {
				if (this.settings.dblclickEmbedToOpenLink
					&& isTargetHTMLElement(evt, evt.target)
					// .pdf-container is necessary to avoid opening links when double-clicking on the toolbar
					&& (evt.target.closest('.pdf-embed[src] > .pdf-container') || evt.target.closest('.pdf-cropped-embed'))) {
					const linktext = file.path + subpath;
					// we don't need sourcePath because linktext is the full path
						void this.app.workspace.openLinkText(linktext, '', Keymap.isModEvent(evt));
					evt.preventDefault();
				}
			});

			// Make PDF embeds with a subpath unscrollable
			if (this.settings.embedUnscrollable) {
				for (const eventType of [
					'wheel', // mousewheel
					'touchmove' // finger swipe
				] as const) {
					this.registerDomEvent(embed.containerEl, eventType, (evt) => {
						if (isTargetHTMLElement(evt, evt.target)
							&& evt.target.closest('.pdf-embed[src*="#"] .pdf-viewer-container')) {
							evt.preventDefault();
						}
					}, { passive: false });
				}
			}

			if (embed instanceof PDFCroppedEmbed) {
				this.registerDomEvent(embed.containerEl, 'click', (evt) => {
					if (isTargetHTMLElement(evt, evt.target) && evt.target.closest('.cm-editor')) {
						// Prevent the click event causing the editor to select the link like an image embed
						evt.preventDefault();
					}
				});
			}

			if (params.has('color')) {
				embed.containerEl.dataset.highlightColor = params.get('color')!.toLowerCase();
			} else if (this.settings.defaultColor) {
				embed.containerEl.dataset.highlightColor = this.settings.defaultColor.toLowerCase();
			}
			return embed;
		});
	}

	private registerGlobalVariable(name: string, value: any, throwError: boolean = true) {
		if (name in window) {
			if (throwError) throw new Error(`${this.manifest.name}: Global variable "${name}" already exists.`);
			else return;
		}
		// @ts-ignore
		window[name] = value;
		// @ts-ignore
		this.register(() => delete window[name]);
	}

	private registerGlobalVariables() {
		this.registerGlobalVariable('pdfPlus', this, false);
		this.registerGlobalVariable('pdflib', pdflib, false);
	}

	private registerEvents() {
		// keep this.pdfViewerChildren up-to-date
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			for (const pdfContainerEl of this.pdfViewerChildren.keys()) {
				if (!pdfContainerEl?.isShown()) this.pdfViewerChildren.delete(pdfContainerEl);
			}
		}));

		// Sync the external app with Obsidian
		if (Platform.isDesktopApp) {
			this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
				if (this.settings.syncWithDefaultApp && leaf && this.lib.isPDFView(leaf.view)) {
					const file = leaf.view.file;
					if (file) {
							void this.app.openWithDefaultApp(file.path);
						if (this.settings.focusObsidianAfterOpenPDFWithDefaultApp) {
							focusObsidian();
						}
					}
				}
			}));
		}

		// Keep the last-pasted file up-to-date
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && file === this.lastPasteFile) {
				this.lastPasteFile = null;
			}
		}));
		// See also: lib.copyLink.watchPaste()

		// Keep the template path for the command "Create new note for auto-focus or auto-paste" up-to-date
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && this.settings.newFileTemplatePath === oldPath) {
				this.settings.newFileTemplatePath = file.path;
				void this.saveSettings();
			}
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && this.settings.newFileTemplatePath === file.path) {
				this.settings.newFileTemplatePath = '';
				void this.saveSettings();
			}
		}));

		// Keep the vimrc content up-to-date
		this.registerEvent(this.app.vault.on('modify', async (file) => {
			if (file instanceof TFile && file.path === this.settings.vimrcPath) {
				this.vimrc = await this.app.vault.read(file);
			}
		}));

		// Clean up other resources when the app quits
		this.registerEvent(this.app.workspace.on('quit', async () => {
			await this.cleanUpResources();
		}));

		// Do not patch Markdown editor drag/drop in PDF Scholia Scribe's default build.
		// The citation workflow uses color-click copy/paste; editor drag/drop hooks can
		// make unstable editor selection behavior harder to diagnose.
	}

	/**
	 * Register one plugin-owned listener for a mapped Obsidian Workspace event.
	 *
	 * The wrapper deliberately unregisters after callback return. A recursive trigger can therefore
	 * re-enter it, while a thrown callback leaves it registered; changing that order would alter the
	 * existing behavior. The EventRef is also registered for normal plugin-unload cleanup.
	 */
	registerOneTimeEvent<Name extends PDFPlusOneTimeWorkspaceEventName>(
		events: Events,
		evt: Name,
		callback: PDFPlusOneTimeWorkspaceEventCallback<Name>,
		ctx?: unknown
	): void {
		const eventRef = events.on(evt, (...args: PDFPlusOneTimeWorkspaceEventMap[Name]) => {
			callback.call(ctx, ...args);
			events.offref(eventRef);
		}, ctx);
		this.registerEvent(eventRef);
	}

	async checkForUpdatesIfNeeded() {
		if (!this.settings.autoCheckForUpdates) return;

		const result = await this.lib.checkForUpdates({
			minHoursSinceRelease: 24,
		});
		if (result.shouldUpdate) {
			this.app.workspace.onLayoutReady(() => {
				new Notice(createFragment((el) => {
					el.append(
						`${this.manifest.name}: There is a newer version available! `,
						createEl('a', {
							text: 'Update now',
							href: 'obsidian://show-plugin?id=pdf-scholia-scribe',
						})
					);
				}));
			});
		}
	}

	private registerAutoCheckForUpdates() {
		void this.checkForUpdatesIfNeeded();
		this.registerInterval(window.setInterval(() => {
			void this.checkForUpdatesIfNeeded();
		}, 1000 * 60 * 60 * 24));
	}

	private registerHoverLinkSources() {
		this.registerHoverLinkSource('pdf-plus', {
			defaultMod: true,
			display: `${this.manifest.name}: backlink highlights`
		});

		this.registerHoverLinkSource(PDFInternalLinkPostProcessor.HOVER_LINK_SOURCE_ID, {
			defaultMod: true,
			display: `${this.manifest.name}: internal links in PDF (except for citations)`
		});

		this.registerHoverLinkSource(BibliographyManager.HOVER_LINK_SOURCE_ID, {
			defaultMod: false,
			display: `${this.manifest.name}: citation links in PDF`
		});

		this.registerHoverLinkSource(PDFExternalLinkPostProcessor.HOVER_LINK_SOURCE_ID, {
			defaultMod: true,
			display: `${this.manifest.name}: external links in PDF`
		});

		this.registerHoverLinkSource(PDFOutlineItemPostProcessor.HOVER_LINK_SOURCE_ID, {
			defaultMod: true,
			display: `${this.manifest.name}: outlines (bookmarks)`
		});

		this.registerHoverLinkSource(PDFThumbnailItemPostProcessor.HOVER_LINK_SOURCE_ID, {
			defaultMod: true,
			display: `${this.manifest.name}: thumbnails`
		});
	}

	private registerCommands() {
		this.lib.commands.registerCommands();
	}

	private startTrackingActiveMarkdownFile() {
		const { workspace, vault } = this.app;

		workspace.onLayoutReady(() => {
			// initialize lastActiveMarkdownFile
			const activeFile = workspace.getActiveFile();
			if (activeFile && activeFile.extension === 'md') {
				this.lastActiveMarkdownFile = activeFile;
			} else {
				const lastActiveMarkdownPath = workspace.recentFileTracker.getRecentFiles({
					showMarkdown: true, showCanvas: false, showNonImageAttachments: false, showImages: false, maxCount: 1
				}).first();
				if (lastActiveMarkdownPath) {
					const lastActiveMarkdownFile = vault.getAbstractFileByPath(lastActiveMarkdownPath);
					if (lastActiveMarkdownFile instanceof TFile && lastActiveMarkdownFile.extension === 'md') {
						this.lastActiveMarkdownFile = lastActiveMarkdownFile;
					}
				}
			}

			// track active markdown file
			this.registerEvent(workspace.on('file-open', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.lastActiveMarkdownFile = file;
				}
			}));
			this.registerEvent(vault.on('delete', (file) => {
				if (file instanceof TFile && file === this.lastActiveMarkdownFile) {
					this.lastActiveMarkdownFile = null;
				}
			}));
		});
	}

	obsidianProtocolHandler(params: unknown): void | Promise<void> {
		if (!isObsidianProtocolData(params)) return;

		if ('create-dummy' in params) {
			return this.lib.dummyFileManager.createDummyFilesFromObsidianUrl(params);
		}

		if ('setting' in params) {
			return this.settingTab.openFromObsidianUrl(params);
		}
	}

	/** Register a listener for one mapped plugin-internal event. */
	on<Name extends PDFPlusEventName>(evt: Name, callback: PDFPlusEventCallback<Name>, context?: unknown): EventRef {
		return this.events.on(evt, callback, context);
	}

	/** Remove the matching callback using Obsidian's existing listener-removal semantics. */
	off<Name extends PDFPlusEventName>(evt: Name, callback: PDFPlusEventCallback<Name>): void {
		this.events.off(evt, callback);
	}

	offref(ref: EventRef) {
		this.events.offref(ref);
	}

	/** Synchronously emit one mapped event without transforming its argument tuple. */
	trigger<Name extends PDFPlusEventName>(evt: Name, ...args: PDFPlusEventMap[Name]): void {
		this.events.trigger(evt, ...args);
	}

	/**
	 * Resolve whether Page Preview requires the modifier key for one registered hover source.
	 *
	 * Obsidian keeps per-source overrides on a private core-plugin instance, so callers should use
	 * this method instead of inspecting `internalPlugins`. A non-null override is returned unchanged
	 * to preserve existing truthiness; otherwise the public hover-source `defaultMod` value, then
	 * `false`, is used. Missing or malformed private state follows that same fallback. The return type
	 * remains `unknown` because unexpected persisted override values were historically passed through.
	 */
	requireModKeyForLinkHover(id = 'pdf-plus'): unknown {
		const pagePreviewPlugin: unknown = this.app.internalPlugins.plugins['page-preview'];
		const pagePreviewInstance = isRecord(pagePreviewPlugin) ? pagePreviewPlugin.instance : undefined;
		const override = hasPagePreviewModifierSettings(pagePreviewInstance)
			? pagePreviewInstance.overrides[id]
			: undefined;

		return override
			?? this.app.workspace.hoverLinkSources[id]?.defaultMod
			?? false;
	}

	openSettingTab(): PDFPlusSettingTab {
		this.app.setting.open();
		// This `if` check is necessary. If we omit it, the following bug occurs:
		// https://github.com/RyotaUshio/obsidian-pdf-plus/issues/309
		// I learned this from the core Sync plugin's `openSettings` method.
		if (this.app.setting.activeTab !== this.settingTab) {
			this.app.setting.openTabById(this.manifest.id);
		}
		return this.settingTab;
	}

	openHotkeySettingTab(query?: string): SettingTab {
		this.app.setting.open();
		const tab = this.app.setting.openTabById('hotkeys');
		tab.setQuery(query ?? this.manifest.id);
		return tab;
	}

	getAnyStyleInputDir() {
		const pdfPlusDirPath = this.manifest.dir;
		if (pdfPlusDirPath) {
			return pdfPlusDirPath + '/anystyle';
		}
		return null;
	}
}
