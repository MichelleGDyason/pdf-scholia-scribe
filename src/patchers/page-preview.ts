import { HoverParent, parseLinktext, type App } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';

/**
 * Private Obsidian Page Preview plugin instance shape used by this patcher.
 *
 * Obsidian exposes the built-in page-preview plugin through `app.internalPlugins`,
 * not through the public plugin API, so this alias keeps the private contract
 * local to the code that patches it. If Obsidian changes where the page preview
 * instance lives or renames `onLinkHover`, this alias and the patch target
 * below need to change together.
 */
type PagePreviewInstance = App['internalPlugins']['plugins']['page-preview']['instance'];

/**
 * Local shape for the private `PagePreview.onLinkHover` method.
 *
 * The method is patched through `monkey-around`, which provides the original
 * method as an untyped value. This alias documents the known argument tuple and
 * lets the patcher forward the call through `callPatchedMethod()` instead of
 * using unsafe `old.call(...)`. The final `state` argument remains `unknown`
 * because Obsidian forwards hover payloads from multiple sources.
 */
type PagePreviewOnLinkHoverMethod = PatchedMethod<
    PagePreviewInstance,
    Parameters<PagePreviewInstance['onLinkHover']>,
    ReturnType<PagePreviewInstance['onLinkHover']>
>;

/**
 * Hover state emitted by the backlink visualizer when a PDF backlink highlight
 * asks Page Preview to open the corresponding Markdown location.
 *
 * This payload is plugin-specific and travels through Obsidian's untyped
 * `hover-link` state channel, so it cannot be imported from Obsidian. The
 * `scroll` field is assumed to be the Markdown line number produced by the
 * backlink visualizer. If that payload changes, update this interface and the
 * guard below before changing the Page Preview branch.
 */
interface BacklinkVisualizerHoverState {
    isTriggeredFromBacklinkVisualizer: unknown;
    scroll: number;
}

/**
 * Narrows an unknown Page Preview hover state to the backlink visualizer
 * payload this patcher understands.
 *
 * The runtime check prevents unsafe reads of `isTriggeredFromBacklinkVisualizer`
 * and `scroll` from arbitrary Obsidian hover payloads. It replaces the previous
 * broad `any` state access and assumes valid backlink visualizer payloads carry
 * a truthy trigger marker plus a numeric Markdown line.
 */
const isBacklinkVisualizerHoverState = (state: unknown): state is BacklinkVisualizerHoverState => {
    if (typeof state !== 'object' || state === null) return false;
    const candidate = state as Partial<Record<keyof BacklinkVisualizerHoverState, unknown>>;
    return !!candidate.isTriggeredFromBacklinkVisualizer && typeof candidate.scroll === 'number';
};

export const patchPagePreview = (plugin: PDFPlus): boolean => {
    const app = plugin.app;
    const lib = plugin.lib;
    const pagePreviewInstance = app.internalPlugins.plugins['page-preview'].instance;

    // Patch the instance instead of the prototype to avoid conflicts with Hover Editor
    // https://github.com/nothingislost/obsidian-hover-editor/issues/259

    plugin.register(around(pagePreviewInstance, {
        onLinkHover(old) {
            const original: PagePreviewOnLinkHoverMethod = asPatchedMethod(old);
            return function (this: PagePreviewInstance, hoverParent: HoverParent, targetEl: HTMLElement | null, linktext: string, sourcePath: string, state: unknown): void {
                const { path: linkpath, subpath } = parseLinktext(linktext);
                const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);

                if ((!sourcePath || sourcePath.endsWith('.pdf')) && plugin.settings.hoverHighlightAction === 'open' && isBacklinkVisualizerHoverState(state)) {
                    void lib.workspace.openMarkdownLinkFromPDF(linktext, sourcePath, false, { line: state.scroll });
                    return;
                }

                if (file?.extension === 'pdf' && sourcePath.endsWith('.md')) {
                    if (plugin.settings.hoverPDFLinkToOpen) {
                        // If the target PDF is already opened in a tab, open PDF link in that tab
                        // instead of showing popover preview
                        const { exists } = lib.workspace.openPDFLinkTextInExistingLeafForTargetPDF(linktext, sourcePath, undefined, file);
                        if (exists) return;
                    }

                    if (plugin.settings.ignoreHeightParamInPopoverPreview && subpath.contains('height=')) {
                        const params = new URLSearchParams(subpath.slice(1));
                        linktext = linkpath
                            + '#'
                            + Array.from(params.entries())
                                .filter(([key]) => key !== 'height')
                                .map(([key, value]) => `${key}=${value}`)
                                .join('&');
                    }
                }

                callPatchedMethod(original, this, [hoverParent, targetEl, linktext, sourcePath, state]);
            };
        }
    }));

    plugin.patchStatus.pagePreview = true;

    return true;
};
