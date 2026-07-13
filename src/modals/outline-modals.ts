import { PDFOutlineItem, PDFOutlines } from 'lib/outlines';
import PDFPlus from 'main';
import { PDFPlusModal } from 'modals';
import { Setting, FuzzySuggestModal } from 'obsidian';


/**
 * The text submitted by the shared outline-title modal.
 *
 * This result intentionally contains no PDF.js node or lookup key. Rename and subitem consumers
 * retain the clicked visible node, its position-path identity, and any destination in their own
 * closures, so identical title-and-destination entries are never disambiguated by this value.
 */
interface OutlineInfo {
    title: string;
}


/**
 * Applies a validated title after the title modal closes.
 *
 * Every current consumer performs an asynchronous outline mutation or creation and returns a
 * `Promise<void>`. The modal starts that work without awaiting it; rejected Promises are reported by
 * the existing `console.error` handler, while a synchronous throw before a Promise is returned still
 * propagates from the invocation site. The result is otherwise ignored. Clicked-item identity and
 * PDF.js position paths remain captured by the consumer rather than reconstructed from the title.
 */
type PDFOutlineTitleConfirmationCallback = (
    answer: OutlineInfo
) => Promise<void>;

/**
 * Moves the previously resolved outline item to a destination chosen by the fuzzy-suggest modal.
 *
 * The argument is a `PDFOutlineItem` from the same local `PDFOutlines` model as the item being moved.
 * The consumer retains the exact path-resolved source item, mutates links, sorts children, and saves
 * asynchronously. The modal does not await or consume the result; rejections are logged by the
 * existing handler and synchronous throws continue to propagate. Review this contract if the local
 * outline model or Obsidian's destination-selection lifecycle changes.
 */
type PDFOutlineMoveDestinationCallback = (
    destination: PDFOutlineItem
) => Promise<void>;


export class PDFOutlineTitleModal extends PDFPlusModal {
    next: PDFOutlineTitleConfirmationCallback[] = [];
    modalTitle: string;
    submitted: boolean = false;

    title: string | null = null; // the title of an outline item

    constructor(plugin: PDFPlus, modalTitle: string) {
        super(plugin);
        this.modalTitle = modalTitle;

        // Don't use `Scope` or `keydown` because they will cause the modal to be closed
        // when hitting Enter with IME on
        this.component.registerDomEvent(this.modalEl.doc, 'keypress', (evt) => {
            if (evt.key === 'Enter') {
                this.submitAndClose();
            }
        });
    }

    presetTitle(title: string) {
        this.title = title;
        return this;
    }

    onOpen() {
        super.onOpen();

        this.titleEl.setText(`${this.plugin.manifest.name}: ${this.modalTitle}`);

        new Setting(this.contentEl)
            .setName('Title')
            .addText((text) => {
                if (this.title !== null) {
                    text.setValue(this.title);
                    text.inputEl.select();
                }
                text.inputEl.size = 30;
                text.inputEl.id = 'pdf-plus-outline-title-modal';
            });

        new Setting(this.contentEl)
            .addButton((button) => {
                button
                    .setButtonText('Add')
                    .setCta()
                    .onClick(() => {
                        this.submitAndClose();
                    });
            })
            .addButton((button) => {
                button
                    .setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    });
            });
    }

    ask() {
        this.open();
        return this;
    }

    then(callback: PDFOutlineTitleConfirmationCallback) {
        if (this.submitted && this.title !== null) {
            void Promise.resolve(callback({ title: this.title })).catch(console.error);
        } else {
            this.next.push(callback);
        }
        return this;
    }

    submitAndClose() {
        const inputEl = this.contentEl.querySelector('#pdf-plus-outline-title-modal');
        if (inputEl instanceof HTMLInputElement) {
            this.title = inputEl.value;
            this.submitted = true;
            this.close();
        }
    }

    onClose() {
        if (this.submitted && this.title !== null) {
            const title = this.title;
            this.next.forEach((callback) => {
                void Promise.resolve(callback({ title })).catch(console.error);
            });
        }
    }
}


export class PDFOutlineMoveModal extends FuzzySuggestModal<PDFOutlineItem> {
    plugin: PDFPlus;
    outlines: PDFOutlines;
    items: PDFOutlineItem[];
    next: PDFOutlineMoveDestinationCallback[] = [];

    constructor(outlines: PDFOutlines, itemToMove: PDFOutlineItem) {
        super(outlines.plugin.app);
        this.outlines = outlines;
        this.plugin = outlines.plugin;
        this.items = [];
        this.outlines.iter({
            enter: (item) => {
                if (!itemToMove.isAncestorOf(item, true) && !item.is(itemToMove.parent)) {
                    this.items.push(item);
                }
            }
        });
        this.setPlaceholder('Type an outline item title');
    }

    askDestination() {
        this.open();
        return this;
    }

    then(callback: PDFOutlineMoveDestinationCallback) {
        this.next.push(callback);
        return this;
    }

    getItems(): PDFOutlineItem[] {
        return this.items;
    }

    getItemText(item: PDFOutlineItem) {
        return item.name;
    }

    onChooseItem(item: PDFOutlineItem): void {
        this.next.forEach((callback) => {
            void Promise.resolve(callback(item)).catch(console.error);
        });
    }
}
