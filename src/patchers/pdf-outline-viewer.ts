import { around } from 'monkey-around';

import PDFPlus from 'main';
import { onOutlineItemContextMenu } from 'context-menu';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';
import { PDFOutlineTreeNode, PDFOutlineViewer } from 'typings';


/**
 * Models Obsidian's private PDF outline context-menu method.
 *
 * This contract is declared locally because Obsidian does not export the
 * outline viewer class through its public API. It replaces an unsafe
 * `old.call(...)` invocation while preserving the clicked tree-node object
 * that the outline code uses to recover its position path. It assumes the
 * current method receives one PDF.js outline node and one mouse event and
 * resolves without a value; review this alias if Obsidian changes that private
 * signature or PDF.js changes the outline-node payload.
 */
type PDFOutlineItemContextMenuMethod = PatchedMethod<
    PDFOutlineViewer,
    [item: PDFOutlineTreeNode, event: MouseEvent],
    Promise<void>
>;


export const patchPDFOutlineViewer = (plugin: PDFPlus, pdfOutlineViewer: PDFOutlineViewer) => {
    plugin.register(around(pdfOutlineViewer.constructor.prototype, {
        onItemContextMenu(old) {
            const original: PDFOutlineItemContextMenuMethod = asPatchedMethod(old);

            return async function (this: PDFOutlineViewer, item: PDFOutlineTreeNode, evt: MouseEvent): Promise<void> {
                const child = this.viewer;
                const file = child.file;

                if (!plugin.settings.outlineContextMenu || !file) {
                    await callPatchedMethod(original, this, [item, evt]);
                    return;
                }

                onOutlineItemContextMenu(plugin, child, file, item, evt);
            };
        }
    }));

    return true;
};
