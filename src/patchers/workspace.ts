import { OpenViewState, PaneType, Workspace, parseLinktext, Platform } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';
import { focusObsidian } from 'utils';

/**
 * Arguments accepted by Obsidian's public `Workspace.openLinkText()` method.
 *
 * The tuple is declared locally because `monkey-around` does not preserve Obsidian's method type at
 * the patch boundary. Argument order and identity are significant: `newLeaf` carries the caller's
 * explicit pane request, while `openViewState` may carry target state. Neither may be replaced by a
 * file-path lookup, because two leaves displaying the same PDF remain distinct viewer instances.
 * Review this tuple if Obsidian changes the public method signature.
 */
type WorkspaceOpenLinkTextArgs = [
    linktext: string,
    sourcePath: string,
    newLeaf?: PaneType | boolean,
    openViewState?: OpenViewState
];

/**
 * The original Obsidian `Workspace.openLinkText()` method forwarded by this patch.
 *
 * Obsidian returns the Promise representing link navigation. The receiver must remain the same
 * `Workspace` instance so active-leaf, explicit-pane, main-window, and popout routing stay under the
 * original workspace. `asPatchedMethod()` centralizes the unavoidable dynamic boundary without
 * changing the method or its result.
 */
type WorkspaceOpenLinkTextMethod = PatchedMethod<Workspace, WorkspaceOpenLinkTextArgs, Promise<void>>;

/**
 * Runtime result of the PDF-aware `Workspace.openLinkText()` wrapper.
 *
 * Every navigation path passes through its original `Promise<void>` unchanged. The sole `undefined`
 * case is the existing synchronized-default-app branch, which deliberately defers handling to the
 * active-leaf listener. Consumers may await this union without changing Promise adoption. Review the
 * alias if Obsidian or the plugin's intentionally short-circuited branch changes its return contract.
 */
type WorkspaceOpenLinkTextPatchResult = Promise<void> | undefined;

/**
 * Prototype contract used only while installing the PDF-aware `openLinkText()` wrapper.
 *
 * `monkey-around` requires a wrapper to return exactly the type declared on its target method, but
 * this long-standing wrapper has one intentional `undefined` result when synchronized default-app
 * handling is delegated to an active-leaf listener. Widening only this patch target represents that
 * runtime behavior without changing Obsidian's original `Promise<void>` contract or manufacturing a
 * replacement Promise. Review this interface if that delegated branch or `monkey-around` changes.
 */
interface WorkspaceOpenLinkTextPatchTarget {
    openLinkText: PatchedMethod<Workspace, WorkspaceOpenLinkTextArgs, WorkspaceOpenLinkTextPatchResult>;
}

const isPDFPageInputActive = () => {
    const activeEl = activeDocument.activeElement;
    return activeEl instanceof HTMLInputElement
        && activeEl.hasClass('pdf-page-input')
        && activeEl.closest('.pdf-toolbar') !== null;
};

export const patchWorkspace = (plugin: PDFPlus) => {
    const app = plugin.app;
    const lib = plugin.lib;
    const workspacePrototype: WorkspaceOpenLinkTextPatchTarget = Workspace.prototype;

    plugin.register(around(workspacePrototype, {
        openLinkText(old) {
            const original: WorkspaceOpenLinkTextMethod = asPatchedMethod(old);
            return function (this: Workspace, linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState): WorkspaceOpenLinkTextPatchResult {
                if (isPDFPageInputActive()) {
                    return callPatchedMethod(original, this, [linktext, sourcePath, newLeaf, openViewState]);
                }

                if ((plugin.settings.openPDFWithDefaultApp || plugin.settings.singleTabForSinglePDF || plugin.settings.openLinkNextToExistingPDFTab || plugin.settings.paneTypeForFirstPDFLeaf) && !newLeaf) { // respect `newLeaf` when it's not `false`
                    const { path } = parseLinktext(linktext);
                    const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);

                    if (file && file.extension === 'pdf') {

                        if (Platform.isDesktopApp && plugin.settings.openPDFWithDefaultApp) {
                            if (plugin.settings.openPDFWithDefaultAppAndObsidian && plugin.settings.syncWithDefaultApp) {
                                return; // will be handled by the 'active-leaf-change' event handler
                            }
                            const promise = app.openWithDefaultApp(file.path);
                            if (plugin.settings.focusObsidianAfterOpenPDFWithDefaultApp) {
                                focusObsidian();
                            }
                            if (!plugin.settings.openPDFWithDefaultAppAndObsidian) {
                                return promise;
                            }
                        }

                        if (plugin.settings.singleTabForSinglePDF) {
                            const { exists, promise } = lib.workspace.openPDFLinkTextInExistingLeafForTargetPDF(linktext, sourcePath, openViewState, file);
                            if (exists) return promise;
                        }

                        if (plugin.settings.openLinkNextToExistingPDFTab || plugin.settings.paneTypeForFirstPDFLeaf) {
                            const pdfLeaf = lib.getPDFView()?.leaf;
                            if (pdfLeaf) {
                                if (plugin.settings.openLinkNextToExistingPDFTab && pdfLeaf.parentSplit) {
                                    const newLeaf = app.workspace.createLeafInParent(pdfLeaf.parentSplit, -1);
                                    return lib.workspace.openPDFLinkTextInLeaf(newLeaf, linktext, sourcePath, openViewState);
                                }
                            } else if (plugin.settings.paneTypeForFirstPDFLeaf) {
                                const newLeaf = lib.workspace.getLeaf(plugin.settings.paneTypeForFirstPDFLeaf);
                                return lib.workspace.openPDFLinkTextInLeaf(newLeaf, linktext, sourcePath, openViewState);
                            }
                        }
                    }
                }

                return callPatchedMethod(original, this, [linktext, sourcePath, newLeaf, openViewState]);
            };
        }
    }));

    plugin.patchStatus.workspace = true;
};
