import { ButtonComponent, requireApiVersion } from 'obsidian';


/**
 * Applies destructive button styling across the plugin's supported Obsidian versions.
 *
 * Obsidian 1.13.0 introduced `setDestructive()`, while the plugin still supports 1.12.7,
 * where `setWarning()` is the available destructive-style API. This Obsidian-specific boundary
 * calls exactly one method and returns the same component so existing button chains keep their
 * receiver, callback timing, and identity. The version guard is the public Obsidian contract that
 * makes the newer method safe to call; review this helper if either method's availability changes.
 * Remove the legacy branch and its file-scoped lint exception once `minAppVersion` reaches 1.13.0.
 */
export function setButtonDestructiveCompat(button: ButtonComponent): ButtonComponent {
    if (requireApiVersion('1.13.0')) {
        return button.setDestructive();
    }
    return button.setWarning();
}
