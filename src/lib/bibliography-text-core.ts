export interface BibliographyTextGeometryItem {
	str: string;
	height: number;
	transform: readonly number[];
}

const FIT_R_COORDINATE_TOLERANCE = 2;

function getItemTop(item: BibliographyTextGeometryItem) {
	return item.transform[5] + (item.height || item.transform[0]) * 0.8;
}

/**
 * Locate the first text item at a PDF citation destination.
 *
 * XYZ and FitBH retain the extractor's original matching rules. FitR needs a
 * small tolerance because a destination rectangle and its rendered text often
 * differ by a fraction of a PDF point.
 */
export function findBibliographyStartIndex(
	items: readonly BibliographyTextGeometryItem[],
	destinationType: string,
	params: readonly (number | null)[],
) {
	if (destinationType === 'XYZ') {
		const left = params[0];
		const top = params[1];
		if (typeof left !== 'number' || typeof top !== 'number') return -1;

		return items.findIndex((item) => {
			if (!item.str) return false;
			const itemLeft = item.transform[4];
			return left <= itemLeft && getItemTop(item) <= top;
		});
	}

	if (destinationType === 'FitBH') {
		const top = params[0];
		if (typeof top !== 'number') return -1;

		return items.findIndex((item) => item.str && getItemTop(item) <= top);
	}

	if (destinationType === 'FitR') {
		const left = params[0];
		const bottom = params[1];
		const right = params[2];
		const top = params[3];
		if (typeof left !== 'number' || typeof bottom !== 'number'
			|| typeof right !== 'number' || typeof top !== 'number') return -1;
		const minX = Math.min(left, right);
		const maxX = Math.max(left, right);
		const minY = Math.min(bottom, top);
		const maxY = Math.max(bottom, top);

		return items.findIndex((item) => {
			if (!item.str) return false;
			const itemLeft = item.transform[4];
			const itemTop = getItemTop(item);
			return minX - FIT_R_COORDINATE_TOLERANCE <= itemLeft
				&& itemLeft <= maxX + FIT_R_COORDINATE_TOLERANCE
				&& minY - FIT_R_COORDINATE_TOLERANCE <= itemTop
				&& itemTop <= maxY + FIT_R_COORDINATE_TOLERANCE;
		});
	}

	return -1;
}
