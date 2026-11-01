import {
	ItemView,
	Notice,
	Platform,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import type {
	PDFDocumentProxy,
	PDFPageProxy,
	RenderTask,
} from 'pdfjs-dist';

import type PDFPlus from 'main';
import type { PDFView } from 'typings';
import {
	ColumnAwareMode,
	ColumnAwareRegion,
	PdfTextGeometryItem,
	detectColumnAwareRegions,
} from 'lib/column-aware-layout';


export const COLUMN_AWARE_READING_VIEW_TYPE = 'pdf-scholia-column-aware-reading';

type OriginalViewerChild = NonNullable<PDFView['viewer']['child']>;
type OriginalPdfDestination = Parameters<OriginalViewerChild['pdfViewer']['pdfLinkService']['goToDestination']>[0];

interface ColumnAwareReadingState {
	file?: string;
	mode?: ColumnAwareMode;
	swapColumns?: boolean;
}

interface PdfLinkAnnotation {
	subtype?: unknown;
	rect?: unknown;
	quadPoints?: unknown;
	url?: unknown;
	unsafeUrl?: unknown;
	dest?: unknown;
}

interface ViewportBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

interface PageRenderSource {
	canvas: HTMLCanvasElement;
	baseViewport: ReturnType<PDFPageProxy['getViewport']>;
	viewport: ReturnType<PDFPageProxy['getViewport']>;
}

type ObsidianOwnerWindow = Window & {
	createEl(tag: 'canvas'): HTMLCanvasElement;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColumnAwareMode(value: unknown): value is ColumnAwareMode {
	return value === 'auto' || value === 'one-column' || value === 'two-column';
}

function isPdfTextGeometryItem(value: unknown): value is PdfTextGeometryItem {
	if (!isRecord(value)) return false;
	return typeof value.str === 'string'
		&& typeof value.width === 'number'
		&& Number.isFinite(value.width)
		&& typeof value.height === 'number'
		&& Number.isFinite(value.height)
		&& Array.isArray(value.transform)
		&& value.transform.length >= 6
		&& value.transform.slice(0, 6).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function normalizeViewportRectangle(rect: unknown): ViewportBox | null {
	if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every((value) => typeof value === 'number' && Number.isFinite(value))) {
		return null;
	}
	const [firstX, firstY, secondX, secondY] = rect as number[];
	const left = Math.min(firstX, secondX);
	const right = Math.max(firstX, secondX);
	const top = Math.min(firstY, secondY);
	const bottom = Math.max(firstY, secondY);
	if (right <= left || bottom <= top) return null;
	return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function rectanglesIntersect(left: ViewportBox, right: ViewportBox): boolean {
	return Math.min(left.right, right.right) > Math.max(left.left, right.left)
		&& Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
}

function numericRect(value: unknown): [number, number, number, number] | null {
	if (!Array.isArray(value) || value.length < 4) return null;
	const numbers = value.slice(0, 4);
	if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
	return numbers as [number, number, number, number];
}

function numericArrayLikeRect(value: unknown): [number, number, number, number] | null {
	if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
	const entries = Array.from(value as ArrayLike<unknown>).slice(0, 4);
	if (entries.length < 4 || !entries.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
	return entries as [number, number, number, number];
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function annotationRectangles(annotation: PdfLinkAnnotation): [number, number, number, number][] {
	const quadPoints = annotation.quadPoints;
	const rectangles: [number, number, number, number][] = [];
	if (quadPoints instanceof Float32Array && quadPoints.length % 8 === 0) {
		for (let index = 0; index < quadPoints.length; index += 8) {
			const xs = [quadPoints[index], quadPoints[index + 2], quadPoints[index + 4], quadPoints[index + 6]];
			const ys = [quadPoints[index + 1], quadPoints[index + 3], quadPoints[index + 5], quadPoints[index + 7]];
			if (![...xs, ...ys].every(Number.isFinite)) continue;
			rectangles.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
		}
	}
	if (rectangles.length) return rectangles;
	const rect = numericRect(annotation.rect);
	return rect ? [rect] : [];
}

function safeExternalUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value);
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

function annotationLinkLabel(annotation: PdfLinkAnnotation): string {
	if (safeExternalUrl(annotation.url) ?? safeExternalUrl(annotation.unsafeUrl)) {
		return 'Open external PDF link';
	}
	if (typeof annotation.dest === 'string' && annotation.dest) {
		return `Open PDF destination ${annotation.dest} in original document`;
	}
	return 'Open PDF link in original document';
}

function regionLabel(region: ColumnAwareRegion): string {
	if (region.kind === 'left-column') return 'left column';
	if (region.kind === 'right-column') return 'right column';
	return 'full width';
}

export class ColumnAwareReadingView extends ItemView {
	navigation = true;
	private plugin: PDFPlus;
	private filePath = '';
	private sourceFile: TFile | null = null;
	private preferredOriginalLeaf: WorkspaceLeaf | null = null;
	private document: PDFDocumentProxy | null = null;
	private mode: ColumnAwareMode = 'auto';
	private swapColumns = false;
	private opened = false;
	private generation = 0;
	private observer: IntersectionObserver | null = null;
	private activeRenderTasks = new Set<RenderTask>();
	private pageSections = new Map<number, HTMLElement>();
	private pagesInFlight = new Set<number>();
	private pagesQueued = new Set<number>();
	private pagesRendered = new Set<number>();
	private pageQueue: number[] = [];
	private activePageJobs = 0;
	private readonly maximumConcurrentPages = Platform.isMobile ? 1 : 2;
	private readerEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PDFPlus) {
		super(leaf);
		this.plugin = plugin;
	}

	setPreferredOriginalLeaf(leaf: WorkspaceLeaf | null): void {
		this.preferredOriginalLeaf = leaf;
	}

	getViewType(): string {
		return COLUMN_AWARE_READING_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.sourceFile ? `${this.sourceFile.basename} — column-aware reading` : 'Column-aware reading';
	}

	getIcon(): string {
		return 'columns-2';
	}

	getState(): Record<string, unknown> {
		return {
			file: this.sourceFile?.path ?? this.filePath,
			mode: this.mode,
			swapColumns: this.swapColumns,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const record = isRecord(state) ? state as ColumnAwareReadingState : {};
		this.filePath = typeof record.file === 'string' ? record.file : '';
		this.mode = isColumnAwareMode(record.mode) ? record.mode : 'auto';
		this.swapColumns = record.swapColumns === true;
		if (this.opened) await this.loadSource();
	}

	async onOpen(): Promise<void> {
		this.opened = true;
		await this.loadSource();
	}

	async onClose(): Promise<void> {
		this.opened = false;
		this.generation++;
		this.cancelRendering();
		await this.destroyDocument();
		this.contentEl.empty();
	}

	private async loadSource(): Promise<void> {
		const generation = ++this.generation;
		this.cancelRendering();
		await this.destroyDocument();
		this.sourceFile = null;
		this.renderShell();

		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (!(file instanceof TFile) || file.extension !== 'pdf') {
			this.renderError('Choose a PDF and run “Open column-aware reading mode” again.');
			return;
		}
		this.sourceFile = file;
		this.renderShell();
		this.setStatus(`Loading ${file.name}…`);
		try {
			const document = await this.plugin.lib.loadPDFDocument(file);
			if (generation !== this.generation) {
				await document.destroy();
				return;
			}
			this.document = document;
			this.createPagePlaceholders(document.numPages);
			this.setStatus(`${document.numPages} pages · read-only projection · pages render as you scroll`);
		} catch (error) {
			console.error(`${this.plugin.manifest.name}: Could not open column-aware reading mode.`, error);
			this.renderError('This PDF could not be rendered in column-aware mode. The original PDF was not changed.');
		}
	}

	private renderShell(): void {
		this.contentEl.empty();
		this.contentEl.addClass('scholia-column-aware-view');
		const toolbar = this.contentEl.createDiv('scholia-column-toolbar');
		const title = toolbar.createDiv('scholia-column-title');
		setIcon(title.createSpan('scholia-column-title-icon'), 'columns-2');
		title.createSpan({
			text: this.sourceFile?.basename ?? this.filePath.split('/').pop()?.replace(/\.pdf$/i, '') ?? 'Column-aware reading',
			cls: 'scholia-column-title-text',
		});

		const controls = toolbar.createDiv('scholia-column-controls');
		const modeLabel = controls.createEl('label', { cls: 'scholia-column-mode' });
		modeLabel.createSpan({ text: 'Layout' });
		const select = modeLabel.createEl('select', { attr: { 'aria-label': 'Column layout mode' } });
		for (const [value, label] of [
			['auto', 'Auto'],
			['one-column', 'Force one column'],
			['two-column', 'Force two columns'],
		] as const) {
			select.createEl('option', { value, text: label });
		}
		select.value = this.mode;
		select.addEventListener('change', () => {
			if (!isColumnAwareMode(select.value)) return;
			this.mode = select.value;
			this.resetPages();
			this.app.workspace.requestSaveLayout();
		});

		const swapButton = controls.createEl('button', {
			cls: 'scholia-column-control',
			attr: { type: 'button', 'aria-label': 'Swap column reading order' },
		});
		setIcon(swapButton.createSpan(), 'arrow-left-right');
		const swapText = swapButton.createSpan();
		const updateSwapText = () => swapText.setText(this.swapColumns ? 'Right → left' : 'Left → right');
		updateSwapText();
		swapButton.addEventListener('click', () => {
			this.swapColumns = !this.swapColumns;
			updateSwapText();
			this.resetPages();
			this.app.workspace.requestSaveLayout();
		});

		const originalButton = controls.createEl('button', {
			cls: 'scholia-column-control',
			attr: { type: 'button' },
		});
		setIcon(originalButton.createSpan(), 'file-search');
		originalButton.createSpan({ text: 'Show original' });
		originalButton.addEventListener('click', () => void this.openOriginal(`#page=${this.nearestVisiblePageNumber()}`));

		this.statusEl = this.contentEl.createDiv('scholia-column-status');
		this.readerEl = this.contentEl.createDiv('scholia-column-reader');
	}

	private createPagePlaceholders(pageCount: number): void {
		if (!this.readerEl) return;
		this.readerEl.empty();
		this.pageSections.clear();
		this.pagesInFlight.clear();
		this.pagesQueued.clear();
		this.pagesRendered.clear();
		this.observer?.disconnect();
		const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
		if (!('IntersectionObserver' in ownerWindow)) {
			for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
				const section = this.readerEl.createEl('section', { cls: 'scholia-column-page is-pending' });
				section.dataset.pageNumber = String(pageNumber);
				section.createDiv({ text: `Page ${pageNumber}`, cls: 'scholia-column-page-placeholder' });
				this.pageSections.set(pageNumber, section);
			}
			this.queuePage(1);
			return;
		}
		this.observer = new ownerWindow.IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
				if (Number.isInteger(pageNumber)) this.queuePage(pageNumber);
			}
		}, {
			root: this.readerEl,
			rootMargin: '900px 0px',
			threshold: 0.01,
		});

		for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
			const section = this.readerEl.createEl('section', { cls: 'scholia-column-page is-pending' });
			section.dataset.pageNumber = String(pageNumber);
			section.createDiv({ text: `Page ${pageNumber}`, cls: 'scholia-column-page-placeholder' });
			this.pageSections.set(pageNumber, section);
			this.observer.observe(section);
		}
	}

	private queuePage(pageNumber: number): void {
		if (this.pagesQueued.has(pageNumber)
			|| this.pagesInFlight.has(pageNumber)
			|| this.pagesRendered.has(pageNumber)) return;
		this.pagesQueued.add(pageNumber);
		this.pageQueue.push(pageNumber);
		const section = this.pageSections.get(pageNumber);
		if (section) this.observer?.unobserve(section);
		this.drainPageQueue();
	}

	private drainPageQueue(): void {
		while (this.opened
			&& this.activePageJobs < this.maximumConcurrentPages
			&& this.pageQueue.length > 0) {
			const pageNumber = this.pageQueue.shift();
			if (pageNumber === undefined) return;
			this.pagesQueued.delete(pageNumber);
			this.activePageJobs++;
			void this.renderPage(pageNumber).finally(() => {
				this.activePageJobs--;
				this.drainPageQueue();
			});
		}
	}

	private resetPages(): void {
		this.generation++;
		this.cancelRendering();
		if (this.document) this.createPagePlaceholders(this.document.numPages);
	}

	private async renderPage(pageNumber: number): Promise<void> {
		const document = this.document;
		const section = this.pageSections.get(pageNumber);
		if (!document || !section || this.pagesInFlight.has(pageNumber) || this.pagesRendered.has(pageNumber)) return;
		const generation = this.generation;
		this.pagesInFlight.add(pageNumber);
		section.removeClass('is-pending');
		section.addClass('is-rendering');
		section.empty();
		section.createDiv({ text: `Rendering page ${pageNumber}…`, cls: 'scholia-column-page-placeholder' });

		let sourceCanvas: HTMLCanvasElement | null = null;
		let page: PDFPageProxy | null = null;
		try {
			page = await document.getPage(pageNumber);
			const textContent = await page.getTextContent({ includeMarkedContent: false });
			if (generation !== this.generation) return;
			const view = page.view;
			if (view.length < 4 || !view.slice(0, 4).every((value) => Number.isFinite(value))) {
				throw new Error('PDF page has an invalid view box');
			}
			const textItems: PdfTextGeometryItem[] = textContent.items.flatMap((item) => (
				isPdfTextGeometryItem(item)
					? [{
						str: item.str,
						width: item.width,
						height: item.height,
						transform: item.transform,
						dir: typeof item.dir === 'string' ? item.dir : undefined,
						fontName: typeof item.fontName === 'string' ? item.fontName : undefined,
					}]
					: []
			));
			const spanningBands = this.mode === 'one-column'
				? []
				: await this.detectGraphicSpanningBands(page, textItems);
			if (generation !== this.generation) return;
			const regions = detectColumnAwareRegions({
				view: [view[0], view[1], view[2], view[3]],
				rotation: page.rotate,
				items: textItems,
				styles: textContent.styles,
				spanningBands,
			}, {
				mode: this.mode,
				swapColumns: this.swapColumns,
			});
			const annotations = await page.getAnnotations({ intent: 'display' }) as PdfLinkAnnotation[];
			if (generation !== this.generation) return;
			const source = await this.renderPageSource(page, regions, generation);
			sourceCanvas = source.canvas;
			if (generation !== this.generation) return;

			section.empty();
			const pageHeader = section.createDiv('scholia-column-page-header');
			pageHeader.createEl('h3', { text: `Page ${pageNumber}` });
			pageHeader.createSpan({
				text: regions.length === 1 && regions[0].kind === 'full-width'
					? 'full-page fallback'
					: regions.map((region) => regionLabel(region)).join(' → '),
			});
			const regionsEl = section.createDiv('scholia-column-regions');
			for (const region of regions) {
				if (generation !== this.generation) return;
				this.renderRegion(source, pageNumber, region, annotations, regionsEl);
			}
			section.removeClass('is-rendering');
			section.addClass('is-rendered');
			this.pagesRendered.add(pageNumber);
			this.setStatus(`${this.pagesRendered.size} of ${document.numPages} pages rendered · original PDF remains unchanged`);
		} catch (error) {
			if (generation !== this.generation || this.isRenderCancellation(error)) return;
			console.error(`${this.plugin.manifest.name}: Could not render page ${pageNumber} in column-aware mode.`, error);
			section.empty();
			section.removeClass('is-rendering');
			section.addClass('is-error');
			section.createDiv({ text: `Page ${pageNumber} could not be displayed.`, cls: 'scholia-column-page-placeholder' });
		} finally {
			if (sourceCanvas) {
				sourceCanvas.width = 0;
				sourceCanvas.height = 0;
			}
			page?.cleanup();
			if (generation === this.generation) this.pagesInFlight.delete(pageNumber);
		}
	}

	private async detectGraphicSpanningBands(
		page: PDFPageProxy,
		items: readonly PdfTextGeometryItem[],
	): Promise<readonly (readonly [bottom: number, top: number])[]> {
		if (page.rotate !== 0) return [];
		const [pageLeft, pageBottom, pageRight, pageTop] = page.view;
		const pageWidth = pageRight - pageLeft;
		const pageHeight = pageTop - pageBottom;
		if (!(pageWidth > 0 && pageHeight > 0)) return [];
		const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
		const constructPath = ownerWindow.pdfjsLib?.OPS.constructPath ?? window.pdfjsLib?.OPS.constructPath;
		if (typeof constructPath !== 'number') return [];
		const operatorList = await page.getOperatorList();
		const ruleCenters: number[] = [];
		for (let index = 0; index < operatorList.fnArray.length; index++) {
			if (operatorList.fnArray[index] !== constructPath) continue;
			const args: unknown = operatorList.argsArray[index];
			if (!Array.isArray(args) || args.length < 3) continue;
			const bounds = numericArrayLikeRect(args[2]);
			if (!bounds) continue;
			const [left, bottom, right, top] = bounds;
			if (right - left < pageWidth * 0.7
				|| top - bottom > Math.max(3, pageHeight * 0.006)
				|| top < pageBottom || bottom > pageTop) continue;
			ruleCenters.push((bottom + top) / 2);
		}
		const uniqueRules: number[] = [];
		for (const center of ruleCenters.sort((left, right) => right - left)) {
			if (!uniqueRules.some((existing) => Math.abs(existing - center) <= 1.5)) uniqueRules.push(center);
		}
		if (uniqueRules.length < 2) return [];

		const clusters: number[][] = [];
		for (const center of uniqueRules) {
			const current = clusters[clusters.length - 1];
			if (current && current[current.length - 1] - center <= pageHeight * 0.18) current.push(center);
			else clusters.push([center]);
		}
		const textBoxes = items
			.filter((item) => item.str.trim() && item.transform.length >= 6)
			.map((item) => ({
				bottom: item.transform[5],
				top: item.transform[5] + item.height,
				height: item.height,
			}));
		const captionAllowance = Math.max(18, median(textBoxes.map((item) => item.height)) * 3);
		const bands: Array<readonly [number, number]> = [];
		for (const cluster of clusters) {
			if (cluster.length < 2) continue;
			const topRule = Math.max(...cluster);
			const bottomRule = Math.min(...cluster);
			if (topRule - bottomRule < pageHeight * 0.015 || topRule - bottomRule > pageHeight * 0.35) continue;
			const tableText = textBoxes.filter((item) => (
				item.top >= bottomRule - 2 && item.bottom <= topRule + captionAllowance
			));
			const contentTop = Math.max(topRule, ...tableText.map((item) => item.top));
			const contentBottom = Math.min(bottomRule, ...tableText.map((item) => item.bottom));
			const nearestAbove = textBoxes
				.filter((item) => item.bottom > contentTop + 1)
				.reduce<number | null>((nearest, item) => nearest === null ? item.bottom : Math.min(nearest, item.bottom), null);
			const nearestBelow = textBoxes
				.filter((item) => item.top < contentBottom - 1)
				.reduce<number | null>((nearest, item) => nearest === null ? item.top : Math.max(nearest, item.top), null);
			const bandTop = Math.min(pageTop, nearestAbove === null ? contentTop + 2 : (contentTop + nearestAbove) / 2);
			const bandBottom = Math.max(pageBottom, nearestBelow === null ? contentBottom - 2 : (contentBottom + nearestBelow) / 2);
			if (bandTop - bandBottom > 1) bands.push([bandBottom, bandTop]);
		}
		return bands;
	}

	private async renderPageSource(
		page: PDFPageProxy,
		regions: ColumnAwareRegion[],
		generation: number,
	): Promise<PageRenderSource> {
		const ownerDocument = this.containerEl.ownerDocument;
		const ownerWindow = ownerDocument.defaultView ?? window;
		const baseViewport = page.getViewport({ scale: 1 });
		const pixelRatio = Math.min(ownerWindow.devicePixelRatio || 1, 2);
		const availableWidth = Math.max(300, Math.min(760, (this.readerEl?.clientWidth ?? 820) - 72));
		let desiredScale = 1;
		for (const region of regions) {
			const crop = normalizeViewportRectangle(baseViewport.convertToViewportRectangle(region.rect));
			if (!crop) continue;
			const cssWidth = Math.min(availableWidth, Math.max(300, crop.width * 3));
			desiredScale = Math.max(desiredScale, (cssWidth / crop.width) * pixelRatio);
		}
		const pagePixelsAtUnitScale = Math.max(1, baseViewport.width * baseViewport.height);
		const pixelBudgetScale = Math.sqrt(18_000_000 / pagePixelsAtUnitScale);
		const dimensionBudgetScale = 8192 / Math.max(baseViewport.width, baseViewport.height);
		const renderScale = Math.min(desiredScale, pixelBudgetScale, dimensionBudgetScale);
		const viewport = page.getViewport({ scale: renderScale });
		const canvas = (ownerDocument.win as ObsidianOwnerWindow).createEl('canvas');
		canvas.width = Math.max(1, Math.ceil(viewport.width));
		canvas.height = Math.max(1, Math.ceil(viewport.height));
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas rendering is unavailable');
		const renderTask = page.render({
			...this.plugin.lib.getOptionalRenderParameters(),
			canvas,
			canvasContext: context,
			viewport,
			intent: 'display',
		});
		this.activeRenderTasks.add(renderTask);
		try {
			await renderTask.promise;
		} finally {
			this.activeRenderTasks.delete(renderTask);
		}
		if (generation !== this.generation) {
			canvas.width = 0;
			canvas.height = 0;
		}
		return { canvas, baseViewport, viewport };
	}

	private renderRegion(
		source: PageRenderSource,
		pageNumber: number,
		region: ColumnAwareRegion,
		annotations: PdfLinkAnnotation[],
		parent: HTMLElement,
	): void {
		const crop = normalizeViewportRectangle(source.baseViewport.convertToViewportRectangle(region.rect));
		if (!crop) return;

		const card = parent.createEl('article', { cls: `scholia-column-region is-${region.kind}` });
		const header = card.createDiv('scholia-column-region-header');
		header.createSpan({ text: regionLabel(region) });
		const originalButton = header.createEl('button', {
			text: 'Annotate in original',
			attr: { type: 'button' },
		});
		originalButton.addEventListener('click', () => {
			void this.openOriginal(this.regionSubpath(pageNumber, region.rect));
		});

		const frame = card.createDiv('scholia-column-canvas-frame');
		const availableWidth = Math.max(300, Math.min(760, (this.readerEl?.clientWidth ?? 820) - 72));
		const cssWidth = Math.min(availableWidth, Math.max(300, crop.width * 3));
		const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
		const pixelRatio = Math.min(ownerWindow.devicePixelRatio || 1, 2);
		const scaledCrop = normalizeViewportRectangle(source.viewport.convertToViewportRectangle(region.rect));
		if (!scaledCrop) return;

		const canvas = frame.createEl('canvas', {
			attr: {
				'aria-label': `Page ${pageNumber}, ${regionLabel(region)}`,
			},
		});
		canvas.width = Math.max(1, Math.ceil(cssWidth * pixelRatio));
		canvas.height = Math.max(1, Math.ceil(canvas.width * crop.height / crop.width));
		frame.style.width = `${cssWidth}px`;
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas rendering is unavailable');
		context.drawImage(
			source.canvas,
			scaledCrop.left,
			scaledCrop.top,
			scaledCrop.width,
			scaledCrop.height,
			0,
			0,
			canvas.width,
			canvas.height,
		);
		this.renderLinkOverlays(frame, crop, source.baseViewport, annotations);
	}

	private renderLinkOverlays(
		frame: HTMLElement,
		crop: ViewportBox,
		viewport: ReturnType<PDFPageProxy['getViewport']>,
		annotations: PdfLinkAnnotation[],
	): void {
		const overlay = frame.createDiv('scholia-column-link-overlay');
		for (const annotation of annotations) {
			if (annotation.subtype !== 'Link') continue;
			const linkLabel = annotationLinkLabel(annotation);
			for (const rect of annotationRectangles(annotation)) {
				const annotationBox = normalizeViewportRectangle(viewport.convertToViewportRectangle(rect));
				if (!annotationBox || !rectanglesIntersect(crop, annotationBox)) continue;
				const centerX = (annotationBox.left + annotationBox.right) / 2;
				const centerY = (annotationBox.top + annotationBox.bottom) / 2;
				if (centerX < crop.left || centerX >= crop.right || centerY < crop.top || centerY >= crop.bottom) continue;
				const left = Math.max(crop.left, annotationBox.left);
				const right = Math.min(crop.right, annotationBox.right);
				const top = Math.max(crop.top, annotationBox.top);
				const bottom = Math.min(crop.bottom, annotationBox.bottom);
				const link = overlay.createEl('button', {
					cls: 'scholia-column-link-zone',
					attr: {
						type: 'button',
						'aria-label': linkLabel,
						title: linkLabel,
					},
				});
				link.style.left = `${((left - crop.left) / crop.width) * 100}%`;
				link.style.top = `${((top - crop.top) / crop.height) * 100}%`;
				link.style.width = `${Math.max(0.8, ((right - left) / crop.width) * 100)}%`;
				link.style.height = `${Math.max(0.7, ((bottom - top) / crop.height) * 100)}%`;
				link.addEventListener('click', (event) => {
					event.stopPropagation();
					void this.openPdfAnnotationLink(annotation);
				});
			}
		}
	}

	private async openPdfAnnotationLink(annotation: PdfLinkAnnotation): Promise<void> {
		const externalUrl = safeExternalUrl(annotation.url) ?? safeExternalUrl(annotation.unsafeUrl);
		if (externalUrl) {
			(this.containerEl.ownerDocument.defaultView ?? window).open(externalUrl, '_blank', 'noopener');
			return;
		}
		if (!(typeof annotation.dest === 'string' && annotation.dest) && !Array.isArray(annotation.dest)) return;
		try {
			const child = await this.getOriginalViewerChild();
			if (!child) throw new Error('Original PDF viewer did not become ready');
			await child.pdfViewer.pdfLinkService.goToDestination(annotation.dest as OriginalPdfDestination);
		} catch (error) {
			console.error(`${this.plugin.manifest.name}: Could not follow a PDF link in the original viewer.`, error);
			let destination: unknown = annotation.dest;
			if (typeof destination === 'string') {
				destination = await this.document?.getDestination(destination) ?? null;
			}
			const subpath = Array.isArray(destination) ? await this.destinationArraySubpath(destination) : null;
			if (subpath) await this.openOriginal(subpath);
			else new Notice(`${this.plugin.manifest.name}: This PDF link could not be opened.`);
		}
	}

	private async destinationArraySubpath(destination: unknown[]): Promise<string | null> {
		const document = this.document;
		if (!document || destination.length < 2) return null;
		let pageIndex: number;
		try {
			pageIndex = typeof destination[0] === 'number'
				? destination[0]
				: await document.getPageIndex(destination[0] as never);
		} catch {
			return null;
		}
		const pageNumber = pageIndex + 1;
		const destinationType = isRecord(destination[1]) && typeof destination[1].name === 'string'
			? destination[1].name
			: '';
		if (destinationType === 'FitR') {
			const rect = numericRect(destination.slice(2, 6));
			if (rect) return this.regionSubpath(pageNumber, rect);
		}
		return `#page=${pageNumber}`;
	}

	private regionSubpath(pageNumber: number, rect: readonly number[]): string {
		return `#page=${pageNumber}&rect=${rect.map((value) => Math.round(value * 100) / 100).join(',')}`;
	}

	private nearestVisiblePageNumber(): number {
		const reader = this.readerEl;
		if (!reader) return 1;
		const readerTop = reader.getBoundingClientRect().top;
		let nearestPage = 1;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const [pageNumber, section] of this.pageSections) {
			const rect = section.getBoundingClientRect();
			const distance = rect.bottom >= readerTop
				? Math.abs(rect.top - readerTop)
				: readerTop - rect.bottom;
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestPage = pageNumber;
			}
		}
		return nearestPage;
	}

	private originalLeafIsUsable(leaf: WorkspaceLeaf | null, file: TFile): leaf is WorkspaceLeaf {
		return leaf !== null
			&& leaf.containerEl.isConnected
			&& leaf.view.getViewType() === 'pdf'
			&& this.plugin.lib.workspace.getFilePathFromView(leaf.view) === file.path;
	}

	private async getOriginalViewerChild(): Promise<OriginalViewerChild | null> {
		const file = this.sourceFile;
		if (!file) return null;
		let leaf = this.originalLeafIsUsable(this.preferredOriginalLeaf, file)
			? this.preferredOriginalLeaf
			: this.plugin.lib.workspace.getExistingLeafForPDFFile(file);
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('split', 'vertical');
			await this.plugin.lib.workspace.openPDFLinkTextInLeaf(leaf, file.path, '', { active: true });
		} else {
			await this.app.workspace.revealLeaf(leaf);
		}
		this.preferredOriginalLeaf = leaf;
		await leaf.loadIfDeferred();
		if (!this.plugin.lib.isPDFView(leaf.view)) return null;
		const viewer = leaf.view.viewer;
		if (viewer.child) return viewer.child;
		return new Promise((resolve) => {
			const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
			let settled = false;
			const finish = (child: OriginalViewerChild | null) => {
				if (settled) return;
				settled = true;
				ownerWindow.clearTimeout(timeout);
				resolve(child);
			};
			const timeout = ownerWindow.setTimeout(() => finish(null), 5000);
			viewer.then((child) => finish(child));
		});
	}

	private async openOriginal(subpath: string): Promise<void> {
		const file = this.sourceFile;
		if (!file) return;
		const linktext = file.path + subpath;
		const existing = this.plugin.lib.workspace.openPDFLinkTextInExistingLeafForTargetPDF(
			linktext,
			'',
			{ active: true },
			file,
			this.originalLeafIsUsable(this.preferredOriginalLeaf, file) ? this.preferredOriginalLeaf : undefined,
		);
		if (existing.exists) {
			await existing.promise;
			return;
		}
		const leaf = this.app.workspace.getLeaf('split', 'vertical');
		await this.plugin.lib.workspace.openPDFLinkTextInLeaf(leaf, linktext, '', { active: true });
		this.preferredOriginalLeaf = leaf;
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	private renderError(message: string): void {
		this.setStatus('Column-aware reading is unavailable for this file.');
		this.readerEl?.empty();
		const error = this.readerEl?.createDiv('scholia-column-error');
		if (!error) return;
		setIcon(error.createDiv(), 'file-warning');
		error?.createEl('h3', { text: 'Could not display this PDF' });
		error?.createEl('p', { text: message });
	}

	private cancelRendering(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.pageQueue = [];
		this.pagesQueued.clear();
		for (const task of this.activeRenderTasks) task.cancel();
		this.activeRenderTasks.clear();
		this.pagesInFlight.clear();
	}

	private async destroyDocument(): Promise<void> {
		const document = this.document;
		this.document = null;
		if (document) await document.destroy().catch(() => undefined);
	}

	private isRenderCancellation(error: unknown): boolean {
		return error instanceof Error && error.name === 'RenderingCancelledException';
	}
}

export async function openColumnAwareReading(plugin: PDFPlus, file: TFile): Promise<void> {
	const mostRecentLeaf = plugin.app.workspace.getMostRecentLeaf();
	const originalLeaf = mostRecentLeaf?.view.getViewType() === 'pdf'
		&& plugin.lib.workspace.getFilePathFromView(mostRecentLeaf.view) === file.path
		? mostRecentLeaf
		: plugin.lib.workspace.getExistingLeafForPDFFile(file);
	let leaf = plugin.app.workspace.getLeavesOfType(COLUMN_AWARE_READING_VIEW_TYPE)
		.find((candidate) => candidate.view.getState().file === file.path);
	if (!leaf) leaf = plugin.app.workspace.getLeaf('split', 'vertical');
	await leaf.setViewState({
		type: COLUMN_AWARE_READING_VIEW_TYPE,
		state: { file: file.path, mode: 'auto', swapColumns: false },
		active: true,
	});
	if (leaf.view instanceof ColumnAwareReadingView) leaf.view.setPreferredOriginalLeaf(originalLeaf);
	await plugin.app.workspace.revealLeaf(leaf);
}

export function registerColumnAwareReading(plugin: PDFPlus): void {
	plugin.registerView(
		COLUMN_AWARE_READING_VIEW_TYPE,
		(leaf) => new ColumnAwareReadingView(leaf, plugin),
	);
	plugin.addCommand({
		id: 'open-column-aware-reading',
		name: 'Open column-aware reading mode',
		checkCallback: (checking) => {
			const file = plugin.lib.getPDFViewerChild(true)?.file ?? plugin.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.extension !== 'pdf') return false;
			if (!checking) void openColumnAwareReading(plugin, file).catch((error) => {
				console.error(`${plugin.manifest.name}: Could not open column-aware reading mode.`, error);
				new Notice(`${plugin.manifest.name}: Column-aware reading mode could not be opened.`);
			});
			return true;
		},
	});
	plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
		if (!(file instanceof TFile) || file.extension !== 'pdf') return;
		menu.addItem((item) => item
			.setTitle('Open in column-aware reading mode')
			.setIcon('columns-2')
			.onClick(() => void openColumnAwareReading(plugin, file)));
	}));
}
