import { SearchMatchPart, SearchMatches, TFile } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { BacklinkPanePDFManager } from 'pdf-backlink';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';
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
type BacklinkFileLifecycleMethod = PatchedMethod<BacklinkView, [TFile], void | Promise<void>>;

/**
 * Local shape for the backlink search result renderer patched by this file.
 *
 * This documents the exact Obsidian backlink renderer contract that the plugin
 * forwards after filtering PDF link matches. It keeps the dynamic prototype
 * patch at a single boundary, replacing the previous unsafe `old.call(...)`
 * path with typed forwarding. The assumption is that Obsidian keeps passing the
 * same result payload shape described by the local backlink typings.
 */
type SearchResultAddMethod = PatchedMethod<
    SearchResultDom,
    [TFile, FileSearchResult, string, boolean],
    SearchResultFileDom
>;


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
            const original: BacklinkFileLifecycleMethod = asPatchedMethod(old);
            return async function (this: BacklinkView, file: TFile): Promise<void> {
                await callPatchedMethod(original, this, [file]);
                if (this.getViewType() === 'backlink' && file.extension === 'pdf') {
                    this.pdfManager = new BacklinkPanePDFManager(plugin, this.backlink, file).setParents(plugin, this);
                }
            };
        },
        onUnloadFile(old) {
            const original: BacklinkFileLifecycleMethod = asPatchedMethod(old);
            return async function (this: BacklinkView, file: TFile): Promise<void> {
                if (file.extension === 'pdf' && this.pdfManager) {
                    this.pdfManager.unload();
                }
                await callPatchedMethod(original, this, [file]);
            };
        }
    }));

    plugin.register(around(backlinkRenderer.backlinkDom.constructor.prototype, {
        addResult(old) {
            const original: SearchResultAddMethod = asPatchedMethod(old);
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

                return callPatchedMethod(original, this, [file, result, content, showTitle]);
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
