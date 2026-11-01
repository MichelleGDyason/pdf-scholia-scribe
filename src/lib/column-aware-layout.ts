export type ColumnAwareMode = 'auto' | 'one-column' | 'two-column';
export type ColumnAwareLayoutMode = ColumnAwareMode;
export type ColumnAwareResolvedMode = Exclude<ColumnAwareLayoutMode, 'auto'>;
export type ColumnAwareColumn = 'left' | 'right';

export interface PdfTextGeometryItem {
	str: string;
	width: number;
	height: number;
	transform: readonly number[];
	/** PDF.js TextItem direction. `rtl` and `ttb` require native reading order. */
	dir?: string;
	/** PDF.js TextItem font-name key, used to resolve TextContent.styles. */
	fontName?: string;
	/** Resolved PDF.js TextStyle.vertical value, when the caller already has it. */
	vertical?: boolean;
}

export interface PdfTextGeometryStyle {
	vertical?: boolean;
}

export interface PdfPageGeometry {
	view: readonly [number, number, number, number];
	rotation: number;
	items: readonly PdfTextGeometryItem[];
	/** Optional PDF.js TextContent.styles, keyed by TextItem.fontName. */
	styles?: Readonly<Record<string, PdfTextGeometryStyle | undefined>>;
	/** Trusted full-width bands discovered from non-text page geometry. */
	spanningBands?: readonly (readonly [bottom: number, top: number])[];
}

/** Stable view-facing region contract, in PDF user-space coordinates. */
export interface ColumnAwareRegion {
	kind: 'full-width' | 'left-column' | 'right-column';
	rect: [left: number, bottom: number, right: number, top: number];
	confidence: number;
}

export interface ColumnAwarePageDimensions {
	width: number;
	height: number;
	/** Unrotated pages are currently the only safe automatic input. */
	rotation?: number;
}

/**
 * The geometry shared by PDF.js TextItem values and lightweight test fixtures.
 *
 * PDF.js callers normally provide width, height, and transform. Callers that
 * already converted viewport geometry can instead provide x and y.
 */
export interface ColumnAwareTextBox {
	str?: string;
	width?: number;
	height?: number;
	transform?: readonly number[];
	x?: number;
	y?: number;
	/** PDF.js TextItem direction, normally `ltr`, `rtl`, or `ttb`. */
	dir?: string;
	/** PDF.js TextItem font-name key; retained for caller-side style resolution. */
	fontName?: string;
	/** Resolved PDF.js TextStyle.vertical value. */
	vertical?: boolean;
}

export interface ColumnAwareLayoutOptions {
	mode?: ColumnAwareLayoutMode;
	/** Read the right column before the left column. Full-width bands are unaffected. */
	swapColumns?: boolean;
	/** Minimum automatic two-column confidence. Defaults to 0.62. */
	minimumConfidence?: number;
	/** Page-relative full-width bands discovered from non-text page geometry. */
	spanningBands?: readonly ColumnAwareSpanningBand[];
}

export interface ColumnAwareSpanningBand {
	bottom: number;
	top: number;
}

export interface ColumnAwareRectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ColumnAwareLayoutRegion {
	kind: 'full-width' | 'column';
	column?: ColumnAwareColumn;
	rect: ColumnAwareRectangle;
	/** Indices into the original text-box array, assigned to exactly one region. */
	sourceItemIndices: number[];
}

export type ColumnAwareLayoutDecision =
	| 'detected-one-column'
	| 'detected-two-column'
	| 'forced-one-column'
	| 'forced-two-column'
	| 'fallback';

export type ColumnAwareFallbackReason =
	| 'invalid-page'
	| 'rotated-page'
	| 'unsupported-text-direction'
	| 'unsupported-text-geometry'
	| 'insufficient-text'
	| 'low-confidence';

export interface ColumnAwareLayoutResult {
	page: ColumnAwareRectangle;
	requestedMode: ColumnAwareLayoutMode;
	resolvedMode: ColumnAwareResolvedMode;
	decision: ColumnAwareLayoutDecision;
	confidence: number;
	splitX?: number;
	fallbackReason?: ColumnAwareFallbackReason;
	regions: ColumnAwareLayoutRegion[];
}

interface NormalizedTextBox {
	sourceIndex: number;
	text: string;
	left: number;
	right: number;
	bottom: number;
	top: number;
	width: number;
	height: number;
}

interface SplitEvaluation {
	splitX: number;
	score: number;
	leftCount: number;
	rightCount: number;
	crossingCount: number;
	wideCount: number;
	balance: number;
	separation: number;
}

interface VerticalBand {
	bottom: number;
	top: number;
}

const DEFAULT_MINIMUM_CONFIDENCE = 0.62;
const MINIMUM_AUTOMATIC_TEXT_ITEMS = 5;
const MINIMUM_UNSAFE_DIRECTION_CHARACTERS = 12;
const SINGLE_ITEM_UNSAFE_DIRECTION_CHARACTERS = 24;
const GEOMETRY_EPSILON = 0.001;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(maximum, Math.max(minimum, value));
}

function meaningfulTextIndices(items: readonly ColumnAwareTextBox[]) {
	const indices: number[] = [];
	items.forEach((item, index) => {
		if ((item.str ?? '').trim()) indices.push(index);
	});
	return indices;
}

function compactTextLength(text: string) {
	return text.replace(/\s/g, '').length;
}

/**
 * Ignore isolated direction markers and very short foreign-language tokens,
 * but keep a meaningful RTL or vertical run in the native PDF reader. The
 * companion view currently has no bidi/vertical ordering model of its own.
 */
function hasMeaningfulUnsupportedDirection(items: readonly ColumnAwareTextBox[]) {
	let totalCharacters = 0;
	let unsupportedCharacters = 0;
	let unsupportedItems = 0;

	for (const item of items) {
		const text = (item.str ?? '').trim();
		if (!text) continue;
		const characterCount = compactTextLength(text);
		totalCharacters += characterCount;
		const direction = item.dir?.trim().toLowerCase();
		if (item.vertical !== true && direction !== 'rtl' && direction !== 'ttb') continue;
		unsupportedCharacters += characterCount;
		unsupportedItems++;
	}

	if (unsupportedCharacters >= SINGLE_ITEM_UNSAFE_DIRECTION_CHARACTERS) return true;
	if (unsupportedCharacters < MINIMUM_UNSAFE_DIRECTION_CHARACTERS) return false;
	return unsupportedItems >= 2
		|| (totalCharacters > 0 && unsupportedCharacters / totalCharacters >= 0.2);
}

function fullPageRegion(width: number, height: number, sourceItemIndices: number[]): ColumnAwareLayoutRegion {
	return {
		kind: 'full-width',
		rect: { x: 0, y: 0, width, height },
		sourceItemIndices,
	};
}

function fallbackResult(
	requestedMode: ColumnAwareLayoutMode,
	width: number,
	height: number,
	sourceItemIndices: number[],
	reason: ColumnAwareFallbackReason,
	confidence = 0,
): ColumnAwareLayoutResult {
	return {
		page: { x: 0, y: 0, width, height },
		requestedMode,
		resolvedMode: 'one-column',
		decision: 'fallback',
		confidence: clamp(confidence, 0, 1),
		fallbackReason: reason,
		regions: [fullPageRegion(width, height, sourceItemIndices)],
	};
}

function isUnsupportedTransform(transform: readonly number[]) {
	if (transform.length < 6 || transform.slice(0, 6).some((value) => !isFiniteNumber(value))) return true;
	const [a, b, c, d] = transform;
	const diagonalMagnitude = Math.abs(a) + Math.abs(d);
	const offAxisMagnitude = Math.abs(b) + Math.abs(c);
	return diagonalMagnitude <= GEOMETRY_EPSILON
		|| offAxisMagnitude > Math.max(GEOMETRY_EPSILON, diagonalMagnitude * 0.08);
}

function normalizeTextBox(
	item: ColumnAwareTextBox,
	sourceIndex: number,
	pageWidth: number,
	pageHeight: number,
): NormalizedTextBox | null {
	const text = (item.str ?? '').trim();
	if (!text) return null;

	let x: number | undefined;
	let y: number | undefined;
	let height = item.height;
	if (item.transform) {
		if (isUnsupportedTransform(item.transform)) return null;
		x = item.transform[4];
		y = item.transform[5];
		if (!isFiniteNumber(height) || height <= 0) {
			height = Math.abs(item.transform[3]);
		}
	} else {
		x = item.x;
		y = item.y;
	}

	const width = item.width;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)
		|| !isFiniteNumber(width) || !isFiniteNumber(height)
		|| width <= 0 || height <= 0) return null;

	const rawRight = x + width;
	const rawTop = y + height;
	if (rawRight <= 0 || x >= pageWidth || rawTop <= 0 || y >= pageHeight) return null;

	const left = clamp(x, 0, pageWidth);
	const right = clamp(rawRight, 0, pageWidth);
	const bottom = clamp(y, 0, pageHeight);
	const top = clamp(rawTop, 0, pageHeight);
	if (right - left <= GEOMETRY_EPSILON || top - bottom <= GEOMETRY_EPSILON) return null;

	return {
		sourceIndex,
		text,
		left,
		right,
		bottom,
		top,
		width: right - left,
		height: top - bottom,
	};
}

function itemWeight(item: NormalizedTextBox) {
	return clamp(item.text.length / 24, 1, 4);
}

function verticalOverlapScore(left: NormalizedTextBox[], right: NormalizedTextBox[]) {
	if (!left.length || !right.length) return 0;
	const leftBottom = Math.min(...left.map((item) => item.bottom));
	const leftTop = Math.max(...left.map((item) => item.top));
	const rightBottom = Math.min(...right.map((item) => item.bottom));
	const rightTop = Math.max(...right.map((item) => item.top));
	const overlap = Math.max(0, Math.min(leftTop, rightTop) - Math.max(leftBottom, rightBottom));
	const smallerSpan = Math.min(leftTop - leftBottom, rightTop - rightBottom);
	return smallerSpan > GEOMETRY_EPSILON ? clamp(overlap / smallerSpan, 0, 1) : 0;
}

function evaluateSplitAt(
	items: readonly NormalizedTextBox[],
	pageWidth: number,
	splitX: number,
): SplitEvaluation {
	const gutterHalfWidth = Math.max(2, pageWidth * 0.008);
	const left: NormalizedTextBox[] = [];
	const right: NormalizedTextBox[] = [];
	let leftWeight = 0;
	let rightWeight = 0;
	let crossingWeight = 0;
	let crossingCount = 0;
	let wideCount = 0;

	for (const item of items) {
		const spansCandidate = item.left < splitX - gutterHalfWidth
			&& item.right > splitX + gutterHalfWidth;
		if (spansCandidate && item.width >= pageWidth * 0.52) {
			wideCount++;
			continue;
		}

		const weight = itemWeight(item);
		if (item.right <= splitX - gutterHalfWidth) {
			left.push(item);
			leftWeight += weight;
		} else if (item.left >= splitX + gutterHalfWidth) {
			right.push(item);
			rightWeight += weight;
		} else {
			crossingCount++;
			crossingWeight += weight;
		}
	}

	const sideWeight = leftWeight + rightWeight;
	const balance = sideWeight > 0 ? 2 * Math.min(leftWeight, rightWeight) / sideWeight : 0;
	const separation = sideWeight + crossingWeight > 0
		? sideWeight / (sideWeight + crossingWeight)
		: 0;
	const support = Math.min(1, Math.min(left.length, right.length) / 4);
	const overlap = verticalOverlapScore(left, right);
	const score = separation
		* (0.3 + 0.7 * balance)
		* (0.4 + 0.6 * overlap)
		* support;

	return {
		splitX,
		score: clamp(score, 0, 1),
		leftCount: left.length,
		rightCount: right.length,
		crossingCount,
		wideCount,
		balance,
		separation,
	};
}

function findBestSplit(items: readonly NormalizedTextBox[], pageWidth: number) {
	let best: SplitEvaluation | null = null;
	for (let step = 0; step <= 40; step++) {
		const splitX = pageWidth * (0.3 + step * 0.01);
		const evaluation = evaluateSplitAt(items, pageWidth, splitX);
		const closerToCentre = Math.abs(evaluation.splitX - pageWidth / 2)
			< Math.abs((best?.splitX ?? 0) - pageWidth / 2);
		if (!best || evaluation.score > best.score + GEOMETRY_EPSILON
			|| (Math.abs(evaluation.score - best.score) <= GEOMETRY_EPSILON && closerToCentre)) {
			best = evaluation;
		}
	}
	return best as SplitEvaluation;
}

function looksClearlySingleColumn(
	items: readonly NormalizedTextBox[],
	pageWidth: number,
	bestSplit: SplitEvaluation,
) {
	const centralCrossingCount = items.filter((item) => item.left < pageWidth / 2 && item.right > pageWidth / 2).length;
	const broadCount = items.filter((item) => item.width >= pageWidth * 0.48).length;
	const singleColumnRatio = Math.max(centralCrossingCount, broadCount) / items.length;
	return singleColumnRatio >= 0.5
		|| bestSplit.balance < 0.25
		|| bestSplit.separation < 0.55;
}

function median(values: number[]) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function findSpanningBands(
	items: readonly NormalizedTextBox[],
	pageWidth: number,
	pageHeight: number,
	splitX: number,
	providedBands: readonly ColumnAwareSpanningBand[],
) {
	const gutterHalfWidth = Math.max(2, pageWidth * 0.008);
	const spanningItems = items.filter((item) => (
		item.left < splitX - gutterHalfWidth && item.right > splitX + gutterHalfWidth
	) || (
		item.width >= pageWidth * 0.55
		&& Math.abs((item.left + item.right) / 2 - splitX) <= pageWidth * 0.2
	));
	const verticalTolerance = Math.max(3, median(items.map((item) => item.height)) * 0.75);
	const rawBands: VerticalBand[] = [];
	for (const item of [...spanningItems].sort((a, b) => a.bottom - b.bottom)) {
		const previous = rawBands[rawBands.length - 1];
		if (previous && item.bottom <= previous.top + verticalTolerance) {
			previous.top = Math.max(previous.top, item.top);
		} else {
			rawBands.push({ bottom: item.bottom, top: item.top });
		}
	}

	// A table caption or broad header is often the only text box that crosses
	// the gutter. Pull one immediately adjacent row into the same raw band so
	// its left and right cells are rendered once, without recursively consuming
	// the ordinary columns below it.
	const adjacentRowTolerance = Math.max(24, median(items.map((item) => item.height)) * 2.5);
	for (const band of rawBands) {
		const originalBottom = band.bottom;
		const originalTop = band.top;
		for (const item of items) {
			const distance = item.bottom > originalTop
				? item.bottom - originalTop
				: originalBottom > item.top ? originalBottom - item.top : 0;
			if (distance <= adjacentRowTolerance) {
				band.bottom = Math.min(band.bottom, item.bottom);
				band.top = Math.max(band.top, item.top);
			}
		}
	}

	const expandedBands = rawBands.map((band) => {
		const nearestAbove = items
			.filter((item) => item.bottom >= band.top + GEOMETRY_EPSILON)
			.reduce<number | null>((nearest, item) => nearest === null
				? item.bottom
				: Math.min(nearest, item.bottom), null);
		const nearestBelow = items
			.filter((item) => item.top <= band.bottom - GEOMETRY_EPSILON)
			.reduce<number | null>((nearest, item) => nearest === null
				? item.top
				: Math.max(nearest, item.top), null);
		return {
			bottom: nearestBelow === null ? 0 : (nearestBelow + band.bottom) / 2,
			top: nearestAbove === null ? pageHeight : (band.top + nearestAbove) / 2,
		};
	});

	const validProvidedBands = providedBands
		.filter((band) => isFiniteNumber(band.bottom)
			&& isFiniteNumber(band.top)
			&& band.top - band.bottom > GEOMETRY_EPSILON)
		.map((band) => ({
			bottom: clamp(band.bottom, 0, pageHeight),
			top: clamp(band.top, 0, pageHeight),
		}))
		.filter((band) => band.top - band.bottom > GEOMETRY_EPSILON);
	const mergedBands: VerticalBand[] = [];
	for (const band of [...expandedBands, ...validProvidedBands].sort((a, b) => a.bottom - b.bottom)) {
		const previous = mergedBands[mergedBands.length - 1];
		if (previous && band.bottom <= previous.top + GEOMETRY_EPSILON) {
			previous.top = Math.max(previous.top, band.top);
		} else {
			mergedBands.push({
				bottom: clamp(band.bottom, 0, pageHeight),
				top: clamp(band.top, 0, pageHeight),
			});
		}
	}
	return mergedBands;
}

function createTwoColumnRegions(
	items: readonly NormalizedTextBox[],
	pageWidth: number,
	pageHeight: number,
	splitX: number,
	swapColumns: boolean,
	providedBands: readonly ColumnAwareSpanningBand[],
) {
	const spanningBands = findSpanningBands(items, pageWidth, pageHeight, splitX, providedBands)
		.sort((a, b) => b.top - a.top);
	const regionShells: Array<Omit<ColumnAwareLayoutRegion, 'sourceItemIndices'>> = [];
	const columnOrder: ColumnAwareColumn[] = swapColumns ? ['right', 'left'] : ['left', 'right'];

	const addColumnSegment = (bottom: number, top: number) => {
		if (top - bottom <= GEOMETRY_EPSILON) return;
		for (const column of columnOrder) {
			regionShells.push({
				kind: 'column',
				column,
				rect: column === 'left'
					? { x: 0, y: bottom, width: splitX, height: top - bottom }
					: { x: splitX, y: bottom, width: pageWidth - splitX, height: top - bottom },
			});
		}
	};

	let cursorTop = pageHeight;
	for (const band of spanningBands) {
		addColumnSegment(band.top, cursorTop);
		if (band.top - band.bottom > GEOMETRY_EPSILON) {
			regionShells.push({
				kind: 'full-width',
				rect: { x: 0, y: band.bottom, width: pageWidth, height: band.top - band.bottom },
			});
		}
		cursorTop = band.bottom;
	}
	addColumnSegment(0, cursorTop);

	const regions: ColumnAwareLayoutRegion[] = regionShells.map((region) => ({
		...region,
		sourceItemIndices: [],
	}));
	for (const item of items) {
		const centreX = (item.left + item.right) / 2;
		const centreY = (item.bottom + item.top) / 2;
		const matchingRegion = regions.find((region) => {
			const regionTop = region.rect.y + region.rect.height;
			const inVerticalRange = centreY >= region.rect.y - GEOMETRY_EPSILON
				&& (centreY < regionTop - GEOMETRY_EPSILON
					|| Math.abs(regionTop - pageHeight) <= GEOMETRY_EPSILON);
			if (!inVerticalRange) return false;
			if (region.kind === 'full-width') return true;
			return region.column === (centreX < splitX ? 'left' : 'right');
		});
		matchingRegion?.sourceItemIndices.push(item.sourceIndex);
	}

	return regions;
}

/**
 * Build a conservative reading sequence without changing the source PDF.
 * Rectangles use PDF coordinates (origin at bottom-left) and are returned in
 * reading order (top-to-bottom, then the selected column order).
 */
export function layoutColumnAwarePage(
	page: ColumnAwarePageDimensions,
	textBoxes: readonly ColumnAwareTextBox[],
	options: ColumnAwareLayoutOptions = {},
): ColumnAwareLayoutResult {
	const requestedMode = options.mode ?? 'auto';
	const sourceItemIndices = meaningfulTextIndices(textBoxes);
	const validWidth = isFiniteNumber(page.width) && page.width > 0;
	const validHeight = isFiniteNumber(page.height) && page.height > 0;
	const pageWidth = validWidth ? page.width : 1;
	const pageHeight = validHeight ? page.height : 1;
	if (!validWidth || !validHeight) {
		return fallbackResult(requestedMode, pageWidth, pageHeight, sourceItemIndices, 'invalid-page');
	}

	if (requestedMode === 'one-column') {
		return {
			page: { x: 0, y: 0, width: pageWidth, height: pageHeight },
			requestedMode,
			resolvedMode: 'one-column',
			decision: 'forced-one-column',
			confidence: 1,
			regions: [fullPageRegion(pageWidth, pageHeight, sourceItemIndices)],
		};
	}

	if (hasMeaningfulUnsupportedDirection(textBoxes)) {
		return fallbackResult(
			requestedMode,
			pageWidth,
			pageHeight,
			sourceItemIndices,
			'unsupported-text-direction',
		);
	}

	const rotation = isFiniteNumber(page.rotation) ? ((page.rotation % 360) + 360) % 360 : 0;
	if (Math.min(rotation, 360 - rotation) > GEOMETRY_EPSILON) {
		return fallbackResult(requestedMode, pageWidth, pageHeight, sourceItemIndices, 'rotated-page');
	}

	const normalizedItems = textBoxes
		.map((item, index) => normalizeTextBox(item, index, pageWidth, pageHeight))
		.filter((item): item is NormalizedTextBox => item !== null);
	if (normalizedItems.length !== sourceItemIndices.length) {
		return fallbackResult(
			requestedMode,
			pageWidth,
			pageHeight,
			sourceItemIndices,
			'unsupported-text-geometry',
		);
	}

	if (requestedMode === 'auto' && normalizedItems.length < MINIMUM_AUTOMATIC_TEXT_ITEMS) {
		return fallbackResult(
			requestedMode,
			pageWidth,
			pageHeight,
			sourceItemIndices,
			'insufficient-text',
		);
	}

	const bestSplit = findBestSplit(normalizedItems, pageWidth);
	const minimumConfidence = isFiniteNumber(options.minimumConfidence)
		? clamp(options.minimumConfidence, 0, 1)
		: DEFAULT_MINIMUM_CONFIDENCE;
	if (requestedMode === 'auto' && bestSplit.score < minimumConfidence) {
		if (looksClearlySingleColumn(normalizedItems, pageWidth, bestSplit)) {
			return {
				page: { x: 0, y: 0, width: pageWidth, height: pageHeight },
				requestedMode,
				resolvedMode: 'one-column',
				decision: 'detected-one-column',
				confidence: clamp(1 - bestSplit.score, 0, 1),
				regions: [fullPageRegion(pageWidth, pageHeight, sourceItemIndices)],
			};
		}
		return fallbackResult(
			requestedMode,
			pageWidth,
			pageHeight,
			sourceItemIndices,
			'low-confidence',
			bestSplit.score,
		);
	}

	const splitX = bestSplit.score > 0 ? bestSplit.splitX : pageWidth / 2;
	return {
		page: { x: 0, y: 0, width: pageWidth, height: pageHeight },
		requestedMode,
		resolvedMode: 'two-column',
		decision: requestedMode === 'auto' ? 'detected-two-column' : 'forced-two-column',
		confidence: bestSplit.score,
		splitX,
		regions: createTwoColumnRegions(
			normalizedItems,
			pageWidth,
			pageHeight,
			splitX,
			options.swapColumns ?? false,
			options.spanningBands ?? [],
		),
	};
}

/**
 * Detect ordered crop regions for the companion reader.
 *
 * `view` and returned rectangles use the PDF page's native user-space. A
 * rotated page, invalid geometry, or an uncertain automatic decision yields a
 * single full-page region.
 */
export function detectColumnAwareRegions(
	page: PdfPageGeometry,
	options: { mode: ColumnAwareMode; swapColumns?: boolean },
): ColumnAwareRegion[] {
	const [pageLeft, pageBottom, pageRight, pageTop] = page.view;
	const pageWidth = pageRight - pageLeft;
	const pageHeight = pageTop - pageBottom;
	const translatedItems: ColumnAwareTextBox[] = page.items.map((item) => ({
		...item,
		vertical: item.vertical === true
			|| (item.fontName !== undefined && page.styles?.[item.fontName]?.vertical === true),
		transform: item.transform.length >= 6
			? [
				item.transform[0],
				item.transform[1],
				item.transform[2],
				item.transform[3],
				item.transform[4] - pageLeft,
				item.transform[5] - pageBottom,
			]
			: item.transform,
	}));
	const layout = layoutColumnAwarePage(
		{ width: pageWidth, height: pageHeight, rotation: page.rotation },
		translatedItems,
		{
			...options,
			spanningBands: page.spanningBands?.map(([bottom, top]) => ({
				bottom: bottom - pageBottom,
				top: top - pageBottom,
			})),
		},
	);

	return layout.regions.map((region) => {
		const left = region.rect.x + pageLeft;
		const bottom = region.rect.y + pageBottom;
		const right = left + region.rect.width;
		const top = bottom + region.rect.height;
		return {
			kind: region.kind === 'full-width'
				? 'full-width'
				: region.column === 'left' ? 'left-column' : 'right-column',
			rect: [left, bottom, right, top],
			confidence: layout.confidence,
		};
	});
}
