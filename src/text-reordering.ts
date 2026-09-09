import { Editor, Menu } from 'obsidian';

import type PDFPlus from 'main';
import { MoveDirection, planParagraphMove } from 'text-reordering-core';

function selectedLineRange(editor: Editor) {
	const from = editor.getCursor('from');
	const to = editor.getCursor('to');
	return {
		start: from.line,
		end: to.line > from.line && to.ch === 0 ? to.line - 1 : to.line,
	};
}

function canMoveLine(editor: Editor, direction: MoveDirection) {
	const range = selectedLineRange(editor);
	return direction === 'up' ? range.start > 0 : range.end < editor.lineCount() - 1;
}

function moveLine(editor: Editor, direction: MoveDirection) {
	if (!canMoveLine(editor, direction)) return;
	editor.exec(direction === 'up' ? 'swapLineUp' : 'swapLineDown');
}

function moveParagraph(editor: Editor, direction: MoveDirection) {
	const lines = Array.from({ length: editor.lineCount() }, (_, line) => editor.getLine(line));
	const selected = selectedLineRange(editor);
	const move = planParagraphMove(lines, selected.start, selected.end, direction);
	if (!move) return;

	const anchor = editor.getCursor('anchor');
	const head = editor.getCursor('head');
	const to = move.regionEnd + 1 < editor.lineCount()
		? { line: move.regionEnd + 1, ch: 0 }
		: { line: move.regionEnd, ch: editor.getLine(move.regionEnd).length };
	const replacement = `${move.replacement.join('\n')}${to.ch === 0 ? '\n' : ''}`;

	editor.transaction({
		changes: [{ from: { line: move.regionStart, ch: 0 }, to, text: replacement }],
	});
	editor.setSelection(
		{ line: anchor.line + move.lineDelta, ch: anchor.ch },
		{ line: head.line + move.lineDelta, ch: head.ch },
	);
	editor.focus();
}

function addReorderMenu(menu: Menu, editor: Editor) {
	menu.addItem((item) => {
		item.setTitle('Reorder text').setIcon('arrow-up-down');
		const submenu = item.setSubmenu();
		submenu.addItem((child) => child.setTitle('Move line/selection up').setIcon('arrow-up').onClick(() => moveLine(editor, 'up')));
		submenu.addItem((child) => child.setTitle('Move line/selection down').setIcon('arrow-down').onClick(() => moveLine(editor, 'down')));
		submenu.addSeparator();
		submenu.addItem((child) => child.setTitle('Move paragraph/block up').setIcon('chevrons-up').onClick(() => moveParagraph(editor, 'up')));
		submenu.addItem((child) => child.setTitle('Move paragraph/block down').setIcon('chevrons-down').onClick(() => moveParagraph(editor, 'down')));
	});
}

export function registerTextReordering(plugin: PDFPlus) {
	const commands = [
		{ id: 'move-line-selection-up', name: 'Move line or selection up', icon: 'arrow-up', run: (editor: Editor) => moveLine(editor, 'up') },
		{ id: 'move-line-selection-down', name: 'Move line or selection down', icon: 'arrow-down', run: (editor: Editor) => moveLine(editor, 'down') },
		{ id: 'move-paragraph-block-up', name: 'Move paragraph or block up', icon: 'chevrons-up', run: (editor: Editor) => moveParagraph(editor, 'up') },
		{ id: 'move-paragraph-block-down', name: 'Move paragraph or block down', icon: 'chevrons-down', run: (editor: Editor) => moveParagraph(editor, 'down') },
	];
	for (const command of commands) {
		plugin.addCommand({
			id: command.id,
			name: command.name,
			icon: command.icon,
			editorCallback: (editor) => command.run(editor),
		});
	}

	plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, editor) => addReorderMenu(menu, editor)));
}
