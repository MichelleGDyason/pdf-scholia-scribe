import { App, Modal, Notice, TFile, TFolder, normalizePath } from 'obsidian';


export type ScholiaDocumentKind = 'docx' | 'gdoc' | 'text';
export type ScholiaAnnotationStatus = 'open' | 'resolved';

export interface TextQuoteAnchor {
	start: number;
	end: number;
	exact: string;
	prefix: string;
	suffix: string;
}

export interface ScholiaAnnotation {
	version: 1;
	id: string;
	sourcePath: string;
	sourceKind: ScholiaDocumentKind;
	quote: string;
	comment: string;
	author: string;
	createdAt: string;
	status: ScholiaAnnotationStatus;
	anchor?: TextQuoteAnchor;
}

interface AnnotationModalOptions {
	app: App;
	title: string;
	quote?: string;
	author: string;
	allowQuoteEditing?: boolean;
	onSubmit: (value: { quote: string; comment: string; author: string }) => Promise<void>;
}

const ANNOTATION_ROOT = 'Scholia/Annotations';
const ANNOTATION_MARKER_PREFIX = '<!-- scholia-annotation:v1:';
const ANNOTATION_MARKER_SUFFIX = ' -->';
const ANNOTATION_MARKER_PATTERN = /<!-- scholia-annotation:v1:([A-Za-z0-9+/=]+) -->/g;

const encodeBase64 = (value: string): string => {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return window.btoa(binary);
};

const decodeBase64 = (value: string): string => {
	const binary = window.atob(value);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder().decode(bytes);
};

const createAnnotationMarker = (annotation: ScholiaAnnotation): string => {
	return `${ANNOTATION_MARKER_PREFIX}${encodeBase64(JSON.stringify(annotation))}${ANNOTATION_MARKER_SUFFIX}`;
};

const parseAnnotationMarker = (encoded: string): ScholiaAnnotation | null => {
	try {
		const value: unknown = JSON.parse(decodeBase64(encoded));
		if (typeof value !== 'object' || value === null) return null;
		const candidate = value as Partial<ScholiaAnnotation>;
		if (
			candidate.version !== 1
			|| typeof candidate.id !== 'string'
			|| typeof candidate.sourcePath !== 'string'
			|| !['docx', 'gdoc', 'text'].includes(candidate.sourceKind ?? '')
			|| typeof candidate.quote !== 'string'
			|| typeof candidate.comment !== 'string'
			|| typeof candidate.author !== 'string'
			|| typeof candidate.createdAt !== 'string'
			|| !['open', 'resolved'].includes(candidate.status ?? '')
		) return null;
		return candidate as ScholiaAnnotation;
	} catch {
		return null;
	}
};

const yamlString = (value: string): string => JSON.stringify(value);

const formatReadableAnnotation = (annotation: ScholiaAnnotation): string => {
	const quote = annotation.quote
		? annotation.quote.split('\n').map((line) => `> ${line}`).join('\n')
		: '> *(Document-level note)*';
	const status = annotation.status === 'resolved' ? 'resolved' : 'open';
	return [
		`## ${annotation.author} · ${annotation.createdAt}`,
		'',
		createAnnotationMarker(annotation),
		'',
		quote,
		'',
		annotation.comment,
		'',
		`Status: **${status}**`,
		'',
	].join('\n');
};

const pathHash = (value: string): string => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
};

const safeBasename = (path: string): string => {
	const basename = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'document';
	const safe = basename.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
	return (safe || 'document').slice(0, 80);
};

export class ScholiaAnnotationStore {
	constructor(private app: App) {}

	getAnnotationPath(sourcePath: string): string {
		return normalizePath(`${ANNOTATION_ROOT}/${safeBasename(sourcePath)}-${pathHash(sourcePath)}.md`);
	}

	async add(annotation: ScholiaAnnotation): Promise<TFile> {
		await this.ensureFolder(ANNOTATION_ROOT);
		const annotationPath = this.getAnnotationPath(annotation.sourcePath);
		const existing = this.app.vault.getAbstractFileByPath(annotationPath);
		const readable = formatReadableAnnotation(annotation);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, (content) => `${content.trimEnd()}\n\n${readable}`);
			return existing;
		}

		const title = safeBasename(annotation.sourcePath).replace(/-/g, ' ');
		const content = [
			'---',
			'scholia_type: document_annotations',
			`source_path: ${yamlString(annotation.sourcePath)}`,
			`source_format: ${annotation.sourceKind}`,
			'---',
			'',
			`# Annotations for ${title}`,
			'',
			`Source: [[${annotation.sourcePath}]]`,
			'',
			readable,
		].join('\n');
		return this.app.vault.create(annotationPath, content);
	}

	async listForSource(sourcePath: string): Promise<ScholiaAnnotation[]> {
		const file = this.app.vault.getAbstractFileByPath(this.getAnnotationPath(sourcePath));
		if (!(file instanceof TFile)) return [];
		return this.readAnnotations(file);
	}

	async listAll(): Promise<Array<{ annotation: ScholiaAnnotation; note: TFile }>> {
		const notes = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${ANNOTATION_ROOT}/`));
		const results: Array<{ annotation: ScholiaAnnotation; note: TFile }> = [];
		for (const note of notes) {
			const annotations = await this.readAnnotations(note);
			for (const annotation of annotations) results.push({ annotation, note });
		}
		return results.sort((left, right) => right.annotation.createdAt.localeCompare(left.annotation.createdAt));
	}

	async setStatus(note: TFile, annotationId: string, status: ScholiaAnnotationStatus): Promise<void> {
		await this.app.vault.process(note, (content) => {
			return content.replace(ANNOTATION_MARKER_PATTERN, (marker, encoded: string) => {
				const annotation = parseAnnotationMarker(encoded);
				if (!annotation || annotation.id !== annotationId) return marker;
				return createAnnotationMarker({ ...annotation, status });
			}).replace(
				/(<!-- scholia-annotation:v1:[A-Za-z0-9+/=]+ -->[\s\S]*?Status: \*\*)(open|resolved)(\*\*)/g,
				(block, prefix: string, currentStatus: string, suffix: string) => {
					const marker = block.match(ANNOTATION_MARKER_PATTERN)?.[0];
					if (!marker) return block;
					ANNOTATION_MARKER_PATTERN.lastIndex = 0;
					const encoded = marker.slice(ANNOTATION_MARKER_PREFIX.length, -ANNOTATION_MARKER_SUFFIX.length);
					const annotation = parseAnnotationMarker(encoded);
					return annotation?.id === annotationId ? `${prefix}${status}${suffix}` : `${prefix}${currentStatus}${suffix}`;
				}
			);
		});
	}

	private async readAnnotations(file: TFile): Promise<ScholiaAnnotation[]> {
		const content = await this.app.vault.cachedRead(file);
		const annotations: ScholiaAnnotation[] = [];
		for (const match of content.matchAll(ANNOTATION_MARKER_PATTERN)) {
			const annotation = parseAnnotationMarker(match[1]);
			if (annotation) annotations.push(annotation);
		}
		return annotations;
	}

	private async ensureFolder(path: string): Promise<void> {
		const segments = normalizePath(path).split('/');
		let currentPath = '';
		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Cannot create annotation folder because ${currentPath} is a file.`);
			await this.app.vault.createFolder(currentPath);
		}
	}
}

export class ScholiaAnnotationModal extends Modal {
	private quote: string;
	private author: string;

	constructor(private options: AnnotationModalOptions) {
		super(options.app);
		this.quote = options.quote ?? '';
		this.author = options.author;
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.addClass('scholia-annotation-modal');

		if (this.options.allowQuoteEditing) {
			this.contentEl.createEl('label', { text: 'Quoted passage (optional)' });
			const quoteInput = this.contentEl.createEl('textarea', { cls: 'scholia-annotation-quote-input' });
			quoteInput.value = this.quote;
			quoteInput.addEventListener('input', () => this.quote = quoteInput.value.trim());
		} else if (this.quote) {
			this.contentEl.createEl('blockquote', { text: this.quote });
		}

		this.contentEl.createEl('label', { text: 'Comment' });
		const commentInput = this.contentEl.createEl('textarea', { cls: 'scholia-annotation-comment-input' });
		commentInput.placeholder = 'Add context, a question, or a response…';

		this.contentEl.createEl('label', { text: 'Author' });
		const authorInput = this.contentEl.createEl('input', { type: 'text', value: this.author });
		authorInput.addEventListener('input', () => this.author = authorInput.value.trim());

		const actions = this.contentEl.createDiv('modal-button-container');
		const cancelButton = actions.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => this.close());
		const saveButton = actions.createEl('button', { text: 'Add annotation', cls: 'mod-cta' });
		saveButton.addEventListener('click', () => {
			const comment = commentInput.value.trim();
			if (!comment) {
				new Notice('Add a comment before saving the annotation.');
				commentInput.focus();
				return;
			}
			if (!this.author) {
				new Notice('Add an author name before saving the annotation.');
				authorInput.focus();
				return;
			}
			saveButton.disabled = true;
			void this.options.onSubmit({ quote: this.quote, comment, author: this.author })
				.then(() => this.close())
				.catch((error: unknown) => {
					console.error(error);
					new Notice('The annotation could not be saved.');
					saveButton.disabled = false;
				});
		});

		window.setTimeout(() => commentInput.focus());
	}
}

export const createAnnotationId = (): string => {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
