export type MoveDirection = 'up' | 'down';

export interface LineRange {
	start: number;
	end: number;
}

export interface ParagraphMove extends LineRange {
	regionStart: number;
	regionEnd: number;
	replacement: string[];
	lineDelta: number;
}

function isBlank(line: string) {
	return line.trim().length === 0;
}

export function getParagraphRange(lines: string[], selectedStart: number, selectedEnd: number): LineRange | null {
	if (lines.length === 0) return null;
	let start = Math.max(0, Math.min(selectedStart, lines.length - 1));
	let end = Math.max(start, Math.min(selectedEnd, lines.length - 1));

	while (start <= end && isBlank(lines[start])) start++;
	while (end >= start && isBlank(lines[end])) end--;
	if (start > end) return null;

	while (start > 0 && !isBlank(lines[start - 1])) start--;
	while (end + 1 < lines.length && !isBlank(lines[end + 1])) end++;
	return { start, end };
}

export function planParagraphMove(
	lines: string[],
	selectedStart: number,
	selectedEnd: number,
	direction: MoveDirection,
): ParagraphMove | null {
	const current = getParagraphRange(lines, selectedStart, selectedEnd);
	if (!current) return null;

	if (direction === 'up') {
		let previousEnd = current.start - 1;
		while (previousEnd >= 0 && isBlank(lines[previousEnd])) previousEnd--;
		if (previousEnd < 0) return null;
		let previousStart = previousEnd;
		while (previousStart > 0 && !isBlank(lines[previousStart - 1])) previousStart--;
		const gap = lines.slice(previousEnd + 1, current.start);
		return {
			start: current.start,
			end: current.end,
			regionStart: previousStart,
			regionEnd: current.end,
			replacement: [
				...lines.slice(current.start, current.end + 1),
				...gap,
				...lines.slice(previousStart, previousEnd + 1),
			],
			lineDelta: previousStart - current.start,
		};
	}

	let nextStart = current.end + 1;
	while (nextStart < lines.length && isBlank(lines[nextStart])) nextStart++;
	if (nextStart >= lines.length) return null;
	let nextEnd = nextStart;
	while (nextEnd + 1 < lines.length && !isBlank(lines[nextEnd + 1])) nextEnd++;
	const gap = lines.slice(current.end + 1, nextStart);
	return {
		start: current.start,
		end: current.end,
		regionStart: current.start,
		regionEnd: nextEnd,
		replacement: [
			...lines.slice(nextStart, nextEnd + 1),
			...gap,
			...lines.slice(current.start, current.end + 1),
		],
		lineDelta: nextEnd - current.end,
	};
}
