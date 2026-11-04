export interface PdfFrontMatterTextPage {
	getTextContent(options: { includeMarkedContent: false }): Promise<{ items: unknown[] }>;
	cleanup?(): unknown;
}

export interface PdfFrontMatterTextDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfFrontMatterTextPage>;
}

export type PdfFrontMatterReadPhase = 'read' | 'cleanup';

export interface PdfFrontMatterCollectionOptions {
	pageLimit: number;
	characterLimit: number;
	onError?: (pageNumber: number, phase: PdfFrontMatterReadPhase, error: unknown) => void;
}

export function pdfTextItemsToText(items: unknown[]): string {
	const parts: string[] = [];
	for (const item of items) {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
		const textItem = item as Record<string, unknown>;
		if (typeof textItem.str !== 'string') continue;
		parts.push(textItem.str);
		if (textItem.hasEOL === true) parts.push('\n');
		else parts.push(' ');
	}
	return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

export async function collectPdfFrontMatterPages(
	document: PdfFrontMatterTextDocument,
	options: PdfFrontMatterCollectionOptions,
): Promise<string[]> {
	const pageLimit = Math.max(0, Math.floor(options.pageLimit));
	const characterLimit = Math.max(0, Math.floor(options.characterLimit));
	const pageCount = Math.min(document.numPages, pageLimit);
	const pages: string[] = [];

	for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
		let page: PdfFrontMatterTextPage | null = null;
		let text = '';
		try {
			page = await document.getPage(pageNumber);
			const content = await page.getTextContent({ includeMarkedContent: false });
			text = pdfTextItemsToText(content.items).slice(0, characterLimit);
		} catch (error) {
			options.onError?.(pageNumber, 'read', error);
		} finally {
			if (page?.cleanup) {
				try {
					page.cleanup();
				} catch (error) {
					options.onError?.(pageNumber, 'cleanup', error);
				}
			}
		}
		pages.push(text);
	}

	return pages;
}
