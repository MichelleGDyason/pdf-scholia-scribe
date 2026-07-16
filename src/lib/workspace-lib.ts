import { HoverParent, MarkdownView, OpenViewState, PaneType, Platform, Pos, TFile, View, WorkspaceItem, WorkspaceLeaf, WorkspaceSidedock, WorkspaceSplit, WorkspaceTabs, parseLinktext, requireApiVersion } from 'obsidian';

import { PDFPlusLibSubmodule } from './submodule';
import { BacklinkView, CanvasView, ExcalidrawView, PDFEmbed, PDFView, PDFViewerChild, PDFViewerComponent } from 'typings';


// Split right, left, down, or up
export type FineGrainedSplitDirection = 'right' | 'left' | 'down' | 'up';
export type SidebarType = 'right-sidebar' | 'left-sidebar';
export type ExtendedPaneType =
    Exclude<PaneType, 'split'> | '' // An empty string means the same as false (= current tab)
    | FineGrainedSplitDirection
    | SidebarType;


export function isPaneType(arg: string): arg is PaneType {
    return ['tab', 'split', 'window'].contains(arg);
}

export function isFineGrainedSplitDirection(arg: string): arg is FineGrainedSplitDirection {
    return ['right', 'left', 'down', 'up'].contains(arg);
}

export function isSidebarType(arg: string): arg is SidebarType {
    return ['right-sidebar', 'left-sidebar'].contains(arg);
}

export function isExtendedPaneType(arg: string): arg is ExtendedPaneType {
    return ['', 'tab', 'window'].contains(arg) || isFineGrainedSplitDirection(arg) || isSidebarType(arg);
}

/**
 * The settings fragment read from the optional Hover Editor community plugin.
 *
 * Obsidian's public types cannot describe third-party plugin settings, so the delay remains unknown
 * until used. Review this contract if Hover Editor moves or renames its `triggerDelay` setting.
 */
interface HoverEditorSettings {
    readonly triggerDelay?: unknown;
}

/**
 * The minimal loaded Hover Editor instance discovered through Obsidian's private plugin registry.
 *
 * Only fields consumed by this integration are modeled. Popover entries remain unknown until
 * individually guarded, preserving their identity while preventing unsafe access to malformed
 * third-party data. A missing or disabled plugin has no loaded registry instance and is represented
 * as `null`. Review this contract if Obsidian changes plugin loading or Hover Editor changes these
 * fields.
 */
interface HoverEditorPlugin {
    readonly settings?: HoverEditorSettings;
    readonly activePopovers?: readonly unknown[];
}

/**
 * The cross-window element operations needed to associate a Hover Editor popover with a leaf.
 *
 * Structural methods are used instead of `instanceof HTMLElement` because a valid element may
 * belong to an Obsidian popout window with a different DOM constructor. The contract preserves the
 * original element and only assumes Obsidian's `hasClass()` extension remains available.
 */
interface HoverEditorElement {
    contains(other: Node | null): boolean;
    hasClass(className: string): boolean;
}

/**
 * The minimal private Hover Editor popover contract used after matching a visible leaf.
 *
 * `toggleMinimized()` and `hide()` are invoked as member calls so Hover Editor retains their
 * original receiver. Their results are intentionally ignored and never awaited. Review this shape
 * if Hover Editor changes its popover element or lifecycle methods.
 */
interface HoverEditorPopover {
    readonly hoverEl: HoverEditorElement;
    toggleMinimized(): void;
    hide(): void;
}

/**
 * Narrows an untyped third-party value to a non-array object before reading named properties.
 *
 * This guard replaces direct casts at Obsidian plugin boundaries; class instances remain accepted,
 * while primitives, arrays, and `null` cannot cause unsafe member access.
 */
function isPropertyRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the loaded portion of Hover Editor that this integration may inspect.
 *
 * The registry value must be an object, optional settings must be object-like, and optional active
 * popovers must be an array. Unknown array entries are validated separately so one malformed entry
 * cannot be accessed unsafely. The same plugin object is returned by narrowing rather than cloned.
 */
function isHoverEditorPlugin(value: unknown): value is HoverEditorPlugin {
    if (!isPropertyRecord(value)) return false;

    return (value.settings === undefined || isPropertyRecord(value.settings))
        && (value.activePopovers === undefined || Array.isArray(value.activePopovers));
}

/**
 * Validates the element methods used to match a popover across main and popout windows.
 *
 * Structural checks avoid cross-window constructor failures and prevent unsafe calls when a private
 * Hover Editor payload is malformed. Only the operations needed by this integration are required.
 */
function isHoverEditorElement(value: unknown): value is HoverEditorElement {
    return isPropertyRecord(value)
        && typeof value.contains === 'function'
        && typeof value.hasClass === 'function';
}

/**
 * Validates one unknown active-popover entry before its DOM and lifecycle members are used.
 *
 * A valid entry keeps its original identity and receiver-bound methods. Missing element operations,
 * `toggleMinimized()`, or `hide()` cause that malformed entry to be skipped instead of throwing an
 * accidental unsafe-access error.
 */
function isHoverEditorPopover(value: unknown): value is HoverEditorPopover {
    return isPropertyRecord(value)
        && isHoverEditorElement(value.hoverEl)
        && typeof value.toggleMinimized === 'function'
        && typeof value.hide === 'function';
}

/**
 * Performs a side effect for one typed value emitted by a workspace traversal.
 *
 * @typeParam Item The exact view or embed delivered by the enclosing iterator after narrowing.
 *
 * The iterator, not the visitor, owns traversal. Results are ignored and cannot short-circuit;
 * incidental values remain harmless and returned Promises are not awaited. Synchronous errors still
 * stop at the same item. Iterators preserve the order supplied by Obsidian's `iterateAllLeaves()` or
 * `getLeavesOfType()` APIs, including main, floating/popout, and sidebar leaves, without active-first
 * ordering or deduplication. Same-file leaves therefore remain separate identities. Review this
 * contract if Obsidian changes leaf scope, order, or callback-result handling.
 */
type WorkspaceTraversalVisitor<Item> = (item: Item) => void;

/**
 * Visits one PDF viewer component and the file identity associated with its view or embed.
 *
 * The workspace iterator invokes this callback once for each discovered PDF view component and once
 * for every embed component, preserving leaf and embed order. `file` can be `null` for a PDF view;
 * embed files are present. Results are ignored, do not short-circuit traversal, and Promises are not
 * awaited; synchronous errors propagate. Distinct components for the same file are never collapsed.
 */
type PDFViewerComponentVisitor = (component: PDFViewerComponent, file: TFile | null) => void;

/**
 * Visits the child produced by Obsidian's private `PDFViewerComponent.then()` readiness callback.
 *
 * Registration follows component traversal order, while invocation retains the component's existing
 * immediate-or-deferred readiness timing. Results are ignored and Promises are not awaited by the
 * declared private contract; synchronous errors keep that API's existing behaviour. Review this
 * alias if Obsidian changes viewer-child readiness or callback ownership.
 */
type PDFViewerChildVisitor = (child: PDFViewerChild) => void;

export class WorkspaceLib extends PDFPlusLibSubmodule {
    hoverEditor: HoverEditorLib;

    constructor(...args: ConstructorParameters<typeof PDFPlusLibSubmodule>) {
        super(...args);
        this.hoverEditor = new HoverEditorLib(...args);
    }

    /**
     * Visits each loaded PDF view in Obsidian's all-leaf order.
     *
     * Main, popout, sidebar, hidden, pinned, and same-file leaves receive no additional filtering or
     * reordering beyond `isPDFView()`. Visitor results are ignored and cannot stop traversal.
     */
    iteratePDFViews(callback: WorkspaceTraversalVisitor<PDFView>): void {
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            if (this.lib.isPDFView(view)) callback(view);
        });
    }

    /**
     * Visits each backlink view in the order returned by `Workspace.getLeavesOfType()`.
     *
     * The callback receives the narrowed private backlink view; its result is ignored and cannot
     * short-circuit the array traversal.
     */
    iterateBacklinkViews(cb: WorkspaceTraversalVisitor<BacklinkView>): void {
        this.app.workspace.getLeavesOfType('backlink').forEach((leaf) => cb(leaf.view as BacklinkView));
    }

    /**
     * Visits each loaded Canvas view in Obsidian's all-leaf order.
     *
     * Active state, window, split, tab, visibility, and pinning do not affect ordering or inclusion;
     * visitor results are ignored and cannot stop traversal.
     */
    iterateCanvasViews(callback: WorkspaceTraversalVisitor<CanvasView>): void {
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            if (this.lib.isCanvasView(view)) callback(view);
        });
    }

    /**
     * Visits PDF embeds within Markdown, Canvas, and Excalidraw views in leaf and embed-array order.
     *
     * Same-file embeds remain distinct. Native `forEach()` still supplies incidental index and array
     * arguments at runtime, while the public visitor contract exposes only the embed. Results are
     * ignored and do not short-circuit either traversal level.
     */
    iteratePDFEmbeds(callback: WorkspaceTraversalVisitor<PDFEmbed>): void {
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            if (view instanceof MarkdownView) {
                const embeds = this.lib.getAllPDFEmbedsInMarkdownView(view);
                embeds.forEach(callback);
            } else if (this.lib.isCanvasView(view)) {
                const embeds = this.lib.getAllPDFEmbedsInCanvasView(view);
                embeds.forEach(callback);
            } else if (this.lib.isExcalidrawView(view)) {
                const embeds = this.lib.getAllPDFEmbedsInExcalidrawView(view);
                embeds.forEach(callback);
            }
        });
    }

    /**
     * Visits every PDF viewer component discovered in PDF views and supported embed hosts.
     *
     * Traversal preserves Obsidian leaf order and each host's embed order. Components for separate
     * same-file leaves are emitted independently; callback results are ignored without short-circuit.
     */
    iteratePDFViewerComponents(callback: PDFViewerComponentVisitor): void {
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;

            if (this.lib.isPDFView(view)) {
                callback(view.viewer, view.file);
            } else if (view instanceof MarkdownView) {
                this.lib.getAllPDFEmbedsInMarkdownView(view)
                    .forEach((embed) => callback(embed.viewer, embed.file));
            } else if (this.lib.isCanvasView(view)) {
                this.lib.getAllPDFEmbedsInCanvasView(view)
                    .forEach((embed) => callback(embed.viewer, embed.file));
            } else if (this.lib.isExcalidrawView(view)) {
                this.lib.getAllPDFEmbedsInExcalidrawView(view)
                    .forEach((embed) => callback(embed.viewer, embed.file));
            }
        });
    }

    /**
     * Registers a visitor for each discovered PDF viewer child's existing readiness lifecycle.
     *
     * Component discovery does not merge same-file leaves. The private component decides whether the
     * child callback runs immediately or later; this helper does not await results or own cleanup.
     */
    iteratePDFViewerChild(callback: PDFViewerChildVisitor): void {
        this.iteratePDFViewerComponents((component) => {
            component.then((child) => callback(child));
        });
    }

    getActivePDFView(): PDFView | null {
        const view = this.plugin.classes.PDFView
            ? this.app.workspace.getActiveViewOfType(this.plugin.classes.PDFView)
            : this.app.workspace.getMostRecentLeaf()?.view;
        if (view && this.lib.isPDFView(view)) return view;
        return null;
    }

    getActiveCanvasView(): CanvasView | null {
        const view = this.app.workspace.getMostRecentLeaf()?.view;
        if (view && this.lib.isCanvasView(view)) return view;
        return null;
    }

    getActiveExcalidrawView(): ExcalidrawView | null {
        const view = this.app.workspace.getMostRecentLeaf()?.view;
        if (view && this.lib.isExcalidrawView(view)) return view;
        return null;
    }

    /**
     * Get an existing leaf that holds the given PDF file, if any.
     * If the leaf has been already loaded, `leaf.view` will be an instance of `PDFView`.
     * If not, `leaf.view` will be an instance of `DeferredView`. If you want to ensure that
     * the view is `PDFView`, do `await leaf.loadIfDeferred()` followed by `if (lib.isPDFView(leaf.view))`.
     * 
     * @param file Must be a PDF file.
     */
    getExistingLeafForPDFFile(file: TFile): WorkspaceLeaf | null {
        const activeLeaf = this.app.workspace.getMostRecentLeaf();
        if (activeLeaf?.view.getViewType() === 'pdf'
            && this.getFilePathFromView(activeLeaf.view) === file.path) {
            return activeLeaf;
        }

        return this.getExistingLeafForFile(file);
    }

    getActiveGroupLeaves() {
        const activeGroup = this.app.workspace.getMostRecentLeaf()?.group;
        if (!activeGroup) return null;

        return this.app.workspace.getGroupLeaves(activeGroup);
    }

    async openMarkdownLinkFromPDF(linktext: string, sourcePath: string, paneType: PaneType | boolean, position?: { pos: Pos } | { line: number }) {
        const sourceActiveLeaf = this.app.workspace.getMostRecentLeaf();
        const sourcePDFLeaf = sourceActiveLeaf?.view.getViewType() === 'pdf'
            && this.getFilePathFromView(sourceActiveLeaf.view) === sourcePath
            ? sourceActiveLeaf
            : null;
        const { path: markdownLinkPath } = parseLinktext(linktext);
        const targetMarkdownFile = this.app.metadataCache.getFirstLinkpathDest(markdownLinkPath, sourcePath);
        let markdownLeaf: WorkspaceLeaf | undefined;

        if (paneType) {
            markdownLeaf = this.app.workspace.getLeaf(paneType);
        } else {
            // first handle the sidebar case
            if (isSidebarType(this.settings.paneTypeForFirstMDLeaf) && this.settings.alwaysUseSidebar) {
                markdownLeaf = this.getMarkdownLeafInSidebar(this.settings.paneTypeForFirstMDLeaf);
            } else {
                markdownLeaf = this.getMarkdownLeafForLinkFromPDF(linktext, sourcePath);
            }
        }

        // Note: at this point, `markdownLeaf.view` might be a defered view.
        // However, it does not matter because we do not access any `MarkdownView`-specific properties
        // before the view is loaded by `openLinkText`.

        // About eState:
        // - `line`, `startLoc` & `endLoc`: Highlight & scroll to the specified location in the target markdown file.
        //   In live preview, it requires `focus` to be `true`. Otherwise, the location is not highlighted nor scrolled to.
        // - `scroll`: Scroll to the specified line in the target markdown file.
        const openViewState: OpenViewState = {};
        if (position) {
            if ('pos' in position) {
                const { pos } = position;
                openViewState.eState = { line: pos.start.line, startLoc: pos.start, endLoc: pos.end };
            } else {
                const { line } = position;
                openViewState.eState = { line };
            }

            openViewState.eState.scroll = openViewState.eState.line;
            openViewState.eState.focus = !this.settings.dontActivateAfterOpenMD;
        }
        // Ignore the "dontActivateAfterOpenMD" option when opening a link in a tab in the same split as the current tab.
        const activeLeaf = this.app.workspace.getMostRecentLeaf();
        if (!(markdownLeaf.parentSplit instanceof WorkspaceTabs
            && markdownLeaf.parentSplit === activeLeaf?.parentSplit)) {
            openViewState.active = !this.plugin.settings.dontActivateAfterOpenMD;
        }

        await markdownLeaf.openLinkText(linktext, sourcePath, openViewState);
        if (sourcePDFLeaf && targetMarkdownFile?.extension === 'md') {
            this.plugin.pdfReturnContextByMarkdownLeaf.set(markdownLeaf, {
                pdfLeaf: sourcePDFLeaf,
                markdownPath: targetMarkdownFile.path
            });
        }
        await this.revealLeaf(markdownLeaf);

        return;
    }

    /**
     * Get a leaf to open a markdown file in. The leaf can be an existing one or a new one,
     * depending on the user preference and the current state of the workspace.
     * 
     * Note that the returned leaf might contain a deferred view, so it is not guaranteed
     * that `leaf.view` is an instance of `MarkdownView`.
     */
    getMarkdownLeafInSidebar(sidebarType: SidebarType) {
        if (this.settings.singleMDLeafInSidebar) {
            return this.lib.workspace.getExistingMarkdownLeafInSidebar(sidebarType)
                ?? this.lib.workspace.getNewLeafInSidebar(sidebarType);
        } else {
            return this.lib.workspace.getNewLeafInSidebar(sidebarType);
        }
    }

    /**
     * Given a link from a PDF file to a markdown file, return a leaf to open the link in.
     * The returned leaf can be an existing one or a new one.
     * Note that the leaf might contain a deferred view, so you need to call `await leaf.loadIfDeferred()`
     * before accessing any properties specific to the view type.
     * 
     * @param linktext A link text to a markdown file.
     * @param sourcePath If non-empty, it should end with ".pdf".
     */
    getMarkdownLeafForLinkFromPDF(linktext: string, sourcePath: string): WorkspaceLeaf {
        const { path: linkpath } = parseLinktext(linktext);
        const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);

        // 1. If the target markdown file is already opened, open the link in the same leaf
        // 2. If not, create a new leaf under the same parent split as the first existing markdown leaf
        let markdownLeaf: WorkspaceLeaf | undefined;
        let markdownLeafParent: WorkspaceSplit | undefined;

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (markdownLeaf) return;

            let createInSameParent = true;

            // The following line uses `getViewType() === 'markdown'` instead of 
            // `instanceof MarkdownView` in order to ensure a leaf with a deferred markdown views
            // are also caught.
            if (leaf.view.getViewType() === 'markdown') {
                const root = leaf.getRoot();
                for (const split of this.settings.ignoreExistingMarkdownTabIn) {
                    if (root === this.app.workspace[split]) return;
                }

                if (leaf.parentSplit instanceof WorkspaceTabs) {
                    const sharesSameTabParentWithThePDF = leaf.parentSplit.children.some((item) => {
                        if (item instanceof WorkspaceLeaf && item.view.getViewType() === 'pdf') {
                            return this.getFilePathFromView(item.view) === sourcePath;

                            // The following will not work if the view is a DeferredView
                            // const view = item.view as PDFView;
                            // return view.file?.path === sourcePath;
                        }
                    });
                    if (sharesSameTabParentWithThePDF) {
                        createInSameParent = false;
                    }
                }

                if (createInSameParent) markdownLeafParent = leaf.parentSplit;

                if (file && this.getFilePathFromView(leaf.view) === file.path) {
                    markdownLeaf = leaf;
                }
            }
        });

        if (!markdownLeaf) {
            if (isSidebarType(this.settings.paneTypeForFirstMDLeaf)
                && this.settings.singleMDLeafInSidebar
                && markdownLeafParent
                && this.isInSidebar(markdownLeafParent)) {
                markdownLeaf = this.getExistingMarkdownLeafInSidebar(this.settings.paneTypeForFirstMDLeaf)
                    ?? this.lib.workspace.getNewLeafInSidebar(this.settings.paneTypeForFirstMDLeaf);
            } else {
                markdownLeaf = markdownLeafParent
                    ? this.app.workspace.createLeafInParent(markdownLeafParent, -1)
                    : this.getLeaf(this.plugin.settings.paneTypeForFirstMDLeaf);
            }
        }

        return markdownLeaf;
    }

    isInSidebar(item: WorkspaceItem): boolean {
        const root = item.getRoot();
        return root === this.app.workspace.rightSplit || root === this.app.workspace.leftSplit;
    }

    getLeaf(paneType: ExtendedPaneType | boolean): WorkspaceLeaf {
        if (paneType === '') paneType = false;
        if (typeof paneType === 'boolean' || isPaneType(paneType)) {
            return this.app.workspace.getLeaf(paneType);
        }
        if (isFineGrainedSplitDirection(paneType)) {
            return this.getLeafBySplit(paneType);
        }
        return this.getLeafInSidebar(paneType);
    }

    getLeafBySplit(direction: FineGrainedSplitDirection): WorkspaceLeaf {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (leaf) {
            if (['right', 'left'].contains(direction)) {
                return this.app.workspace.createLeafBySplit(leaf, 'vertical', direction === 'left');
            } else if (['down', 'up'].contains(direction)) {
                return this.app.workspace.createLeafBySplit(leaf, 'horizontal', direction === 'up');
            }
        }
        return this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 0);
    }

    getLeafInSidebar(sidebarType: SidebarType): WorkspaceLeaf {
        return this.getNewLeafInSidebar(sidebarType);
    }

    /**
     * Get an existing leaf that is opened a markdown file in the sidebar
     * specified by `sidebarType`, if any.
     * Note that the returned leaf can contain a deferred view, so it is not guaranteed
     * that `leaf.view` is an instance of `MarkdownView`.
     */
    getExistingMarkdownLeafInSidebar(sidebarType: SidebarType): WorkspaceLeaf | null {
        let sidebarLeaf: WorkspaceLeaf | undefined;
        const root = sidebarType === 'right-sidebar'
            ? this.app.workspace.rightSplit
            : this.app.workspace.leftSplit;

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (sidebarLeaf || leaf.getRoot() !== root) return;

            // Don't use `instanceof MarkdownView` here because the view might be a deferred view.
            if (leaf.view.getViewType() === 'markdown') sidebarLeaf = leaf;
        });

        return sidebarLeaf ?? null;
    }

    getNewLeafInSidebar(sidebarType: SidebarType): WorkspaceLeaf {
        const leaf = sidebarType === 'right-sidebar'
            ? this.app.workspace.getRightLeaf(false)
            : this.app.workspace.getLeftLeaf(false);
        if (!leaf) throw new Error('No sidebar leaf found');
        return leaf;
    }

    /**
     * Almost the same as Workspace.prototype.revealLeaf, but this version
     * properly reveals a leaf even when it is contained in a secondary window.
     * 
     * Update: The upstream bug of Obsidian has been fixed in v1.5.11: https://obsidian.md/changelog/2024-03-13-desktop-v1.5.11/
     * 
     * Update 2: From Obsidian v1.7.2, the original `revealLeaf` is async (it now awaits `loadIfDeferred` inside), hence this method is now async as well.
     */
    async revealLeaf(leaf: WorkspaceLeaf) {
        if (requireApiVersion('1.5.11')) {
            await this.app.workspace.revealLeaf(leaf);
            return;
        }

        if (!Platform.isDesktopApp) {
            // on mobile, we don't need to care about new windows so just use the original method
            await this.app.workspace.revealLeaf(leaf);
            return;
        }

        // Fix the bug that had existed before Obsidian v1.5.11
        const root = leaf.getRoot();
        if (root instanceof WorkspaceSidedock && root.collapsed) {
            root.toggle();
        }

        const parent = leaf.parent;
        if (parent instanceof WorkspaceTabs) {
            parent.selectTab(leaf);
        }

        // This is the only difference from the original `revealLeaf` method.
        // Obsidian's `revealLeaf` uses `root.getContainer().focus()` instead, which causes a bug that the main window is focused when the leaf is in a secondary window.
        leaf.getContainer().focus();
    }

    openPDFLinkTextInLeaf(leaf: WorkspaceLeaf, linktext: string, sourcePath: string, openViewState?: OpenViewState): Promise<void> {
        const { subpath } = parseLinktext(linktext);
        if (!this.plugin.patchStatus.pdfInternals) {
            this.plugin.subpathWhenPatched = subpath;
            if (subpath) this.plugin.subpathsWhenPatched.set(leaf, subpath);
        }

        return leaf.openLinkText(linktext, sourcePath, openViewState).then(async () => {
            await this.revealLeaf(leaf);

            const view = leaf.view;

            if (this.lib.isPDFView(view)) {
                view.viewer.then((child) => {
                    const duration = this.plugin.settings.highlightDuration;
                    this.lib.highlight.viewer.highlightSubpath(child, duration);
                });
            }
        });
    }

    /**
     * Returns the exact PDF leaf that opened the active Markdown source, when it still shows the
     * requested target PDF.
     *
     * Obsidian may reuse both Markdown and PDF leaves, so this validates the active leaf identity,
     * current Markdown path, connected PDF leaf, PDF view type, and target file path at use time.
     * This prevents a link from falling back to an arbitrary same-file split while retaining each
     * PDF viewer child's independent page and scroll state.
     */
    getPDFReturnLeaf(sourcePath: string, targetFile: TFile): WorkspaceLeaf | null {
        const markdownLeaf = this.app.workspace.getMostRecentLeaf();
        if (!markdownLeaf || markdownLeaf.view.getViewType() !== 'markdown') return null;

        const context = this.plugin.pdfReturnContextByMarkdownLeaf.get(markdownLeaf);
        if (!context || context.markdownPath !== sourcePath) return null;

        const { pdfLeaf } = context;
        if (!pdfLeaf.containerEl.isConnected
            || pdfLeaf.view.getViewType() !== 'pdf'
            || this.getFilePathFromView(pdfLeaf.view) !== targetFile.path) {
            return null;
        }

        return pdfLeaf;
    }

    /**
     * If the target PDF file is already opened in a tab, open the link in that tab.
     * 
     * @param linktext A link text to a PDF file.
     * @param sourcePath 
     * @param openViewState `active` will be overwritten acccording to `this.plugin.settings.dontActivateAfterOpenPDF`.
     * @param targetFile If provided, it must be the target PDF file that the link points to.
     * @param preferredLeaf Exact same-file PDF leaf retained by a PDF-to-note navigation context.
     * @returns An object containing a boolean value indicating whether a tab with the target PDF file already exists and a promise that resolves when the link is opened.
     */
    openPDFLinkTextInExistingLeafForTargetPDF(linktext: string, sourcePath: string, openViewState?: OpenViewState, targetFile?: TFile, preferredLeaf?: WorkspaceLeaf): { exists: boolean, promise: Promise<void> } {
        if (!targetFile) {
            const { path } = parseLinktext(linktext);
            targetFile = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) ?? undefined;
        }
        if (!targetFile) return { exists: false, promise: Promise.resolve() };

        const preferredLeafMatches = preferredLeaf?.view.getViewType() === 'pdf'
            && this.getFilePathFromView(preferredLeaf.view) === targetFile.path;
        const sameFileLeaf = preferredLeafMatches
            ? preferredLeaf
            : this.getExistingLeafForPDFFile(targetFile);
        if (!sameFileLeaf) return { exists: false, promise: Promise.resolve() };


        // Ignore the "dontActivateAfterOpenPDF" option when opening a link in a tab in the same split as the current tab.
        const activeLeaf = this.app.workspace.getMostRecentLeaf();
        if (!(sameFileLeaf.parentSplit instanceof WorkspaceTabs && sameFileLeaf.parentSplit === activeLeaf?.parentSplit)) {
            openViewState = openViewState ?? {};
            openViewState.active = !this.settings.dontActivateAfterOpenPDF;
        }

        if (sameFileLeaf.isVisible() && this.settings.highlightExistingTab) {
            sameFileLeaf.containerEl.addClass('pdf-plus-link-opened', 'is-highlighted');
            window.setTimeout(() => sameFileLeaf.containerEl.removeClass('pdf-plus-link-opened', 'is-highlighted'), this.settings.existingTabHighlightDuration * 1000);
        }

        const promise = this.openPDFLinkTextInLeaf(sameFileLeaf, linktext, sourcePath, openViewState);
        return { exists: true, promise };
    }

    /**
     * Get an existing leaf that holds the given file, if any.
     * If the leaf has been already loaded, `leaf.view` will be an instance of a subclass of `FileView`,
     * e.g., `PDFView` for a PDF file, `MarkdownView` for a markdown file.
     * If not, `leaf.view` will be an instance of `DeferredView`. If you want to ensure that
     * the view is not deferred and is indeed an instance of a view class corresponding to the file type,
     * do `await leaf.loadIfDeferred()` followed by `if (lib.isPDFView(leaf.view))`.
     */
    getExistingLeafForFile(file: TFile): WorkspaceLeaf | null {
        // Get the view type that corresponds to the file extension.
        // e.g. 'markdown' for '.md', 'pdf' for '.pdf'
        const viewType = this.app.viewRegistry.getTypeByExtension(file.extension);
        if (!viewType) return null;

        let leaf: WorkspaceLeaf | null = null;

        this.app.workspace.iterateAllLeaves((l) => {
            if (leaf) return;

            // About the if check below:
            // Before Obsidian v1.7.2 introduced DeferredView, the condition was something like
            // `l.view instanceof (...)View && l.view.file === file`.
            // Now, it is invalid because the first condition will filter out `DeferredView`,
            // which is not the desired behavior in most cases.
            // (Also, a `DeferredView` does not have a `file` property.)

            // One more thing to note is that the view type checking is crucial
            // to filtering out "linked file views" like backlink views, outgoing link views, and outline views.

            if (l.view.getViewType() === viewType && this.getFilePathFromView(l.view) === file.path) {
                leaf = l;
            }
        });

        return leaf;
    }

    /**
     * Returns a leaf that holds the given markdown file, if any.
     * `leaf.view` can be an instance of `MarkdownView` or `DeferredView`.
     */
    getExistingLeafForMarkdownFile(file: TFile): WorkspaceLeaf | null {
        return this.getExistingLeafForFile(file);
    }

    isMarkdownFileOpened(file: TFile): boolean {
        return !!this.getExistingLeafForMarkdownFile(file);
    }

    registerHideSidebar(leaf: WorkspaceLeaf) {
        const root = leaf.getRoot();
        // "if (root instanceof WorkspaceSidedock || root instanceof WorkspaceMobileDrawer)"
        // causes the following error: TypeError: Right-hand side of 'instanceof' is not an object.
        // The following is a workaround for this problem.
        if (root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit) {
            const sidebar = root === this.app.workspace.leftSplit
                ? this.app.workspace.leftSplit
                : this.app.workspace.rightSplit;
            const eventRef = this.app.workspace.on('active-leaf-change', (anotherLeaf) => {
                if (anotherLeaf && anotherLeaf.getRoot() !== sidebar) {
                    sidebar.collapse();
                    this.app.workspace.offref(eventRef);
                }
            });
        }
    }

    /**
     * Returns the path of the file opened in the given view.
     * This method ensures that it works even if the view is a `DeferredView`.
     * @param view An actual `FileView` or a `DefferedView` for a `FileView`.
     * @returns 
     */
    getFilePathFromView(view: View): string | null {
        // `view.file?.path` will fail if the view is a `DeferredView`.
        const path = view.getState().file;
        return typeof path === 'string' ? path : null;
    }

    /**
     * Ensuress that the view in the given leaf is fully loaded (not deferred)
     * after the returned promise is resolved. Never forget to await it when you call this method.
     */
    async ensureViewLoaded(leaf: WorkspaceLeaf): Promise<void> {
        if (requireApiVersion('1.7.2')) {
            await leaf.loadIfDeferred();
        }
    }
}


/**
 * Integrates with the optional Hover Editor plugin through Obsidian's `link-hover` event.
 *
 * Hover creation deliberately avoids Hover Editor's private `spawnPopover()` method. Private plugin
 * state is read only to honor its trigger delay and post-process the matching popover. Both main and
 * popout leaves are handled through Obsidian's shared workspace and structural DOM contracts.
 */
class HoverEditorLib extends PDFPlusLibSubmodule {

    /**
     * Returns the currently loaded Hover Editor instance without retaining a stale reference.
     *
     * Obsidian's community-plugin registry is private and cannot provide a trustworthy public type,
     * so its value is narrowed from `unknown`. Disabled, unloaded, missing, or malformed instances
     * return `null`; a valid instance is returned with its exact identity.
     */
    get hoverEditorPlugin(): HoverEditorPlugin | null {
        const plugin: unknown = this.app.plugins.plugins['obsidian-hover-editor'];
        return isHoverEditorPlugin(plugin) ? plugin : null;
    }

    /**
     * Reads Hover Editor's optional hover delay after validating its dynamic settings value.
     *
     * Non-numeric or missing values preserve the existing `undefined` fallback used by hover
     * creation timing.
     */
    get waitTime(): number | undefined {
        const triggerDelay = this.hoverEditorPlugin?.settings?.triggerDelay;
        return typeof triggerDelay === 'number' ? triggerDelay : undefined;
    }

    /**
     * Identifies a Hover Editor leaf by its existing container ancestry in either app window.
     */
    isHoverEditorLeaf(leaf: WorkspaceLeaf): boolean {
        return leaf.containerEl.closest('.popover.hover-popover.hover-editor') !== null;
    }

    /**
     * Requests one Hover Editor leaf through Obsidian's `link-hover` event contract.
     *
     * Arguments retain Obsidian's event order: hover parent, target element, link text, source path,
     * then opaque state. State may contain private file, source-leaf, page, or subpath data and is
     * forwarded unchanged rather than cast or inspected. The first activated hover leaf is returned;
     * otherwise the existing timeout resolves `null`. Dispatch errors reject the returned Promise,
     * and no event result is consumed or awaited. `targetEl` may belong to the main or a popout window.
     */
    async createNewHoverEditorLeaf(hoverParent: HoverParent, targetEl: HTMLElement | null, linktext: string, sourcePath: string, state?: unknown): Promise<WorkspaceLeaf | null> {
        if (!this.hoverEditorPlugin) return null;

        return new Promise<WorkspaceLeaf | null>((resolve) => {
            const eventRef = this.app.workspace.on('active-leaf-change', (leaf) => {
                if (leaf && this.isHoverEditorLeaf(leaf)) {
                    this.app.workspace.offref(eventRef);
                    resolve(leaf);
                }
            });

            this.app.workspace.trigger('link-hover', hoverParent, targetEl, linktext, sourcePath, state);

            window.setTimeout(() => {
                this.app.workspace.offref(eventRef);
                resolve(null);
            }, (this.waitTime ?? 300) + 300);
        });
    }

    /**
     * Visits Hover Editor leaves in Obsidian's all-leaf order, including popout leaves.
     *
     * Callback results are deliberately ignored, cannot short-circuit traversal, and returned
     * Promises are not awaited; synchronous errors retain their existing propagation behaviour.
     */
    iterateHoverEditorLeaves(callback: (leaf: WorkspaceLeaf) => void): void {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (this.isHoverEditorLeaf(leaf)) callback(leaf);
        });
    }

    /**
     * Returns the same guarded Hover Editor popover whose element contains the supplied leaf.
     *
     * Unknown or malformed private entries are skipped. Structural element checks preserve main-
     * and popout-window compatibility without reconstructing either the popover or its DOM element.
     */
    getHoverEditorForLeaf(leaf: WorkspaceLeaf): HoverEditorPopover | null {
        return this.hoverEditorPlugin?.activePopovers
            ?.find((popover): popover is HoverEditorPopover => {
                return isHoverEditorPopover(popover)
                    && popover.hoverEl.contains(leaf.containerEl);
            }) ?? null;
    }

    /**
     * Applies existing PDF Scholia Scribe lifecycle behavior to one Hover Editor leaf.
     *
     * Popover methods remain receiver-bound member calls, their results are ignored, and the
     * active-leaf listener is removed at the same point after hiding an ephemeral popover.
     */
    postProcessHoverEditorLeaf(leaf: WorkspaceLeaf): void {
        if (this.isHoverEditorLeaf(leaf)) {
            const popover = this.getHoverEditorForLeaf(leaf);

            if (popover) {
                // ensure the hover editor is not minimized
                if (popover.hoverEl.hasClass('is-minimized')) popover.toggleMinimized();

                // make the hover editor "ephemeral"
                if (this.settings.closeHoverEditorWhenLostFocus) {
                    const eventRef = this.app.workspace.on('active-leaf-change', (anotherLeaf) => {
                        if (anotherLeaf !== leaf) {
                            popover.hide();
                            this.app.workspace.offref(eventRef);
                        }
                    });
                }
            }
        }
    }
}
