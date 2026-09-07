export const NOTE_TEXT_ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;

export type NoteTextAlignment = typeof NOTE_TEXT_ALIGNMENTS[number];

export const NOTE_TEXT_ALIGNMENT_CLASSES: Record<NoteTextAlignment, string> = {
	left: 'scholia-note-align-left',
	center: 'scholia-note-align-center',
	right: 'scholia-note-align-right',
	justify: 'scholia-note-align-justify',
};

const managedClasses = new Set(Object.values(NOTE_TEXT_ALIGNMENT_CLASSES));

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
	const classes = parseCssClasses(value).filter((className) => !managedClasses.has(className));
	classes.push(NOTE_TEXT_ALIGNMENT_CLASSES[alignment]);
	return classes;
}
