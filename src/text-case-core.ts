export type TextCaseMode = 'upper' | 'lower' | 'sentence' | 'title';

export type TextCaseOffsetSelection = {
	anchor: number;
	head: number;
};

export type TextCaseEditPlan = {
	changes: Array<{ from: number, to: number, text: string }>;
	selections: TextCaseOffsetSelection[];
	text: string;
};

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const TITLE_SMALL_WORDS = new Set([
	'a',
	'an',
	'and',
	'as',
	'at',
	'but',
	'by',
	'en',
	'for',
	'if',
	'in',
	'nor',
	'of',
	'on',
	'or',
	'per',
	'the',
	'to',
	'v',
	'v.',
	'via',
	'vs',
	'vs.',
	'with',
	'yet',
]);

const COMMON_INITIALISMS = new Set([
	'AI',
	'API',
	'CSS',
	'CSL',
	'DOI',
	'EPUB',
	'HTML',
	'ISBN',
	'JSON',
	'NASA',
	'OCR',
	'PDF',
	'RTL',
	'UI',
	'URL',
	'UX',
	'XML',
	'XMP',
]);

function isCasedCharacter(character: string): boolean {
	return character.toLocaleLowerCase() !== character.toLocaleUpperCase();
}

function casedCharacters(text: string): string[] {
	return Array.from(text).filter(isCasedCharacter);
}

function isAllCapsSelection(text: string): boolean {
	const characters = casedCharacters(text);
	return characters.length > 0 && characters.every((character) => character === character.toLocaleUpperCase());
}

function capitalizeFirstCasedCharacter(text: string): string {
	const characters = Array.from(text);
	const index = characters.findIndex(isCasedCharacter);
	if (index < 0) return text;
	characters[index] = characters[index].toLocaleUpperCase();
	return characters.join('');
}

function shouldPreserveInitialism(word: string, allCapsSelection: boolean): boolean {
	const normalized = word.replace(/[’']/g, "'");
	const upper = normalized.toLocaleUpperCase();
	if (COMMON_INITIALISMS.has(upper)) return true;
	if (allCapsSelection) return false;
	return /^[\p{Lu}]{2,}(?:'s)?$/u.test(normalized);
}

function hasIntentionalMixedCase(word: string, allCapsSelection: boolean): boolean {
	if (allCapsSelection) return false;
	const characters = casedCharacters(word);
	if (characters.length < 3) return false;
	const internalUpper = characters.findIndex((character, index) => {
		return index > 0 && character === character.toLocaleUpperCase();
	});
	if (internalUpper < 0) return false;
	const hasLowerBefore = characters.slice(0, internalUpper)
		.some((character) => character === character.toLocaleLowerCase());
	const hasLowerAfter = characters.slice(internalUpper + 1)
		.some((character) => character === character.toLocaleLowerCase());
	return hasLowerBefore && hasLowerAfter;
}

function normalizedTitleWord(word: string, allCapsSelection: boolean): string {
	if (shouldPreserveInitialism(word, allCapsSelection)) return word.toLocaleUpperCase();
	if (hasIntentionalMixedCase(word, allCapsSelection)) return word;
	return word.toLocaleLowerCase();
}

function normalizedSentenceWord(word: string, allCapsSelection: boolean): string {
	const upper = word.replace(/[’']/g, "'").toLocaleUpperCase();
	if (COMMON_INITIALISMS.has(upper)) return upper;
	if (hasIntentionalMixedCase(word, allCapsSelection)) return word;
	return word.toLocaleLowerCase();
}

function wordMatches(text: string): RegExpMatchArray[] {
	return Array.from(text.matchAll(WORD_PATTERN));
}

export function toSentenceCase(text: string): string {
	const matches = wordMatches(text);
	if (matches.length === 0) return text;
	const allCapsSelection = isAllCapsSelection(text);
	let result = '';
	let previousEnd = 0;
	let startsSentence = true;

	for (const match of matches) {
		const index = match.index ?? previousEnd;
		const between = text.slice(previousEnd, index);
		result += between;
		if (/[.!?]|[\r\n]/u.test(between)) startsSentence = true;

		let word = normalizedSentenceWord(match[0], allCapsSelection);
		if (startsSentence && !hasIntentionalMixedCase(match[0], allCapsSelection)) {
			word = capitalizeFirstCasedCharacter(word);
		}
		result += word;
		if (casedCharacters(word).length > 0) startsSentence = false;
		previousEnd = index + match[0].length;
	}

	return result + text.slice(previousEnd);
}

function followsTitleBoundary(text: string): boolean {
	return /[:.!?–—]\s*$/u.test(text) || /[\r\n]/u.test(text);
}

export function toTitleCase(text: string): string {
	const matches = wordMatches(text);
	if (matches.length === 0) return text;
	const allCapsSelection = isAllCapsSelection(text);
	let result = '';
	let previousEnd = 0;

	for (let position = 0; position < matches.length; position++) {
		const match = matches[position];
		const index = match.index ?? previousEnd;
		const between = text.slice(previousEnd, index);
		result += between;
		const lower = match[0].toLocaleLowerCase();
		const isEdge = position === 0 || position === matches.length - 1;
		const mustCapitalize = isEdge || followsTitleBoundary(between) || !TITLE_SMALL_WORDS.has(lower);
		let word = normalizedTitleWord(match[0], allCapsSelection);
		if (mustCapitalize && !shouldPreserveInitialism(match[0], allCapsSelection) && !hasIntentionalMixedCase(match[0], allCapsSelection)) {
			word = capitalizeFirstCasedCharacter(word);
		}
		result += word;
		previousEnd = index + match[0].length;
	}

	return result + text.slice(previousEnd);
}

export function convertTextCase(text: string, mode: TextCaseMode): string {
	switch (mode) {
		case 'upper':
			return text.toLocaleUpperCase();
		case 'lower':
			return text.toLocaleLowerCase();
		case 'sentence':
			return toSentenceCase(text);
		case 'title':
			return toTitleCase(text);
	}
}

export function planTextCaseEdits(
	text: string,
	selections: TextCaseOffsetSelection[],
	mode: TextCaseMode,
): TextCaseEditPlan | null {
	const indexed = selections.map((selection, index) => {
		const anchor = Math.max(0, Math.min(selection.anchor, text.length));
		const head = Math.max(0, Math.min(selection.head, text.length));
		const from = Math.min(anchor, head);
		const to = Math.max(anchor, head);
		return {
			index,
			anchor,
			head,
			from,
			to,
			replacement: from === to ? '' : convertTextCase(text.slice(from, to), mode),
			finalFrom: from,
			finalTo: to,
		};
	});
	const changes = indexed
		.filter((selection) => selection.from !== selection.to)
		.sort((left, right) => left.from - right.from || left.to - right.to);
	if (!changes.length) return null;
	for (let index = 1; index < changes.length; index++) {
		if (changes[index].from < changes[index - 1].to) return null;
	}

	let delta = 0;
	for (const change of changes) {
		change.finalFrom = change.from + delta;
		change.finalTo = change.finalFrom + change.replacement.length;
		delta += change.replacement.length - (change.to - change.from);
	}

	let finalText = text;
	for (const change of [...changes].reverse()) {
		finalText = finalText.slice(0, change.from) + change.replacement + finalText.slice(change.to);
	}

	const mapOffset = (offset: number): number => {
		let precedingDelta = 0;
		for (const change of changes) {
			if (offset <= change.from) return offset + precedingDelta;
			if (offset < change.to) return change.finalFrom;
			if (offset === change.to) return change.finalTo;
			precedingDelta += change.replacement.length - (change.to - change.from);
		}
		return offset + precedingDelta;
	};

	return {
		changes: changes.map((change) => ({ from: change.from, to: change.to, text: change.replacement })),
		selections: indexed
			.sort((left, right) => left.index - right.index)
			.map((selection) => {
				const changed = selection.from === selection.to ? null : selection;
				const from = changed?.finalFrom ?? mapOffset(selection.from);
				const to = changed?.finalTo ?? mapOffset(selection.to);
				return selection.anchor <= selection.head
					? { anchor: from, head: to }
					: { anchor: to, head: from };
			}),
		text: finalText,
	};
}
