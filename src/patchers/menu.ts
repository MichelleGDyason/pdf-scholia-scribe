import { Menu } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { asPatchedMethod, callPatchedMethod, type PatchedMethod } from 'lib/patch-utils';

/**
 * Local shape for Obsidian `Menu` methods patched by this file.
 *
 * The alias exists to avoid broad `any` while still acknowledging that
 * `monkey-around` forwards Obsidian-owned argument lists this plugin does not
 * inspect. Arguments remain `unknown`, and the return type is the chainable
 * `Menu` instance used by Obsidian's menu API.
 */
type MenuPatchMethod = PatchedMethod<Menu, unknown[], Menu>;


export const patchMenu = (plugin: PDFPlus) => {
    plugin.register(around(Menu.prototype, {
        showAtPosition(old) {
            const original: MenuPatchMethod = asPatchedMethod(old);
            return function (this: Menu, ...args: unknown[]) {
                if (plugin.settings.hoverableDropdownMenuInToolbar && this.parentEl?.closest('div.pdf-toolbar')) {
                    this.setUseNativeMenu(false);
                }
                plugin.shownMenus.add(this);
                return callPatchedMethod(original, this, args);
            };
        },
        hide(old) {
            const original: MenuPatchMethod = asPatchedMethod(old);
            return function (this: Menu, ...args: unknown[]) {
                plugin.shownMenus.delete(this);
                return callPatchedMethod(original, this, args);
            };
        }
    }));
};
