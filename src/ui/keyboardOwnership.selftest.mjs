import assert from 'node:assert/strict';
import {
  isEditingControl,
  shouldOpenSettingsFromPointerUnlock,
  shouldBlockSettingsHotkey,
} from './keyboardOwnership.js';

const input = { tagName: 'INPUT', isContentEditable: false };
const canvas = { tagName: 'CANVAS', isContentEditable: false };

assert.equal(isEditingControl(input), true, 'chat input owns typed keys');
assert.equal(isEditingControl(canvas), false, 'game canvas does not own typed keys');
assert.equal(shouldOpenSettingsFromPointerUnlock({
  battleActive: true,
  activeElement: canvas,
}), true, 'an unclaimed in-battle unlock retains the Esc-to-settings behavior');
assert.equal(shouldOpenSettingsFromPointerUnlock({
  battleActive: true,
  activeElement: input,
}), false, 'opening chat with Enter must not open settings');
assert.equal(shouldOpenSettingsFromPointerUnlock({
  battleActive: true,
  replayActive: true,
  activeElement: canvas,
}), false, 'killcam keeps ownership of its pointer unlock');

// boot-modal r1: settings hotkey ownership vs dialogs / splash / replay
assert.equal(shouldBlockSettingsHotkey({}), false,
  'a plain Esc in garage or battle opens the panel');
assert.equal(shouldBlockSettingsHotkey({ settingsOpen: true }), true,
  'Esc closes the panel instead of re-opening it');
assert.equal(shouldBlockSettingsHotkey({ replayActive: true }), true,
  'killcam owns Escape while the replay runs');
assert.equal(shouldBlockSettingsHotkey({ nativeDialogOpen: true }), true,
  'a native dialog close gesture must not stack this panel beneath it');
assert.equal(shouldBlockSettingsHotkey({ bootSplashPresent: true }), true,
  'the entry-gate dismissal must not land in the garage with settings open');

console.log('keyboardOwnership.selftest: Enter/chat and Esc/settings ownership passed');
