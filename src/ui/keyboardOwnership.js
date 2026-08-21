/** True when a focused DOM node owns typed keyboard input. */
export function isEditingControl(target) {
  return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' || target.isContentEditable);
}

/**
 * Pointer lock normally disappears because the browser consumed Escape. Text
 * editors are the exception: chat deliberately unlocks while retaining focus.
 */
export function shouldOpenSettingsFromPointerUnlock({
  pointerLocked = false,
  settingsOpen = false,
  battleActive = false,
  replayActive = false,
  activeElement = null,
} = {}) {
  return !pointerLocked && !settingsOpen && battleActive && !replayActive &&
    !isEditingControl(activeElement);
}

/**
 * True when the settings-menu hotkey (Esc / pad START) must be ignored
 * because another surface owns the screen.
 *
 * - A native `<dialog>` (splash credits, gallery archive, studio export)
 *   consumes Escape as its own close gesture, but the keydown still bubbles
 *   to window — honoring it here stacked this panel underneath the dialog.
 * - While the boot splash / entry gate is up, the gate-dismissing keypress
 *   would otherwise drop the player into a fresh garage with this panel open.
 * - A kill-cam replay owns every key while it runs; the done-grace is handled
 *   by the caller (KC_DONE_GRACE_MS).
 */
export function shouldBlockSettingsHotkey({
  settingsOpen = false,
  replayActive = false,
  nativeDialogOpen = false,
  bootSplashPresent = false,
} = {}) {
  return settingsOpen || replayActive || nativeDialogOpen || bootSplashPresent;
}
