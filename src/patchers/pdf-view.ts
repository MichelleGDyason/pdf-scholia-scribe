import { TFile, ViewStateResult } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';
import { PDFView, PDFViewState } from 'typings';
import { patchPDFInternals } from './pdf-internals';

const RESTORE_PDF_VIEW_STATE_DELAYS = [0, 250, 1000] as const;

/**
 * Arguments accepted by Obsidian's private `PDFView.getState()` method.
 *
 * The method is synchronous and takes no arguments. Keeping the empty tuple explicit prevents the
 * monkey-patch boundary from forwarding incidental values that the private method does not receive.
 * Review this alias if Obsidian adds parameters to PDF view state capture.
 */
type PDFViewGetStateArguments = [];

/**
 * Private Obsidian PDF state returned by `PDFView.getState()` and refined by this plugin.
 *
 * The shared `PDFViewState` contract preserves the file plus the viewer-specific `page`, `left`,
 * `top`, and `zoom` fields. The patch mutates the original object in place and returns that same
 * object; it does not clone, normalize, or share state between leaves. Each receiver therefore
 * reports its own PDF viewer child in both the main window and popouts. Review this alias if
 * Obsidian changes the private state keys or their optionality.
 */
type PDFViewGetStateResult = PDFViewState;

/**
 * Original private Obsidian `PDFView.getState()` method received from `monkey-around`.
 *
 * Receiver identity determines which leaf, viewer child, page, and scroll position are captured;
 * a PDF path is not a viewer identity because several leaves may display the same file. The original
 * method returns one mutable state object synchronously, and synchronous errors pass through.
 */
type OriginalPDFViewGetStateMethod = PatchedMethod<PDFView, PDFViewGetStateArguments, PDFViewGetStateResult>;

/**
 * PDF-aware `getState()` wrapper installed on Obsidian's private PDF view prototype.
 *
 * The wrapper calls the original method once with the same receiver, then overwrites `page`, `left`,
 * `top`, and `zoom` from that receiver's ready PDF.js viewer. It returns the original object without
 * cloning it and does not consult the active leaf, file-path matches, or another window. Review this
 * contract if Obsidian changes PDF viewer-child ownership or the original return shape.
 */
type PatchedPDFViewGetStateMethod = PatchedMethod<PDFView, PDFViewGetStateArguments, PDFViewGetStateResult>;

/**
 * Incoming private PDF view state accepted by Obsidian's `PDFView.setState()` method.
 *
 * The shared contract includes the document path and receiver-specific page, scroll, and zoom data.
 * The wrapper forwards this object unchanged to Obsidian but first makes the existing shallow clone
 * used for per-leaf delayed restoration; additional runtime properties remain preserved by that
 * spread. Review this alias if Obsidian changes the private PDF state shape.
 */
type PDFViewSetStateInput = PDFViewState;

/**
 * Ordered arguments accepted by the private `PDFView.setState()` method.
 *
 * `state` is the exact caller-owned object and `result` is Obsidian's caller-owned history control.
 * Both identities and their order must be preserved because history is updated before the original
 * method runs. Review this tuple if Obsidian changes the method signature.
 */
type PDFViewSetStateArguments = [state: PDFViewSetStateInput, result: ViewStateResult];

/**
 * Promise returned by the PDF-aware `setState()` wrapper.
 *
 * The wrapper deliberately returns the new Promise created by `.then()`, not Obsidian's original
 * Promise. It resolves to `undefined` after receiver-specific restoration registration completes,
 * preserves original rejections, and rejects if synchronous restoration in the fulfillment callback
 * throws. No catch handler or additional awaiting is introduced.
 */
type PDFViewSetStateWrapperResult = Promise<void>;

/**
 * Original private Obsidian `PDFView.setState()` method received from `monkey-around`.
 *
 * Obsidian receives the original state and history objects on the same `PDFView` receiver and returns
 * `Promise<void>`. Receiver identity is essential because same-file main-window and popout leaves own
 * separate viewer children and history. Review this alias if Obsidian changes its Promise contract.
 */
type OriginalPDFViewSetStateMethod = PatchedMethod<PDFView, PDFViewSetStateArguments, Promise<void>>;

/**
 * PDF-aware `setState()` wrapper installed on Obsidian's private PDF view prototype.
 *
 * The wrapper stores one shallow state clone under the receiver's `WorkspaceLeaf`, optionally marks
 * the supplied history result, calls the original method once, and restores only that receiver after
 * fulfillment. It never selects a viewer by file path or active leaf. Main-window and popout behavior
 * therefore follows the receiving view. Review this contract with any restoration-order change.
 */
type PatchedPDFViewSetStateMethod = PatchedMethod<PDFView, PDFViewSetStateArguments, PDFViewSetStateWrapperResult>;

/**
 * Re-applies one captured state to the current PDF.js viewer owned by the original `PDFView` receiver.
 *
 * The callback is registered at the existing readiness and timer points. It intentionally performs
 * no validation or fallback and may throw according to the existing PDF.js restoration path. Using
 * the captured view, rather than a file lookup or active leaf, preserves same-file leaf independence.
 */
type PDFViewStateRestorationCallback = () => void;

const clonePDFViewState = (state: PDFViewState): PDFViewState => ({ ...state });

const capturePDFViewStatesForInternalsPatch = (plugin: PDFPlus) => {
    if (plugin.patchStatus.pdfInternals) return;

    plugin.lib.workspace.iteratePDFViews((view) => {
        const state = view.getState();
        if (
            typeof state.file === 'string'
            && typeof state.page === 'number'
            && !plugin.pdfViewStatesWhenPatched.has(view.leaf)
        ) {
            plugin.pdfViewStatesWhenPatched.set(view.leaf, clonePDFViewState(state));
        }
    });
};

const restorePDFViewState = (plugin: PDFPlus, view: PDFView, state: PDFViewState) => {
    if (typeof state.page !== 'number') return;

    const applyState: PDFViewStateRestorationCallback = () => {
        const pdfViewer = view.viewer.child?.pdfViewer?.pdfViewer;
        if (pdfViewer) {
            plugin.lib.applyPDFViewStateToViewer(pdfViewer, state);
        }
    };

    view.viewer.then((child) => {
        const pdfViewer = child.pdfViewer?.pdfViewer;
        if (!pdfViewer) return;

        plugin.lib.applyPDFViewStateToViewer(pdfViewer, state);

        if (!pdfViewer.pagesCount) {
            plugin.lib.registerPDFEvent('pagesloaded', pdfViewer.eventBus, null, () => {
                const currentPDFViewer = child.pdfViewer?.pdfViewer;
                if (currentPDFViewer) {
                    plugin.lib.applyPDFViewStateToViewer(currentPDFViewer, state);
                }
            });
        }

        RESTORE_PDF_VIEW_STATE_DELAYS.forEach((delay) => {
            window.setTimeout(applyState, delay);
        });
    });

    applyState();
};

export const patchPDFView = (plugin: PDFPlus): boolean => {
    if (plugin.patchStatus.pdfView && plugin.patchStatus.pdfInternals) return true;

    const lib = plugin.lib;

    const pdfView = lib.getPDFView();
    if (!pdfView) return false;

    capturePDFViewStatesForInternalsPatch(plugin);

    if (!plugin.patchStatus.pdfView) {
        plugin.register(around(pdfView.constructor.prototype, {
            getState(old) {
                const original: OriginalPDFViewGetStateMethod = asPatchedMethod(old);
                const patched: PatchedPDFViewGetStateMethod = function (this: PDFView): PDFViewGetStateResult {
                    const ret = callPatchedMethod(original, this, []);
                    const child = this.viewer.child;
                    const pdfViewer = child?.pdfViewer?.pdfViewer;
                    if (pdfViewer) {
                        // When the PDF viewer's top edge is on the lower half of the previous page,
                        // pdfViewer._location?.pageNumber points to the previous page, but 
                        // currentPageNumber points to the current page.
                        // For our purpose, the former is preferable, so we use it if available.
                        ret.page = pdfViewer._location?.pageNumber ?? pdfViewer.currentPageNumber;
                        ret.left = pdfViewer._location?.left;
                        ret.top = pdfViewer._location?.top;
                        ret.zoom = pdfViewer.currentScale;
                    }
                    return ret;
                };
                return patched;
            },
            setState(old) {
                const original: OriginalPDFViewSetStateMethod = asPatchedMethod(old);
                const patched: PatchedPDFViewSetStateMethod = function (this: PDFView, state: PDFViewSetStateInput, result: ViewStateResult): PDFViewSetStateWrapperResult {
                    const stateToRestore = clonePDFViewState(state);
                    if (!plugin.patchStatus.pdfInternals) {
                        plugin.pdfViewStatesWhenPatched.set(this.leaf, stateToRestore);
                    }
                    if (plugin.settings.alwaysRecordHistory) {
                        result.history = true;
                    }
                    return callPatchedMethod(original, this, [state, result]).then(() => {
                        restorePDFViewState(plugin, this, stateToRestore);
                    });
                };
                return patched;
            },
            // Called inside onModify
            onLoadFile(old) {
                return async function (file: TFile) {
                    // The original implementation is `this.viewer.loadFile(e)`, which ignores the subpath

                    // Restore the last page, position & zoom level on file mofiication
                    const self = this as PDFView;
                    const state = self.getState();
                    const subpath = lib.viewStateToSubpath(state);
                    return self.viewer.loadFile(file, subpath ?? undefined);
                };
            }
        }));

        plugin.patchStatus.pdfView = true;

        // @ts-ignore
        plugin.classes.PDFView = pdfView.constructor;
    }

    if (!plugin.patchStatus.pdfInternals) void patchPDFInternals(plugin, pdfView.viewer).catch(console.error);

    // don't return true here; if patchPDFInternals is successful, plugin.patchStatus.pdfInternals
    // will be set to true when this function is called next time, and then this function will
    // return true
    return false;
};
