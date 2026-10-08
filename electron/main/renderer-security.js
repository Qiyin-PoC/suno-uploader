const path = require('node:path');
const { fileURLToPath } = require('node:url');

function isRendererDocument(value, rendererFile) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.username || url.password) return false;
    const normalize = file => {
      const absolute = path.resolve(file);
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    };
    return normalize(fileURLToPath(url)) === normalize(rendererFile);
  } catch (_) { return false; }
}

function createTrustedIpcMain(ipcMain, getWindow, rendererFile) {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => {
        const window = getWindow();
        const contents = window && !window.isDestroyed() ? window.webContents : null;
        const frame = event?.senderFrame;
        if (!contents || event.sender !== contents || !frame || frame !== contents.mainFrame
            || !isRendererDocument(frame.url, rendererFile)) {
          throw new Error('untrusted_ipc_sender');
        }
        return handler(event, ...args);
      });
    },
  };
}

function hardenMainWindow(window, rendererFile) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNavigation = (event, target) => {
    if (!isRendererDocument(target, rendererFile)) event.preventDefault();
  };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    return url.href;
  } catch (_) { return ''; }
}

module.exports = { createTrustedIpcMain, hardenMainWindow, safeExternalUrl, isRendererDocument };
