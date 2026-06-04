"use strict";

const { contextBridge } = require("electron");

// Minimal, safe surface exposed to the pi-web frontend. We intentionally expose
// almost nothing — pi-web talks to its own Next.js API over localhost, so it
// needs no privileged bridge. This is here for future use and to keep
// contextIsolation on with a defined boundary.
contextBridge.exposeInMainWorld("piWebDesktop", {
  isDesktop: true,
  platform: process.platform,
});
