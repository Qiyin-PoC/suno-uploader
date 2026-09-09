const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("gaobai", {
  getSunoDownloadState: () => ipcRenderer.invoke("suno-download:state"),
  startSunoDownload: (payload) => ipcRenderer.invoke("suno-download:start", payload),
  cancelSunoDownload: (taskId) => ipcRenderer.invoke("suno-download:cancel", taskId),
  pickSunoDownloadDirectory: () => ipcRenderer.invoke("suno-download:pick-directory"),
  revealSunoDownload: () => ipcRenderer.invoke("suno-download:reveal"),
  onSunoDownloadEvent: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("suno-download:event", listener);
    return () => ipcRenderer.removeListener("suno-download:event", listener);
  },
  commercialPlans: () => ipcRenderer.invoke('commercial:plans'),
  commercialOrder: payload => ipcRenderer.invoke('commercial:order', payload),
  commercialOrderStatus: id => ipcRenderer.invoke('commercial:order-status', id),
  onCommercialEvent: handler => {
    const listener = (_event, result) => handler(result);
    ipcRenderer.on('commercial:event', listener);
    return () => ipcRenderer.removeListener('commercial:event', listener);
  },
  onCommercialOpen: handler => {
    const listener = () => handler();
    ipcRenderer.on('commercial:open', listener);
    return () => ipcRenderer.removeListener('commercial:open', listener);
  },
  pickAudio: () => ipcRenderer.invoke("audio:pick"),
  pickAudios: () => ipcRenderer.invoke("audio:pick-multiple"),
  getSunoAccounts: () => ipcRenderer.invoke("suno:accounts"),
  selectSunoAccount: id => ipcRenderer.invoke("suno:select-account", id),
  startSunoExtension: () => ipcRenderer.invoke("suno:extension-start"),
  cancelSunoExtension: () => ipcRenderer.invoke("suno:extension-cancel"),
  openSunoExtensionFolder: () => ipcRenderer.invoke("suno:extension-folder"),
  onSunoAccounts: callback => { const handler=(_event,data)=>callback(data); ipcRenderer.on("suno:accounts-event",handler); return ()=>ipcRenderer.removeListener("suno:accounts-event",handler); },
  login: () => ipcRenderer.invoke("app:login"),
  logout: () => ipcRenderer.invoke("app:logout"),
  startUpload: (payload) => ipcRenderer.invoke("upload:start", payload),
  getUploadBatchState: () => ipcRenderer.invoke("upload:batch-state"),
  saveUploadBatch: (payload) => ipcRenderer.invoke("upload:batch-save", payload || {}),
  startUploadBatch: (payload) => ipcRenderer.invoke("upload:batch-start", payload || {}),
  pauseUploadBatch: () => ipcRenderer.invoke("upload:batch-pause"),
  resumeUploadBatch: () => ipcRenderer.invoke("upload:batch-resume"),
  retryUploadBatchItem: (itemId) => ipcRenderer.invoke("upload:batch-retry-item", { itemId: itemId || "" }),
  cancelUploadBatch: () => ipcRenderer.invoke("upload:batch-cancel"),
  stopJob: () => ipcRenderer.invoke("job:stop"),
  clearSegments: (workDir) => ipcRenderer.invoke("upload:clear-segments", { workDir: workDir || "" }),
  listHistory: () => ipcRenderer.invoke("history:list"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  processLyrics: (payload) => ipcRenderer.invoke("lyrics:process", payload),
  startSeparation: (payload) => ipcRenderer.invoke("separation:start", payload),
  cancelSeparation: () => ipcRenderer.invoke("separation:cancel"),
  listSeparationModels: () => ipcRenderer.invoke("separation:models"),
  downloadSeparationModel: (payload) => ipcRenderer.invoke("separation:download-model", payload),
  listSeparationDevices: () => ipcRenderer.invoke("separation:devices"),
  installSeparationGpuRuntime: () => ipcRenderer.invoke("separation:install-gpu-runtime"),
  readAudioFile: (filePath) => ipcRenderer.invoke("audio:read-file", filePath),
  fileExists: (filePath) => ipcRenderer.invoke("file:exists", filePath),
  fileUrl: (filePath) => ipcRenderer.invoke("file:url", filePath),
  soundTouchModuleUrl: () => ipcRenderer.invoke("soundtouch:module-url"),
  soundTouchProcessorUrl: () => ipcRenderer.invoke("soundtouch:processor-url"),
  soundTouchProcessorSource: () => ipcRenderer.invoke("soundtouch:processor-source"),
  exportClip: (payload) => ipcRenderer.invoke("editor:export", payload),
  exportProject: (payload) => ipcRenderer.invoke("editor:export-project", payload),
  cancelEditor: () => ipcRenderer.invoke("editor:cancel"),
  previewWindow: (payload) => ipcRenderer.invoke("editor:preview-window", payload),
  detectEditorBpm: (sourcePath) => ipcRenderer.invoke("editor:detect-bpm", { sourcePath }),
  saveCopy: (payload) => ipcRenderer.invoke("file:save-copy", payload),
  getWorkspacePaths: () => ipcRenderer.invoke("workspace:get-paths"),
  pickWorkspacePath: (kind) => ipcRenderer.invoke("workspace:pick-path", { kind }),
  openUrl: (url) => ipcRenderer.invoke("open:url", url),
  openPath: (targetPath) => ipcRenderer.invoke("open:path", targetPath),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  forceQuit: () => ipcRenderer.invoke("app:force-quit"),
  showAbout: () => ipcRenderer.invoke("app:showAbout"),
  showSettings: () => ipcRenderer.invoke("app:showSettings"),
  getClosePrefs: () => ipcRenderer.invoke("prefs:get-close"),
  setClosePrefs: (payload) => ipcRenderer.invoke("prefs:set-close", payload),
  checkLoginStatus: () => ipcRenderer.invoke("app:check-login-status"),
  accountLogin: () => ipcRenderer.invoke("account:login"),
  accountSubmitLogin: (payload) => ipcRenderer.invoke("account:submit-login", payload || {}),
  accountLoginPreferences: () => ipcRenderer.invoke("account:login-preferences"),
  accountSendEmailCode: (payload) => ipcRenderer.invoke("account:send-email-code", payload || {}),
  accountRegister: (payload) => ipcRenderer.invoke("account:register", payload || {}),
  accountResetPassword: (payload) => ipcRenderer.invoke("account:reset-password", payload || {}),
  accountStatus: () => ipcRenderer.invoke("account:status"),
  accountAvatarSource: (url) => ipcRenderer.invoke("account:avatar-source", { url: url || "" }),
  accountLogout: () => ipcRenderer.invoke("account:logout"),
  accountDevices: () => ipcRenderer.invoke("account:devices"),
  accountUnbindDevice: (devicePublicId) => ipcRenderer.invoke("account:unbind-device", { devicePublicId }),
  openAccountProfile: () => ipcRenderer.invoke("account:open-profile"),
  openAccountStore: () => ipcRenderer.invoke("account:open-store"),
  checkLicense: () => ipcRenderer.invoke("license:check"),
  licenseStatus: () => ipcRenderer.invoke("license:status"),
  // 启动核对：客户端启动时调用，与服务端做权威授权核对
  startupVerifyLicense: () => ipcRenderer.invoke("license:startup-verify"),
  // 更新检查 / 系统公告
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  listAnnouncements: (payload) => ipcRenderer.invoke("announcements:list", payload || {}),
  markAnnouncementsRead: (ids) => ipcRenderer.invoke("announcements:mark-read", { ids: ids || [] }),
  registerApp: () => ipcRenderer.invoke("app:register"),
  markUpdateSeen: (version) => ipcRenderer.invoke("update:mark-seen", { version: version || "" }),
  getUnlockerPrefs: () => ipcRenderer.invoke("unlocker:get-prefs"),
  onBackendEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("backend:event", listener);
    return () => ipcRenderer.removeListener("backend:event", listener);
  },
  onUploadBatchEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("upload:batch-event", listener);
    return () => ipcRenderer.removeListener("upload:batch-event", listener);
  },
  onSeparationEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("separation:event", listener);
    return () => ipcRenderer.removeListener("separation:event", listener);
  },
  onEditorEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("editor:event", listener);
    return () => ipcRenderer.removeListener("editor:event", listener);
  },
  onAccountEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("account:event", listener);
    return () => ipcRenderer.removeListener("account:event", listener);
  },
  onClosePrefsUpdated: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("prefs:close-updated", listener);
    return () => ipcRenderer.removeListener("prefs:close-updated", listener);
  },
  // ── MMKV 智能定位 ──
  mmkv: {
    locate: (opts) => ipcRenderer.invoke("mmkv:locate", opts || {}),
    link: (originalPath) => ipcRenderer.invoke("mmkv:link", { originalPath }),
    list: () => ipcRenderer.invoke("mmkv:list"),
    status: () => ipcRenderer.invoke("mmkv:status"),
    unlink: () => ipcRenderer.invoke("mmkv:unlink"),
    setOnboardingState: (payload) => ipcRenderer.invoke("mmkv:set-onboarding-state", payload || {}),
  },
  onMmkvOnboardingRequest: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("mmkv:onboarding-request", listener);
    return () => ipcRenderer.removeListener("mmkv:onboarding-request", listener);
  },
  onMmkvFailRequest: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("mmkv:fail-request", listener);
    return () => ipcRenderer.removeListener("mmkv:fail-request", listener);
  },
  // ── 健康检查(解码器鲁棒性) ──
  selfcheck: {
    run: () => ipcRenderer.invoke("selfcheck:run"),
    fix: (payload) => ipcRenderer.invoke("selfcheck:fix", payload || {}),
  },
});

contextBridge.exposeInMainWorld("unlocker", {
  pickFiles: () => ipcRenderer.invoke("unlocker:pickFiles"),
  pickFolder: () => ipcRenderer.invoke("unlocker:pickFolder"),
  pickOutputDir: () => ipcRenderer.invoke("unlocker:pickOutputDir"),
  pickMmkv: () => ipcRenderer.invoke("unlocker:pickMmkv"),
  scanFolder: (folderPath) => ipcRenderer.invoke("unlocker:scan-folder", folderPath),
  start: (payload) => ipcRenderer.invoke("unlocker:start", payload),
  umStart: (payload) => ipcRenderer.invoke("unlocker:um-start", payload),
  cancel: () => ipcRenderer.invoke("unlocker:cancel"),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("unlocker:event", listener);
    return () => ipcRenderer.removeListener("unlocker:event", listener);
  }
});

// 别名：把同一组接口以 “音频格式转换” 命名空间再暴露一次
contextBridge.exposeInMainWorld("converter", {
  pickFiles: () => ipcRenderer.invoke("unlocker:pickFiles"),
  pickFolder: () => ipcRenderer.invoke("unlocker:pickFolder"),
  pickOutputDir: () => ipcRenderer.invoke("unlocker:pickOutputDir"),
  pickMmkv: () => ipcRenderer.invoke("unlocker:pickMmkv"),
  scanFolder: (folderPath) => ipcRenderer.invoke("unlocker:scan-folder", folderPath),
  start: (payload) => ipcRenderer.invoke("unlocker:start", payload),
  umStart: (payload) => ipcRenderer.invoke("unlocker:um-start", payload),
  cancel: () => ipcRenderer.invoke("unlocker:cancel"),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("unlocker:event", listener);
    return () => ipcRenderer.removeListener("unlocker:event", listener);
  }
});

// Electron 32+ 移除了 File.path，改用 webUtils.getPathForFile 获取拖入文件的真实路径
contextBridge.exposeInMainWorld("getPathForFile", (file) => {
  try {
    if (!file) return "";
    if (typeof webUtils?.getPathForFile === "function") return webUtils.getPathForFile(file);
  } catch (_) {}
  return (file && file.path) || "";
});
