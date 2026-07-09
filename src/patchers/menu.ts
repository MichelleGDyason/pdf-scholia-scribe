import { Menu } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';

/**
 * Local shape for Obsidian `Menu` methods patched by this file.
 *
 * The alias exists to avoid broad `any` while still acknowledging that
 * `monkey-around` forwards Obsidian-owned argument lists this plugin does not
 * inspect. Arguments remain `unknown`, and the return type is the chainable
 * `Menu` instance used by Obsidian's menu API.
 */
type MenuPatchMethod = (this: Menu, ...args: unknown[]) => Menu;

/**
 * Adapts `monkey-around`'s untyped original method into a narrow Obsidian Menu
 * method shape.
 *
 * This exists because `monkey-around` exposes patched prototype methods as
 * dynamic values, while this patcher only needs to forward the original
 * Obsidian `Menu` call after recording plugin state. Treating the forwarded
 * arguments as `unknown` is safer than the previous `any[]` spread because
 * future code cannot accidentally read or transform unverified values without
 * narrowing first. The return type stays `Menu` because Obsidian's menu methods
 * are chainable. The assumption is that Obsidian keeps passing the same
 * arguments to `showAtPosition` and `hide`; this helper only forwards them.
 *
 * Future menu patch wrappers should use this helper instead of casting the
 * original method directly, keeping the unsafe boundary small and documented.
 * This is Obsidian-specific and does not describe any PDF.js API.
 */
const asMenuPatchMethod = (method: unknown): MenuPatchMethod => {
    return method as MenuPatchMethod;
};

/**
 * Calls a typed Obsidian Menu patch method while preserving its original `this`
 * value and argument list.
 *
 * `Reflect.apply` is used to avoid the unsafe `Function.call(...args)` pattern
 * that triggered the lint warnings. The return type remains `Menu` because
 * Obsidian's public `Menu` methods are chainable and this patcher makes no
 * runtime decisions from the returned instance.
 */
const callMenuPatchMethod = (method: MenuPatchMethod, menu: Menu, args: unknown[]): Menu => {
    return Reflect.apply(method, menu, args);
};


export const patchMenu = (plugin: PDFPlus) => {
    plugin.register(around(Menu.prototype, {
        showAtPosition(old) {
            const original = asMenuPatchMethod(old);
            return function (this: Menu, ...args: unknown[]) {
                if (plugin.settings.hoverableDropdownMenuInToolbar && this.parentEl?.closest('div.pdf-toolbar')) {
                    this.setUseNativeMenu(false);
                }
                plugin.shownMenus.add(this);
                return callMenuPatchMethod(original, this, args);
            };
        },
        hide(old) {
            const original = asMenuPatchMethod(old);
            return function (this: Menu, ...args: unknown[]) {
                plugin.shownMenus.delete(this);
                return callMenuPatchMethod(original, this, args);
            };
        }
    }));
};
