"use strict";

/**
 * Preload for the extension picker window (electron/extensions-picker.html).
 *
 * Kept separate from the main preload.js (which injects the dashboard into the
 * pi-web page): this one runs in a local file:// window with contextIsolation
 * on, and exposes nothing but the four picker operations.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piExt", {
  /** @returns {Promise<{ok, firstRun, destDir, extensions: Array}>} */
  load: () => ipcRenderer.invoke("pi-web-desktop:ext-status"),
  /** @param {string[]} ids ids to keep/install; everything else is disabled */
  apply: (ids) => ipcRenderer.invoke("pi-web-desktop:ext-apply", ids),
  /** Overwrite one deployed extension with the bundled version (backs up first). */
  restore: (id) => ipcRenderer.invoke("pi-web-desktop:ext-restore", id),
  /** Reveal ~/.pi/agent/extensions in the OS file manager. */
  openFolder: () => ipcRenderer.invoke("pi-web-desktop:ext-open-folder"),
  /** Dismiss without applying anything. */
  cancel: () => ipcRenderer.send("pi-web-desktop:ext-cancel"),
});
