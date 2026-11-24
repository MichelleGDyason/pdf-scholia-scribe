export const NOTE_TEXT_ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;
export const NOTE_PARAGRAPH_STYLES = ['indented', 'spaced'] as const;

export const NOTE_HEADING_INDENT_CLASS = 'scholia-note-heading-indents';

export type NoteTextAlignment = typeof NOTE_TEXT_ALIGNMENTS[number];
export type NoteParagraphStyle = typeof NOTE_PARAGRAPH_STYLES[number];

export const NOTE_TEXT_ALIGNMENT_CLASSES: Record<NoteTextAlignment, string> = {
	left: 'scholia-note-align-left',
	center: 'scholia-note-align-center',
	right: 'scholia-note-align-right',
	justify: 'scholia-note-align-justify',
};

export const NOTE_PARAGRAPH_STYLE_CLASSES: Record<NoteParagraphStyle, string> = {
	indented: 'scholia-note-paragraph-indented',
	spaced: 'scholia-note-paragraph-spaced',
};

const managedAlignmentClasses = new Set(Object.values(NOTE_TEXT_ALIGNMENT_CLASSES));
const managedParagraphClasses = new Set(Object.values(NOTE_PARAGRAPH_STYLE_CLASSES));

export interface HeadingPosition {
	level: number;
	position: {
		start: {
			line: number;
		};
	};
}

/**
 * Convert Obsidian's supported `cssclasses` representations into individual class names.
 *
 * A malformed value is rejected rather than replaced so an alignment change cannot silently
 * discard frontmatter owned by the user or another plugin.
 */
export function parseCssClasses(value: unknown): string[] {
	if (value === undefined || value === null || value === '') return [];

	if (typeof value === 'string') {
		return value.trim().split(/\s+/).filter(Boolean);
	}

	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
		return value.flatMap((item) => item.trim().split(/\s+/).filter(Boolean));
	}

	throw new TypeError('The cssclasses property must be text or a list of text values.');
}

export function getNoteTextAlignment(value: unknown): NoteTextAlignment {
	const classes = parseCssClasses(value);
	return NOTE_TEXT_ALIGNMENTS.find((alignment) => classes.includes(NOTE_TEXT_ALIGNMENT_CLASSES[alignment])) ?? 'left';
}

/** Replace only the alignment class managed by PDF Scholia Scribe. */
export function setNoteTextAlignmentClass(value: unknown, alignment: NoteTextAlignment): string[] {
	const classes = parseCssClasses(value).filter((className) => !managedAlignmentClasses.has(className));
	classes.push(NOTE_TEXT_ALIGNMENT_CLASSES[alignment]);
	return classes;
}

/** Treat Obsidian's ordinary spaced paragraphs as the default for notes without a managed class. */
export function getNoteParagraphStyle(value: unknown): NoteParagraphStyle {
	const classes = parseCssClasses(value);
	return NOTE_PARAGRAPH_STYLES.find((style) => classes.includes(NOTE_PARAGRAPH_STYLE_CLASSES[style])) ?? 'spaced';
}

/** Replace only the paragraph-appearance class managed by PDF Scholia Scribe. */
export function setNoteParagraphStyleClass(value: unknown, style: NoteParagraphStyle): string[] {
	const classes = parseCssClasses(value).filter((className) => !managedParagraphClasses.has(className));
	classes.push(NOTE_PARAGRAPH_STYLE_CLASSES[style]);
	return classes;
}

export function isNoteHeadingIndentEnabled(value: unknown): boolean {
	return parseCssClasses(value).includes(NOTE_HEADING_INDENT_CLASS);
}

/** Add or remove only the heading-indentation class managed by PDF Scholia Scribe. */
export function setNoteHeadingIndentClass(value: unknown, enabled: boolean): string[] {
	const classes = parseCssClasses(value).filter((className) => className !== NOTE_HEADING_INDENT_CLASS);
	if (enabled) classes.push(NOTE_HEADING_INDENT_CLASS);
	return classes;
}

/** Check the source frontmatter directly, since Obsidian does not class every editor container. */
export function markdownHasNoteHeadingIndentClass(markdown: string): boolean {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return false;

	for (let index = 1; index < lines.length; index++) {
		if (/^(?:---|\.\.\.)\s*$/.test(lines[index])) return false;
		if (lines[index].includes(NOTE_HEADING_INDENT_CLASS)) return true;
	}
	return false;
}

/** Return the most recent Markdown heading level before a zero-based source line. */
export function getHeadingIndentDepthAtLine(headings: readonly HeadingPosition[] | undefined, line: number): number {
	let depth = 0;
	for (const heading of headings ?? []) {
		if (heading.position.start.line >= line) break;
		depth = heading.level;
	}
	return depth;
}

/**
 * Calculate the heading depth for every source line in editing view.
 *
 * ATX and Setext headings are recognised, while heading-looking text inside YAML frontmatter or
 * fenced code blocks is ignored. Heading syntax itself has depth zero so headings stay flush left.
 */
export function getMarkdownHeadingIndentDepths(markdown: string): number[] {
	const lines = markdown.split(/\r?\n/);
	const headingLevels = new Array<number>(lines.length).fill(0);
	const headingSyntaxLines = new Array<boolean>(lines.length).fill(false);
	const excludedLines = new Array<boolean>(lines.length).fill(false);
	const frontmatterLines = new Array<boolean>(lines.length).fill(false);

	let frontmatter = lines[0]?.trim() === '---';
	let fenceCharacter = '';
	let fenceLength = 0;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];

		if (frontmatter) {
			excludedLines[index] = true;
			frontmatterLines[index] = true;
			if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
			continue;
		}

		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceCharacter) {
			excludedLines[index] = true;
			if (fence && fence[1][0] === fenceCharacter && fence[1].length >= fenceLength && !fence[2].trim()) {
				fenceCharacter = '';
				fenceLength = 0;
			}
			continue;
		}
		if (fence) {
			excludedLines[index] = true;
			fenceCharacter = fence[1][0];
			fenceLength = fence[1].length;
			continue;
		}

		const atxHeading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
		if (atxHeading) {
			headingLevels[index] = atxHeading[1].length;
			headingSyntaxLines[index] = true;
			continue;
		}

		const setextHeading = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
		if (setextHeading && index > 0 && lines[index - 1].trim() && !excludedLines[index - 1] && !headingSyntaxLines[index - 1]) {
			headingLevels[index - 1] = setextHeading[1][0] === '=' ? 1 : 2;
			headingSyntaxLines[index - 1] = true;
			headingSyntaxLines[index] = true;
		}
	}

	let depth = 0;
	return lines.map((_line, index) => {
		if (headingLevels[index]) {
			depth = headingLevels[index];
			return 0;
		}
		if (headingSyntaxLines[index] || frontmatterLines[index]) return 0;
		return depth;
	});
}
