import { ButtonComponent, HoverPopover, HoverParent, Notice, ExtraButtonComponent, Events } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { isCanvas, isEmbed, isHoverPopover, isNonEmbedLike, onModKeyPress, toSingleLine } from 'utils';
import { PDFViewerChild, PDFJsDestArray, TextContentItem } from 'typings';


export type AnystyleJson = Partial<{
    author: { family: string, given: string }[],
    title: string[],
    date: string[],
    year: string, // Not present in the original anystyle output
    pages: string[],
    volume: string[],
    'container-title': string[],
    type: string,
}>;


export class BibliographyManager extends PDFPlusComponent {
    static readonly HOVER_LINK_SOURCE_ID = 'pdf-plus-citation-link';

    child: PDFViewerChild;
    destIdToBibText: Map<string, string>;
    destIdToParsedBib: Map<string, AnystyleJson>;
    events: Events;
    initialized: boolean;

    constructor(plugin: PDFPlus, child: PDFViewerChild) {
        super(plugin);
        this.child = child;
        this.destIdToBibText = new Map();
        this.destIdToParsedBib = new Map();
        this.events = new Events();
        this.initialized = false;
        void this.init();
    }

    isEnabled() {
        const viewer = this.child.pdfViewer;
        return this.settings.actionOnCitationHover !== 'none'
            && (
                isNonEmbedLike(viewer)
                || (this.settings.enableBibInCanvas && isCanvas(viewer))
                || (this.settings.enableBibInHoverPopover && isHoverPopover(viewer))
                || (this.settings.enableBibInEmbed && isEmbed(viewer))
            );
    }

    private async init() {
        if (this.isEnabled()) {
            await this.extractBibText();
            await this.parseBibText();
        }
        this.initialized = true;
    }

    private async extractBibText() {
        return new Promise<void>((resolve, reject) => {
            this.lib.onDocumentReady(this.child.pdfViewer, (doc) => {
                new BibliographyTextExtractor(this.plugin, doc)
                    .onExtracted((destId, bibText) => {
                        this.destIdToBibText.set(destId, bibText);
                        this.events.trigger('extracted', destId, bibText);
                    })
                    .extract()
                    .then(resolve)
                    .catch(reject);
            });
        });
    }

    private async parseBibText() {
        const text = Array.from(this.destIdToBibText.values()).join('\n');
        const parsed = await this.parseBibliographyText(text);
        if (parsed) {
            const destIds = Array.from(this.destIdToBibText.keys());
            for (let i = 0; i < parsed.length; i++) {
                this.destIdToParsedBib.set(destIds[i], parsed[i]);
                this.events.trigger('parsed', destIds[i], parsed[i]);
            }
        }
    }

    spawnBibPopoverOnModKeyDown(destId: string, hoverParent: HoverParent, event: MouseEvent, targetEl: HTMLElement) {
        const spawnBibPopover = () => {
            const hoverPopover = new HoverPopover(hoverParent, targetEl, 200);
            hoverPopover.hoverEl.addClass('pdf-plus-bib-popover');
            const bibContainerEl = hoverPopover.hoverEl.createDiv();
            hoverPopover.addChild(
                new BibliographyDom(this, destId, bibContainerEl)
            );
        };

        if (this.plugin.requireModKeyForLinkHover(BibliographyManager.HOVER_LINK_SOURCE_ID)) {
            onModKeyPress(event, targetEl, spawnBibPopover);
        } else {
            spawnBibPopover();
        }
    }

    getGoogleScholarSearchUrlFromDest(destId: string) {
        let searchText = '';

        // Generated the search text by extracting important information from the bibliography text
        // Heuristically, this gives better search results than just searching the entire bibliography text.
        const parsed = this.destIdToParsedBib.get(destId);
        if (parsed) {
            const { author, title, year, 'container-title': containerTitle } = parsed;
            if (title) searchText += `${title[0]}`;
            if (author) searchText += ' ' + author.map((a) => a.family).join(' ');
            if (year) searchText += ` ${year}`;
            if (containerTitle) searchText += ` ${containerTitle[0]}`;
        } else {
            searchText = this.destIdToBibText.get(destId) ?? '';
        }

        return searchText
            ? `https://scholar.google.com/scholar?hl=en&as_sdt=0%2C5&q=${encodeURIComponent(searchText)}`
            : null;
    }

    /** Parse a bibliography text using Anystyle. */
    async parseBibliographyText(_text: string): Promise<AnystyleJson[] | null> {
        return null;
    }


    on(name: 'extracted', callback: (destId: string, bibText: string) => any, ctx?: any): ReturnType<Events['on']>;
    on(name: 'parsed', callback: (destId: string, parsedBib: string) => any, ctx?: any): ReturnType<Events['on']>;
    on(name: string, callback: (...args: any[]) => any, ctx?: any) {
        return this.events.on(name, callback, ctx);
    }
}


class BibliographyTextExtractor {
    plugin: PDFPlus;
    doc: PDFDocumentProxy;
    pageRefToTextContentItemsPromise: Record<string, Promise<TextContentItem[]> | undefined>;
    onExtractedCallback?: (destId: string, bibText: string) => any;

    constructor(plugin: PDFPlus, doc: PDFDocumentProxy) {
        this.plugin = plugin;
        this.doc = doc;
        this.pageRefToTextContentItemsPromise = {};
    }

    onExtracted(callback: BibliographyTextExtractor['onExtractedCallback']) {
        this.onExtractedCallback = callback;
        return this;
    }

    async extract() {
        const dests = await this.doc.getDestinations();
        const promises: Promise<void>[] = [];
        for (const destId in dests) {
            if (this.plugin.lib.isCitationId(destId)) {
                const destArray = dests[destId] as PDFJsDestArray;
                promises.push(
                    this.extractBibTextForDest(destArray)
                        .then((bibInfo) => {
                            if (bibInfo) {
                                const bibText = bibInfo.text;
                                this.onExtractedCallback?.(destId, bibText);
                            }
                        })
                );
            }
        }
        await Promise.all(promises);
    }

    /** Get `TextContentItem`s contained in the specified page. This method avoids fetching the same info multiple times. */
    async getTextContentItemsFromPageRef(pageRef: PDFJsDestArray[0]) {
        const refStr = JSON.stringify(pageRef);

        return this.pageRefToTextContentItemsPromise[refStr] ?? (
            this.pageRefToTextContentItemsPromise[refStr] = (async () => {
                const pageNumber = await this.doc.getPageIndex(pageRef) + 1;
                const page = await this.doc.getPage(pageNumber);
                const items = (await page.getTextContent()).items as TextContentItem[];
                return items;
            })()
        );
    }

    async extractBibTextForDest(destArray: PDFJsDestArray) {
        const pageRef = destArray[0];
        const items = await this.getTextContentItemsFromPageRef(pageRef);

        // Whole lotta hand-crafted rules LOL

        let beginIndex = -1;
        if (destArray[1].name === 'XYZ') {
            const left = destArray[2];
            const top = destArray[3];
            if (left === null || top === null) return null;
            beginIndex = items.findIndex((item: TextContentItem) => {
                if (!item.str) return false;
                const itemLeft = item.transform[4];
                const itemTop = item.transform[5] + (item.height || item.transform[0]) * 0.8;
                return left <= itemLeft && itemTop <= top;
            });
        } else if (destArray[1].name === 'FitBH') {
            const top = destArray[2];
            if (top === null) return null;
            beginIndex = items.findIndex((item: TextContentItem) => {
                if (!item.str) return false;
                const itemTop = item.transform[5] + (item.height || item.transform[0]) * 0.8;
                return itemTop <= top;
            });
        }

        if (beginIndex === -1) return null;

        const beginItem = items[beginIndex];
        const beginItemLeft = beginItem.transform[4];
        let text = items[beginIndex].str;
        let idx = beginIndex + 1;
        const bibTextItems = [beginItem];
        while (true) {
            const item = items[idx];
            if (!item) break;

            const itemLeft = item.transform[4];

            if (itemLeft <= beginItemLeft + Math.max(item.height, 8) * 0.1) {
                break;
            }
            if (item.str.trimStart().startsWith('.') || item.str.trimStart().startsWith(',')) {
                text = text.trimEnd() + item.str.trimStart();
            } else {
                text += '\n' + item.str;
            }
            bibTextItems.push(item);
            idx++;
        }

        /// Remove the leading enumeration
        // [1], [2], [3], ...
        text = text.trimStart().replace(/^\[\d+\]/, '');
        // (1), (2), (3), ...
        text = text.trimStart().replace(/^\(\d+\)/, '');
        // 1., 2., 3., ...
        text = text.trimStart().replace(/^\d+\./, '');

        return { text: toSingleLine(text), items: bibTextItems };
    }
}


export class BibliographyDom extends PDFPlusComponent {
    containerEl: HTMLElement;
    destId: string;
    bib: BibliographyManager;

    constructor(bib: BibliographyManager, destId: string, containerEl: HTMLElement) {
        super(bib.plugin);
        this.bib = bib;
        this.destId = destId;
        this.containerEl = containerEl;
        this.containerEl.addClass('pdf-plus-bib');
    }

    get child() {
        return this.bib.child;
    }

    renderParsedBib(parsed: AnystyleJson) {
        const { author, title, year, 'container-title': containerTitle } = parsed;

        if (author) {
            this.containerEl.createDiv('', (el) => {
                el.createDiv('bib-title', (el) => {
                    el.setText(title?.[0] ?? 'No title');
                });
                el.createDiv('bib-author-year', (el) => {
                    const authorText = author
                        .map((a) => {
                            let name = '';
                            if (a.given) name += a.given;
                            if (a.family) name += ' ' + a.family;
                            return name;
                        })
                        .filter((name) => name)
                        .join(', ');
                    el.appendText(authorText);
                    if (year) {
                        el.appendText(` (${year})`);
                    }
                });
                if (containerTitle) {
                    el.createDiv('bib-container-title', (el) => {
                        el.setText(containerTitle[0]);
                    });
                }
            });
            return true;
        }

        return false;
    }

    onload() {
        void this.render().catch(console.error);
    }

    async render() {
        this.containerEl.empty();
        let done = false;

        const parsed = this.bib.destIdToParsedBib.get(this.destId);
        if (parsed) {
            done = this.renderParsedBib(parsed);
        }
        if (!done) {
            const bibText = this.bib.destIdToBibText.get(this.destId);

            if (bibText) {
                this.containerEl.createDiv({ text: bibText });
            } else {
                if (this.bib.initialized) {
                    this.containerEl.createDiv({ text: 'No bibliography found' });
                } else {
                    this.containerEl.createDiv({ text: 'Loading...' });
                    this.registerRenderOn('extracted');
                }
            }
        }

        this.containerEl.createDiv('button-container', (el) => {
            new ButtonComponent(el)
                .setButtonText('Google Scholar')
                .onClick(() => {
                    const url = this.bib.getGoogleScholarSearchUrlFromDest(this.destId);
                    if (!url) {
                        new Notice(`${this.plugin.manifest.name}: ${this.bib.initialized ? 'No bibliography found' : 'Still loading the bibliography information. Please try again later.'}`);
                        return;
                    }
                    window.open(url);
                });
            new ExtraButtonComponent(el)
                .setIcon('lucide-settings')
                .setTooltip('Customize...')
                .onClick(() => {
                    this.plugin.openSettingTab().scrollToHeading('citation');
                });
        });
    }

    registerRenderOn(eventName: 'parsed' | 'extracted') {
        // @ts-ignore
        const eventRef = this.bib.on(eventName, (destId) => {
            if (destId === this.destId) {
                void this.render().catch(console.error);
                this.bib.events.offref(eventRef);
            }
        });
        this.registerEvent(eventRef);
    }

    onunload() {
        this.containerEl.empty();
    }
}
