"use strict";

/**
 * Directory picker — backend for the `window.piDesktop.selectDirectory()`
 * bridge that pi-web's session sidebar calls when the user clicks the
 * custom-path button in a desktop build (upstream pi-web v0.7.13, commit
 * 0fa4c43 "feat: support desktop directory picker"; without the bridge the
 * sidebar falls back to manual path input).
 *
 * Contract (declared in pi-web's components/SessionSidebar.tsx):
 *   selectDirectory(): Promise<string | null>
 * — resolves to the chosen absolute path, or null when the user cancels. A
 * rejection is also handled upstream (the sidebar shows the error and opens
 * the manual input), so errors may propagate.
 */

const { dialog } = require("electron");

/**
 * Open a native "choose a folder" dialog.
 * @param {import("electron").BrowserWindow | null} parent window the dialog is
 *   attached to (modal on Windows/Linux); falls back to unparented when null.
 * @returns {Promise<string | null>} the selected directory, or null on cancel.
 */
async function selectDirectory(parent) {
  const opts = {
    title: "选择工作目录",
    properties: ["openDirectory"],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}

module.exports = { selectDirectory };
