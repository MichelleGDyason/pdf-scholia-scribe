import { Editor, EditorPosition, Menu } from 'obsidian';

import type PDFPlus from 'main';
import { planTextCaseEdits, TextCaseMode } from 'text-case-core';

const CHANGE_CASE_ORIGIN = 'pdf-scholia-scribe-change-case';

const CASE_ACTIONS: Array<{ mode: TextCaseMode, title: string }> = [
	{ mode: 'upper', title: 'UPPER CASE' },
	{ mode: 'lower', title: 'lower case' },
	{ mode: 'sentence', title: 'Sentence case' },
	{ mode: 'title', title: 'Title Case' },
];

function offsetToPosition(text: string, offset: number): EditorPosition {
	const bounded = Math.max(0, Math.min(offset, text.length));
	let line = 0;
	let lineStart = 0;
	for (let index = 0; index < bounded; index++) {
		if (text[index] !== '\n') continue;
		line++;
		lineStart = index + 1;
	}
	return { line, ch: bounded - lineStart };
}

export function changeSelectedTextCase(editor: Editor, mode: TextCaseMode): boolean {
	if (!editor.somethingSelected()) return false;

	const original = editor.getValue();
	const plan = planTextCaseEdits(
		original,
		editor.listSelections().map((selection) => ({
			anchor: editor.posToOffset(selection.anchor),
			head: editor.posToOffset(selection.head),
		})),
		mode,
	);
	if (!plan) return false;

	editor.transaction({
		changes: plan.changes.map((change) => ({
			from: editor.offsetToPos(change.from),
			to: editor.offsetToPos(change.to),
			text: change.text,
		})),
	}, CHANGE_CASE_ORIGIN);

	const finalSelections = plan.selections.map((selection) => ({
		anchor: offsetToPosition(plan.text, selection.anchor),
		head: offsetToPosition(plan.text, selection.head),
	}));
	editor.setSelections(finalSelections);
	editor.focus();
	return true;
}

function addChangeCaseMenu(menu: Menu, editor: Editor): void {
	if (!editor.somethingSelected()) return;
	menu.addItem((item) => {
		item.setTitle('Change case').setIcon('case-sensitive');
		const submenu = item.setSubmenu();
		for (const action of CASE_ACTIONS) {
			submenu.addItem((child) => child
				.setTitle(action.title)
				.onClick(() => changeSelectedTextCase(editor, action.mode)));
		}
	});
}

export function registerTextCaseTools(plugin: PDFPlus): void {
	for (const action of CASE_ACTIONS) {
		plugin.addCommand({
			id: `change-selected-text-${action.mode}-case`,
			name: `Change selected text to ${action.title}`,
			icon: 'case-sensitive',
			editorCheckCallback: (checking, editor) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) changeSelectedTextCase(editor, action.mode);
				return true;
			},
		});
	}

	plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, editor) => addChangeCaseMenu(menu, editor)));
}
