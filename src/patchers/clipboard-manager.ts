import { MarkdownView, Platform } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';
import { ClipboardManager, Draggable, DropEffect } from 'typings';

/**
 * Local shape for Obsidian's private `ClipboardManager.handleDragOver` method.
 *
 * Obsidian does not export this method contract directly, so the patcher keeps
 * the assumed signature beside the prototype patch that depends on it. The
 * current implementation receives a single drag event and returns nothing. If
 * Obsidian changes the method arguments or return value, this alias and the
 * forwarding call below should be updated together.
 */
type ClipboardDragOverMethod = PatchedMethod<ClipboardManager, [DragEvent], void>;

/**
 * Local shape for Obsidian's private `ClipboardManager.handleDrop` method.
 *
 * The public API does not expose this ClipboardManager internals contract, but
 * the plugin must forward the original method for non-PDF drops. The current
 * implementation receives one drag event and returns whether the drop was
 * handled. If Obsidian changes that return convention, update this alias before
 * changing the wrapper behavior.
 */
type ClipboardDropMethod = PatchedMethod<ClipboardManager, [DragEvent], boolean>;

/**
 * Plugin-specific drag payload that can render itself as Markdown text.
 *
 * Obsidian's base `Draggable` type cannot include this property because
 * `getText` is attached by this plugin's PDF drag registration code. Keeping
 * the interface local documents that this is PDF Scholia Scribe behavior layered
 * on top of Obsidian's private drag manager contract.
 */
interface PDFPlusTextDraggable extends Draggable {
    source: 'pdf-plus';
    getText(sourcePath: string): unknown;
}

/**
 * Narrows Obsidian's private drag payload to the plugin text-producing shape.
 *
 * The runtime check prevents a malformed or future PDF drag payload from
 * reaching `draggable.getText(...)` when that method is absent. It replaces the
 * previous `@ts-ignore` with an explicit guard and assumes valid plugin PDF
 * drags continue to expose `source: "pdf-plus"` plus a `getText` function.
 */
const isPDFPlusTextDraggable = (draggable: Draggable): draggable is PDFPlusTextDraggable => {
    const candidate: Draggable & { getText?: unknown } = draggable;
    return candidate.source === 'pdf-plus' && typeof candidate.getText === 'function';
};

export const patchClipboardManager = (plugin: PDFPlus) => {
    const app = plugin.app;

    let clipboardManager: ClipboardManager | undefined;

    app.workspace.iterateAllLeaves((leaf) => {
        // leaf.view.getViewType() === 'markdown' is not reliable here
        // because the view might be a deferred view, which does not have editMode
        if (leaf.view instanceof MarkdownView) {
            clipboardManager = leaf.view.editMode.clipboardManager;
        }
    });

    if (!clipboardManager) return false;

    plugin.register(around(clipboardManager.constructor.prototype, {
        /**
         * Passed to CodeMirror's domEventHandlers.
         * Returned value is boolean (but only `true` counts), and according to the CodeMirror docs, it means:
         * 
         * > the first handler to return true will be assumed to have handled that event,
         * > and no other handlers or built-in behavior will be activated for it.
         */
        handleDragOver(old) {
            const original: ClipboardDragOverMethod = asPatchedMethod(old);
            return function (this: ClipboardManager, evt: DragEvent): void {
                const draggable = app.dragManager.draggable;
                if (!draggable || draggable.source !== 'pdf-plus') {
                    return callPatchedMethod(original, this, [evt]);
                }

                if (Platform.isMacOS ? evt.shiftKey : evt.altKey) return;
                else
                // if (draggable.type === 'annotation-link') 
                {
                    setDragEffect(evt, 'link');
                    app.dragManager.setAction('Insert link here');
                }
            };
        },
        handleDrop(old) {
            const original: ClipboardDropMethod = asPatchedMethod(old);
            return function (this: ClipboardManager, evt: DragEvent): boolean {
                const draggable = app.dragManager.draggable;

                if (!draggable || draggable.source !== 'pdf-plus') {
                    return callPatchedMethod(original, this, [evt]);
                }

                // the instanceof check ensures that this.info has the handleDrop method
                // (here, we don't have to care about deferred views because the user is interacting with the view when dragging & dropping)
                if (this.info instanceof MarkdownView && (Platform.isMacOS ? evt.shiftKey : evt.altKey)) {
                    evt.preventDefault();
                    this.info.handleDrop(evt, draggable, false);
                    return true;
                }

                const editor = this.info.editor;
                if (!editor) return false;

                if (!isPDFPlusTextDraggable(draggable)) return false;

                const textToInsert = draggable.getText(this.getPath());

                const offset = editor.cm.posAtCoords({ x: evt.clientX, y: evt.clientY }, false);
                const pos = editor.offsetToPos(offset);

                editor.setCursor(pos);

                if (typeof textToInsert === 'string') {
                    editor.replaceSelection(textToInsert);
                    editor.focus();
                    evt.preventDefault();
                    return true;
                }

                return false;
            };
        }
    }));

    return true;
};

// taken from app.js

const allowDropEffectMap = {
    none: [],
    copy: ['copy'],
    copyLink: ['copy', 'link'],
    copyMove: ['copy', 'move'],
    link: ['link'],
    linkMove: ['link', 'move'],
    move: ['move'],
    all: ['copy', 'link', 'move'],
    uninitialized: []
};

function setDragEffect(evt: DragEvent, dropEffect: DropEffect) {
    if (!evt.dataTransfer) return;
    if (evt.dataTransfer.effectAllowed === 'none' || evt.dataTransfer.effectAllowed === 'uninitialized') return;

    if (dropEffect === 'none')
        return evt.dataTransfer.dropEffect = dropEffect;
    const allowDropAffects = allowDropEffectMap[evt.dataTransfer.effectAllowed];
    if (allowDropAffects.contains(dropEffect)) {
        evt.dataTransfer.dropEffect = dropEffect;
    }
}
