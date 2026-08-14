"use strict";

/**
 * Preload for the startup launcher (electron/launcher.html).
 *
 * Separate from preload.js (which injects the dashboard into the pi-web page)
 * and from extensions-preload.js: this one runs in a local file:// window with
 * contextIsolation on and exposes nothing but the three launcher operations.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piLauncher", {
  /** Installed versions shown on the tiles. @returns {Promise<{piVersion, dshVersion}>} */
  info: () => ipcRenderer.invoke("pi-web-desktop:launch-info"),
  /**
   * Start one runtime.
   * @param {"pi"|"dsh"} target
   * @param {boolean} remember persist as the default and stop asking
   */
  choose: (target, remember) => ipcRenderer.send("pi-web-desktop:launch-choose", target, Boolean(remember)),
  /** Dismiss without launching anything — nothing has started, so the app quits. */
  cancel: () => ipcRenderer.send("pi-web-desktop:launch-cancel"),
});
