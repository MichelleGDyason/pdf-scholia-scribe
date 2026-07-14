import { PluginSettingTab } from 'obsidian';


/**
 * Preserves Obsidian's imperative settings-tab entry point for versions before 1.13.0.
 *
 * The plugin supports Obsidian 1.12.7, where the declarative settings API is unavailable, so a
 * public `display()` method must remain. Concrete tabs keep their complete imperative builder in
 * {@link renderLegacySettings}; this class is not a partial declarative migration and defines no
 * setting definitions. Future settings must continue to use that imperative implementation while
 * this boundary exists. Remove the boundary only after `minAppVersion` reaches 1.13.0 and the full
 * settings tab has been migrated to a complete declarative implementation.
 */
export abstract class LegacyCompatiblePluginSettingTab extends PluginSettingTab {
    /**
     * Runs the concrete tab's existing imperative settings renderer.
     *
     * The hook isolates the non-deprecated implementation from the legacy public `display()`
     * boundary without moving or duplicating any setting definitions, callbacks, or persistence.
     */
    protected abstract renderLegacySettings(): void;

    /**
     * Retains the zero-argument public method invoked by Obsidian 1.12.7.
     *
     * The return and synchronous error behavior come directly from the imperative rendering hook.
     * Obsidian 1.13 also continues to use this path because no partial declarative definitions are
     * supplied.
     */
    display(): void {
        this.renderLegacySettings();
    }

    /**
     * Redispatches through the public `display()` entry point used by existing refresh behavior.
     *
     * Calling the public method deliberately preserves wrappers, patches, test overrides, receiver
     * identity, and synchronous errors instead of bypassing them with a direct hook invocation.
     */
    protected redisplayLegacySettingsCompat(): void {
        this.display();
    }
}
