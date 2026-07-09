import { SearchMatchPart, SearchMatches, TFile } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { BacklinkPanePDFManager } from 'pdf-backlink';
import { findReferenceCache } from 'utils';
import { BacklinkView, FileSearchResult, SearchResultDom, SearchResultFileDom } from 'typings';

/**
 * Local shape for Obsidian backlink view file lifecycle methods patched here.
 *
 * The alias exists because Obsidian does not expose these backlink internals in
 * its public API, while `monkey-around` still has to forward their original
 * file argument and possible async result. Keeping the argument concrete and
 * the return type narrow is safer than calling an untyped `old.call(...)`
 * directly. This is Obsidian-specific and does not describe any PDF.js API.
 */
type BacklinkFileLifecycleMethod = (this: BacklinkView, file: TFile) => void | Promise<void>;

/**
 * Local shape for the backlink search result renderer patched by this file.
 *
 * This documents the exact Obsidian backlink renderer contract that the plugin
 * forwards after filtering PDF link matches. It keeps the dynamic prototype
 * patch at a single boundary, replacing the previous unsafe `old.call(...)`
 * path with typed forwarding. The assumption is that Obsidian keeps passing the
 * same result payload shape described by the local backlink typings.
 */
type SearchResultAddMethod = (
    this: SearchResultDom,
    file: TFile,
    result: FileSearchResult,
    content: string,
    showTitle: boolean
) => SearchResultFileDom;

/**
 * Adapts `monkey-around`'s untyped original lifecycle method into the local
 * backlink view method shape.
 *
 * The runtime value comes from Obsidian's private backlink view prototype, so a
 * cast is still necessary. This helper keeps that cast small and documented,
 * and future backlink lifecycle patches should use it instead of casting or
 * calling the original method directly.
 */
const asBacklinkFileLifecycleMethod = (method: unknown): BacklinkFileLifecycleMethod => {
    return method as BacklinkFileLifecycleMethod;
};

/**
 * Calls a typed backlink lifecycle method while preserving Obsidian's original
 * `this` value and file argument.
 *
 * `Reflect.apply` replaces the unsafe `Function.call` pattern and lets the
 * typed alias determine the return type. Awaiting here preserves the previous
 * async behavior for both synchronous and Promise-returning Obsidian methods.
 */
const callBacklinkFileLifecycleMethod = async (
    method: BacklinkFileLifecycleMethod,
    view: BacklinkView,
    file: TFile
): Promise<void> => {
    await Reflect.apply(method, view, [file]);
};

/**
 * Adapts `monkey-around`'s untyped result renderer into the local backlink
 * search-result method shape.
 *
 * The helper exists because the renderer prototype is private Obsidian UI
 * machinery, but this plugin only needs to filter matches before forwarding the
 * same arguments. It is safer than a direct cast at the call site because all
 * unsafe knowledge about the private renderer is contained here.
 */
const asSearchResultAddMethod = (method: unknown): SearchResultAddMethod => {
    return method as SearchResultAddMethod;
};

/**
 * Calls Obsidian's original backlink search-result renderer after the plugin
 * has filtered PDF link matches.
 *
 * Centralizing the `Reflect.apply` call avoids repeated unsafe `.call(...)`
 * usage and preserves the typed `SearchResultFileDom` return expected by the
 * surrounding backlink DOM code.
 */
const callSearchResultAddMethod = (
    method: SearchResultAddMethod,
    dom: SearchResultDom,
    file: TFile,
    result: FileSearchResult,
    content: string,
    showTitle: boolean
): SearchResultFileDom => {
    return Reflect.apply(method, dom, [file, result, content, showTitle]);
};


export const patchBacklink = (plugin: PDFPlus): boolean => {
    const { app, lib } = plugin;

    // 1. Try to access a BacklinkRenderer instance from a backlinks view
    const backlinkView = app.workspace
        .getLeavesOfType('backlink')
        // leaf.view might be a deffered view even if the view type says 'backlink'
        .find((leaf) => lib.isBacklinkView(leaf.view))?.view as BacklinkView | undefined;
    const backlinkRenderer = backlinkView?.backlink;

    // The below is commented out because this feature is irrerevant to "backlink in document"

    // // 2. If failed, try to access a BacklinkRenderer instance from "backlink in document" of a markdown view
    // for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    //     if (backlink) break
    //     const mdView = leaf.view as MarkdownView;
    //     backlink = mdView.backlinks;
    // }

    if (!backlinkView || !backlinkRenderer) return false;

    plugin.register(around(Object.getPrototypeOf(backlinkView.constructor.prototype), {
        onLoadFile(old) {
            const original = asBacklinkFileLifecycleMethod(old);
            return async function (this: BacklinkView, file: TFile): Promise<void> {
                await callBacklinkFileLifecycleMethod(original, this, file);
                if (this.getViewType() === 'backlink' && file.extension === 'pdf') {
                    this.pdfManager = new BacklinkPanePDFManager(plugin, this.backlink, file).setParents(plugin, this);
                }
            };
        },
        onUnloadFile(old) {
            const original = asBacklinkFileLifecycleMethod(old);
            return async function (this: BacklinkView, file: TFile): Promise<void> {
                if (file.extension === 'pdf' && this.pdfManager) {
                    this.pdfManager.unload();
                }
                await callBacklinkFileLifecycleMethod(original, this, file);
            };
        }
    }));

    plugin.register(around(backlinkRenderer.backlinkDom.constructor.prototype, {
        addResult(old) {
            const original = asSearchResultAddMethod(old);
            return function (this: SearchResultDom, file: TFile, result: FileSearchResult, content: string, showTitle: boolean): SearchResultFileDom {
                if (this.filter) {
                    const cache = app.metadataCache.getFileCache(file);
                    if (cache) {
                        const resultFromContent: SearchMatches = [];

                        for (const [start, end] of result.content) {
                            const linkCache = findReferenceCache(cache, start, end);
                            if (linkCache && this.filter(file, linkCache)) resultFromContent.push([start, end]);
                        }

                        result.content.length = 0;
                        result.content.push(...resultFromContent);

                        const resultFromProperties: { key: string, pos: SearchMatchPart, subkey: string[] }[] = [];

                        for (const item of result.properties) {
                            const linkCache = cache.frontmatterLinks?.find((link) => link.key === item.key);
                            if (linkCache && this.filter(file, linkCache)) resultFromProperties.push(item);
                        }
                        result.properties.length = 0;
                        result.properties.push(...resultFromProperties);
                    }
                }

                return callSearchResultAddMethod(original, this, file, result, content, showTitle);
            };
        }
    }));

    lib.workspace.iterateBacklinkViews((view) => {
        // reflect the patch to existing backlink views
        if (view.file?.extension === 'pdf') {
            void Promise.resolve(view.onLoadFile(view.file)).catch(console.error);
        }
    });

    plugin.patchStatus.backlink = true;

    return true;
};
