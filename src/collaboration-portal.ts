import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';

import type PDFPlus from 'main';
import { ScholiaAnnotation, ScholiaAnnotationStore } from 'document-annotations';
import { SCHOLIA_DOCUMENT_EXTENSIONS, SCHOLIA_DOCUMENT_VIEW_TYPE, ScholiaDocumentView } from 'document-viewer';


export const SCHOLIA_COLLABORATION_VIEW_TYPE = 'scholia-collaboration-portal';

interface PortalAnnotation {
	annotation: ScholiaAnnotation;
	note: TFile;
}

export class ScholiaCollaborationPortalView extends ItemView {
	private showResolved = false;
	private refreshSequence = 0;

	constructor(leaf: WorkspaceLeaf, private store: ScholiaAnnotationStore) {
		super(leaf);
	}

	getViewType(): string {
		return SCHOLIA_COLLABORATION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Scholia collaboration';
	}

	getIcon(): string {
		return 'messages-square';
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file.path.startsWith('Scholia/Annotations/')) void this.renderPortal();
		}));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file.path.startsWith('Scholia/Annotations/')) void this.renderPortal();
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file.path.startsWith('Scholia/Annotations/')) void this.renderPortal();
		}));
		await this.renderPortal();
	}

	private async renderPortal(): Promise<void> {
		const sequence = ++this.refreshSequence;
		const annotations = await this.store.listAll();
		if (sequence !== this.refreshSequence) return;

		this.contentEl.empty();
		this.contentEl.addClass('scholia-collaboration-portal');
		const header = this.contentEl.createDiv('scholia-portal-header');
		const title = header.createDiv();
		title.createEl('h2', { text: 'Scholia collaboration' });
		title.createEl('p', { text: 'Portable annotation threads for DOCX, Google Docs references, and text documents.' });
		const headerActions = header.createDiv('scholia-portal-header-actions');
		const resolvedButton = headerActions.createEl('button', { text: this.showResolved ? 'Hide resolved' : 'Show resolved' });
		resolvedButton.addEventListener('click', () => {
			this.showResolved = !this.showResolved;
			void this.renderPortal();
		});
		const refreshButton = headerActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Refresh collaboration portal' } });
		setIcon(refreshButton, 'refresh-cw');
		refreshButton.addEventListener('click', () => void this.renderPortal());

		const openCount = annotations.filter(({ annotation }) => annotation.status === 'open').length;
		const resolvedCount = annotations.length - openCount;
		const stats = this.contentEl.createDiv('scholia-portal-stats');
		this.createStat(stats, String(openCount), 'Open threads');
		this.createStat(stats, String(resolvedCount), 'Resolved');
		this.createStat(stats, String(new Set(annotations.map(({ annotation }) => annotation.sourcePath)).size), 'Documents');

		const visible = annotations.filter(({ annotation }) => this.showResolved || annotation.status === 'open');
		if (!visible.length) {
			const empty = this.contentEl.createDiv('scholia-portal-empty');
			setIcon(empty.createDiv(), 'message-square-dashed');
			empty.createEl('h3', { text: openCount ? 'Resolved threads are hidden' : 'No open annotation threads' });
			empty.createEl('p', { text: 'Open a DOCX or Google Docs reference and add an annotation or portal note.' });
			return;
		}

		const groups = new Map<string, PortalAnnotation[]>();
		for (const entry of visible) {
			const group = groups.get(entry.annotation.sourcePath) ?? [];
			group.push(entry);
			groups.set(entry.annotation.sourcePath, group);
		}

		const list = this.contentEl.createDiv('scholia-portal-documents');
		for (const [sourcePath, entries] of groups) this.renderDocumentGroup(list, sourcePath, entries);
	}

	private createStat(parent: HTMLElement, value: string, label: string): void {
		const stat = parent.createDiv('scholia-portal-stat');
		stat.createEl('strong', { text: value });
		stat.createSpan({ text: label });
	}

	private renderDocumentGroup(parent: HTMLElement, sourcePath: string, entries: PortalAnnotation[]): void {
		const group = parent.createEl('section', { cls: 'scholia-portal-document' });
		const header = group.createDiv('scholia-portal-document-header');
		const sourceKind = entries[0]?.annotation.sourceKind ?? 'docx';
		setIcon(header.createSpan(), sourceKind === 'gdoc' ? 'file-cloud' : 'file-text');
		const title = header.createDiv();
		title.createEl('h3', { text: sourcePath.split('/').pop() ?? sourcePath });
		title.createEl('small', { text: sourcePath });
		const openButton = header.createEl('button', { text: 'Open document' });
		const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
		openButton.disabled = !(sourceFile instanceof TFile);
		openButton.addEventListener('click', () => {
			if (sourceFile instanceof TFile) void this.app.workspace.getLeaf(true).openFile(sourceFile);
		});

		for (const entry of entries) this.renderAnnotationCard(group, entry);
	}

	private renderAnnotationCard(parent: HTMLElement, entry: PortalAnnotation): void {
		const { annotation, note } = entry;
		const card = parent.createDiv(`scholia-portal-thread is-${annotation.status}`);
		const meta = card.createDiv('scholia-portal-thread-meta');
		meta.createEl('strong', { text: annotation.author });
		meta.createEl('time', { text: new Date(annotation.createdAt).toLocaleString(), attr: { datetime: annotation.createdAt } });
		meta.createSpan({ text: annotation.status, cls: 'scholia-portal-status' });
		if (annotation.quote) card.createEl('blockquote', { text: annotation.quote });
		card.createEl('p', { text: annotation.comment });
		const actions = card.createDiv('scholia-portal-thread-actions');
		const statusButton = actions.createEl('button', { text: annotation.status === 'open' ? 'Resolve' : 'Reopen' });
		statusButton.addEventListener('click', () => {
			void this.store.setStatus(note, annotation.id, annotation.status === 'open' ? 'resolved' : 'open');
		});
		const noteButton = actions.createEl('button', { text: 'Open thread note' });
		noteButton.addEventListener('click', () => void this.app.workspace.getLeaf(true).openFile(note));
	}
}

export const openScholiaCollaborationPortal = async (plugin: PDFPlus): Promise<void> => {
	let leaf = plugin.app.workspace.getLeavesOfType(SCHOLIA_COLLABORATION_VIEW_TYPE)[0];
	if (!leaf) {
		leaf = plugin.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: SCHOLIA_COLLABORATION_VIEW_TYPE, active: true });
	}
	await plugin.app.workspace.revealLeaf(leaf);
};

export const registerScholiaDocumentWorkspace = (plugin: PDFPlus): void => {
	const store = new ScholiaAnnotationStore(plugin.app);
	plugin.registerView(
		SCHOLIA_DOCUMENT_VIEW_TYPE,
		(leaf) => new ScholiaDocumentView(leaf, plugin, store),
	);
	plugin.registerExtensions(SCHOLIA_DOCUMENT_EXTENSIONS, SCHOLIA_DOCUMENT_VIEW_TYPE);
	plugin.registerView(
		SCHOLIA_COLLABORATION_VIEW_TYPE,
		(leaf) => new ScholiaCollaborationPortalView(leaf, store),
	);
	plugin.addCommand({
		id: 'open-scholia-collaboration-portal',
		name: 'Open document collaboration portal',
		callback: () => void openScholiaCollaborationPortal(plugin),
	});
	plugin.addRibbonIcon('messages-square', 'Open Scholia collaboration', () => {
		void openScholiaCollaborationPortal(plugin);
	});
};
