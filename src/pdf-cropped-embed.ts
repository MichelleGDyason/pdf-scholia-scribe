import { App, Component, Platform, TFile } from 'obsidian';
import pLimit from 'p-limit';

import PDFPlus from 'main';
import { AnnotationElement, Embed, EmbedContext, Rect } from 'typings';


/**
 * Models PDF.js `Util.normalizeRect()` for four-value rectangles in PDF coordinates.
 *
 * PDF.js owns the returned array and normalizes corner order without mutating the input. Its
 * published declaration currently uses `any` for both sides of this call, so this local callback
 * contract replaces only that unsafe boundary. Review it if PDF.js changes the accepted rectangle
 * shape, coordinate space, allocation behaviour, or normalization semantics.
 */
type NormalizePDFRect = (rect: Rect) => Rect;

/**
 * Represents the PDF.js annotation fields used to follow a cropped embed's source annotation.
 *
 * PDF.js owns these payloads; the plugin reads but never mutates them. The fields remain optional
 * because version-specific or malformed annotation data may omit either one. Reusing the existing
 * annotation data model avoids duplicating unrelated PDF.js fields.
 */
type CroppedEmbedAnnotationData = Partial<Pick<AnnotationElement['data'], 'id' | 'rect'>>;

/**
 * Narrows the untyped `PDFPageProxy.getAnnotations()` result to the fields consumed here.
 *
 * The page and returned payloads are owned by PDF.js. This local interface is necessary because
 * the installed PDF.js declaration returns `any[]`; review it if PDF.js types the payload or
 * changes the no-argument annotation query used by cropped embeds.
 */
interface CroppedEmbedAnnotationPage {
    getAnnotations(): Promise<CroppedEmbedAnnotationData[]>;
}

/**
 * Represents the bound render callback queued by `p-limit` for one cropped embed.
 *
 * The callback owns no external state beyond its bound embed instance, resolves to one image data
 * URL, and preserves the queue's existing asynchronous sequencing and rejection behaviour. This
 * contract replaces the broadly typed `Function.bind()` result and should be reviewed if
 * `computeDataUrl()` gains arguments or returns a different render result.
 */
type CroppedEmbedRenderCallback = () => Promise<string>;


export class PDFCroppedEmbed extends Component implements Embed {
    // Limit the number of concurrent PDF rendering tasks to avoid running out of memory
    // especially on mobile devices, which will cause the app to crash.
    // https://github.com/RyotaUshio/obsidian-pdf-plus/issues/397
    private static readonly limit = pLimit(Platform.isMobile ? 3 : 10);

    app: App;
    containerEl: HTMLElement;

    get lib() {
        return this.plugin.lib;
    }

    constructor(public plugin: PDFPlus, public ctx: EmbedContext, public file: TFile, public subpath: string, public pageNumber: number, public rect: Rect, public width?: number, public annotationId?: string) {
        super();
        this.app = ctx.app;
        this.containerEl = ctx.containerEl;
        this.rect = (window.pdfjsLib.Util.normalizeRect as NormalizePDFRect)(rect);
        this.containerEl.addClass('pdf-cropped-embed');
        if (width) this.containerEl.setAttribute('width', '' + width);
    }

    onload() {
        super.onload();

        if (this.shouldUpdateOnModify()) {
            this.registerEvent(this.app.vault.on('modify', (file) => {
                if (file === this.file) {
                    void this.loadFile().catch(console.error);
                }
            }));
        }

        if (this.plugin.settings.rectFollowAdaptToTheme) {
            this.registerEvent(this.app.workspace.on('css-change', () => {
                void this.loadFile().catch(console.error);
            }));
            this.registerEvent(this.plugin.on('adapt-to-theme-change', () => {
                void this.loadFile().catch(console.error);
            }));
        }
    }

    shouldUpdateOnModify() {
        return typeof this.annotationId === 'string';
    }

    async loadFile() {
        const dataUrl: string = await PDFCroppedEmbed.limit(this.computeDataUrl.bind(this) as CroppedEmbedRenderCallback);

        await new Promise<void>((resolve, reject) => {
            this.containerEl.empty();
            this.containerEl.createEl('img', { attr: { src: dataUrl } }, (imgEl) => {
                imgEl.addEventListener('load', () => resolve());
                imgEl.addEventListener('error', () => reject(new Error('Failed to load cropped PDF embed image.')));

                const width = this.containerEl.getAttribute('width');
                const height = this.containerEl.getAttribute('height');
                if (width) imgEl.setAttribute('width', width);
                if (height) imgEl.setAttribute('height', height);
            });
            window.setTimeout(() => reject(new Error('Timed out loading cropped PDF embed image.')), 5000);
        });
    }

    async computeDataUrl(): Promise<string> {
        const doc = await this.lib.loadPDFDocument(this.file);
        const page = await doc.getPage(this.pageNumber);

        if (this.annotationId) {
            const annotations = await (page as CroppedEmbedAnnotationPage).getAnnotations();
            const annotation = annotations.find((annot) => annot.id === this.annotationId);
            if (annotation && Array.isArray(annotation.rect)) {
                this.rect = (window.pdfjsLib.Util.normalizeRect as NormalizePDFRect)(annotation.rect);
            }
        }

        const dataUrl = await this.lib.pdfPageToImageDataUrl(page, {
            type: 'image/png',
            cropRect: this.rect,
            renderParams: this.lib.getOptionalRenderParameters(),
        });

        await doc.destroy();

        return dataUrl;
    }
}
