const DAW_TRACK_HEADER_WIDTH = 204;
const DAW_TRACK_DEFAULT_HEIGHT = 82;
const DAW_TRACK_MIN_HEIGHT = 64;
const DAW_TRACK_MAX_HEIGHT = 220;
const DAW_ZOOM_MIN = 0.5;
const DAW_ZOOM_MAX = 8;
const ACCOUNT_AVATAR_CACHE_KEY = "qiyin-account-avatar-v2";

const state = {
  audioPath: "",
  editorAudioPath: "",
  editorOutputPath: "",
  editorOutputDir: "",
  editorDuration: 0,
  waveformPeaks: [],
  waveformAllPeaks: [],   // 完整高精度波形数据（用于缩放）
  waveformZoom: 1,       // 波形缩放级别 (1=适应, >1放大)
  waveformScroll: 0,     // 波形水平滚动偏移 (0~1)
  separationAudioPath: "",
  separationOutputDir: "",
  separationModels: [],
  selectedSeparationModel: "4_HP-Vocal-UVR.pth",
  separationDeviceMode: ["auto", "cuda", "cpu"].includes(localStorage.getItem("qiyin-separation-device"))
    ? localStorage.getItem("qiyin-separation-device")
    : "auto",
  separationDevices: { controllers: [], hasNvidiaGpu: false, gpuRuntimeInstalled: false },
  vocalsPath: "",
  instrumentalPath: "",
  speed: "onbeat2x",
  uploadType: "single",
  batchQueue: {
    status: "idle",
    currentItemId: "",
    items: [],
  },
  lastUrl: "",
  uploadWorkDir: "",
  uploadSegmentsDir: "",
  uploadAdjustmentAttempt: 1,
  uploadEtaTargetAt: 0,
  uploadEtaPhase: "",
  uploadEtaTimer: null,
  uploadMetrics: { total: 0, submitted: 0, done: 0, elapsed: 0, finished: false },
  busy: false,
  theme: "light",
  // 内部使用版：授权恒为有效（永久），不再依赖官网账号/激活/软件锁
  licenseValid: true,
  licenseReasonCode: "internal_permanent",
  licenseCountdown: "永久",
  licenseExpiresAt: null,
  licenseTimer: null,
  licenseExpiryCheckInFlight: false,
  licenseExpiryCheckDoneFor: "",
  account: { loggedIn: false, valid: false },
  pitchSemitones: 0,
  pitchCents: 0,
  tempoRatio: 1,
  editorBusy: false,
  historyItems: [],
  historyFilter: "all",
  timelineDrag: null,
  timelineViewDrag: null,
  editorCursor: 0,
  editorTool: "cursor",
  editorGrid: { bpm: 120, unit: "beat", snap: true },
  editorSelectionDrag: null,
  editorSegments: [],
  editorSegmentMode: false,
  dawTracks: [],
  dawSelectedTrackId: "",
  dawSelectedClipId: "",
  dawUndoStack: [],
  dawDrag: null,
  dawClipTrim: null,
  dawZoom: 1,
  dawPlayhead: 0,
  dawRulerMode: localStorage.getItem("qiyin-daw-ruler") === "bars" ? "bars" : "time",
  dawSelection: null,
  dawSelectionDrag: null,
  dawSelectionResize: null,
  dawPlayheadDrag: null,
  dawExportMarkerDrag: null,
  dawExportRange: null,
  dawAutoScrollPointer: null,
  dawAutoScrollRaf: null,
  dawAutoScrollLastAt: 0,
  dawTrackResize: null,
  dawBpmDetectionSeq: 0,
  dawContextClipId: "",
  dawPlaying: false,
  dawStartedAt: 0,
  dawStartPosition: 0,
  dawSources: [],
  dawTrackNodes: new Map(),
  dawRaf: null,
  dawAudioContext: null,
  dawBufferCache: new Map(),
  dawExportCache: new Map(),
  dawExporting: false,
  dawExportNoticeTimer: null,
  dawExportDialogAction: "",
  accountAvatarIdentity: "",
  accountAvatarUrl: "",
  accountAvatarSeq: 0,
  workspacePaths: { editorExportDir: "", sunoWorkDir: "" },
  editorUndoDomain: "clip",
  stemAudio: null,
  stemAudioKind: "",
  stemWaveformPeaks: { instrumental: [], vocals: [] },
  stemDuration: { instrumental: 0, vocals: 0 },
  undoStack: [],  // 剪辑撤回栈，支持多次撤回
  editorAudioBuffer: null,  // Web Audio API 缓存的 AudioBuffer
  audioContext: null,       // AudioContext 实例（实时渲染用）
  realtimeSource: null,     // 当前实时预览 WebAudio 音源（必须单实例）
  realtimeStartedAt: 0,
  realtimeOffset: 0,
  realtimePlaying: false,
  realtimeGain: null,
  realtimeSoundTouch: null,
  realtimeStarting: false,
  soundTouchNodeClass: null,
  soundTouchRegistered: false,
  soundTouchLoadFailed: false,
  soundTouchProcessorBlobUrl: "",
  soundTouchUnderrunWarned: false,
  realtimeRAF: null,
  previewStopHandler: null,
  suppressEditorPauseHandler: false,
  processedPreviewTimer: null,
  processedPreviewProgressTimer: null,
  processedPreviewStartedAt: 0,
  processedPreviewProgress: 0,
  processedPreviewSeq: 0,
  processedPreviewBusy: false,
  processedPreviewReadyKey: "",
  processedPreviewClipStart: 0,
  processedPreviewClipEnd: 0,
  processedPreviewTempo: 1,
  virtualPlaying: false,
  virtualStartedAt: 0,
  virtualStartTime: 0,
  virtualClockTempo: 1,
  previewWindowStart: 0,
  previewWindowEnd: 0,
  previewRenderSeq: 0,
  previewRenderBusy: false,
  previewRenderTimer: null,
  previewPendingKey: "",
  previewActiveRenderKey: "",
  previewFadeTimer: null,
  previewUsingRendered: false,
  previewParamsKey: "",
  previewLoggedFallback: false
};

const $ = (id) => document.getElementById(id);
const APP_VERSION = "V5.0.0";
const THEME_STORAGE_KEY = "qiyin-theme";
const SEPARATION_DEVICE_STORAGE_KEY = "qiyin-separation-device";
const LICENSE_REQUIRED_MESSAGE = "：请登录官网账号并同步软件权益后使用。";
const OPEN_AUDIO_PATTERN = /\.(mp3|wav|m4a|flac|aac|ogg|oga|opus|ape|wma|alac|mp4)$/i;
const UNLOCKER_SUPPORTED_EXTS = [
  // 酷狗系列
  ".kgm", ".kgma", ".vpr", ".kgg", ".kgm.flac", ".vpr.flac",
  // 网易 / QQ / 全民 K 歌 / 汽水 等
  ".ncm", ".uc", ".cache", ".qmccache", ".qmc0", ".qmc2", ".qmc3", ".qmc4", ".qmc6", ".qmc8",
  ".qmcflac", ".qmcogg", ".qmcra", ".qmcwma", ".tkm", ".bkcmp3", ".bkcm4a", ".bkcflac",
  ".bkcwav", ".bkcape", ".bkcogg", ".bkcwma", ".mmp4",
  // QQ 音乐 v2 / MusicEx 系列
  ".mflac", ".mgg", ".mflac0", ".mflac1", ".mflaca", ".mflach", ".mflacl", ".mflacm",
  ".mgg0", ".mgg1", ".mgha", ".mggh", ".mggl", ".mggm",
  // 微云 hex 命名
  ".666c6163", ".6d7033", ".6f6767", ".6d3461", ".776176",
  // JOOX / 虾米 / 喜马拉雅
  ".ofl_en", ".joox", ".xm", ".wav.xm", ".mp3.xm", ".flac.xm", ".m4a.xm", ".x2m", ".x3m",
  // 酷我 / QQ iOS
  ".kwm", ".tm0", ".tm2", ".tm3", ".tm6",
  // 咪咕
  ".mg3d",
  // 视频容器（抽音轨，ffmpeg 自动处理）
  ".mp4",
  // 开放音频格式（用户直接转码）
  ".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".alac", ".ape", ".wma", ".dff"
];
const PROTECTED_DIAGNOSTIC_EXTS = new Set([
  ".kgm", ".kgma", ".vpr", ".kgg", ".kgm.flac", ".vpr.flac",
  ".ncm", ".uc", ".cache", ".qmccache", ".qmc0", ".qmc2", ".qmc3", ".qmc4", ".qmc6", ".qmc8",
  ".qmcflac", ".qmcogg", ".qmcra", ".qmcwma", ".tkm", ".bkcmp3", ".bkcm4a", ".bkcflac",
  ".bkcwav", ".bkcape", ".bkcogg", ".bkcwma", ".mmp4",
  ".mflac", ".mgg", ".mflac0", ".mflac1", ".mflaca", ".mflach", ".mflacl", ".mflacm",
  ".mgg0", ".mgg1", ".mgha", ".mggh", ".mggl", ".mggm",
  ".ofl_en", ".joox", ".xm", ".wav.xm", ".mp3.xm", ".flac.xm", ".m4a.xm", ".x2m", ".x3m",
  ".kwm", ".tm0", ".tm2", ".tm3", ".tm6", ".mg3d",
]);

function loadSavedTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "dark" ? "dark" : "light";
  } catch (_) {
    return "light";
  }
}

function applyTheme(theme, persist = true) {
  const next = theme === "dark" ? "dark" : "light";
  state.theme = next;
  document.documentElement.setAttribute("data-theme", next);
  document.documentElement.style.colorScheme = next;
  if (persist) {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch (_) {}
  }
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  drawWaveform();
  drawMiniWaveform();
  renderDawProject();
}

applyTheme(loadSavedTheme(), false);

function setupThemeControls() {
  const settingsButton = $("themeSettingsBtn");
  const popover = $("themePopover");
  if (!settingsButton || !popover) return;

  const setOpen = (open) => {
    popover.classList.toggle("hidden", !open);
    settingsButton.setAttribute("aria-expanded", String(open));
  };

  settingsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(popover.classList.contains("hidden"));
  });
  popover.addEventListener("click", (event) => event.stopPropagation());
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
  });
  setupTaskSoundControls();
  $("closeBehaviorSettingsBtn")?.addEventListener("click", () => {
    setOpen(false);
    window.gaobai.showSettings?.();
  });
  $("chooseEditorExportPathBtn")?.addEventListener("click", async () => {
    const result = await window.gaobai.pickWorkspacePath?.("editor");
    if (result?.ok) updateWorkspacePathLabels(result);
  });
  $("chooseSunoWorkPathBtn")?.addEventListener("click", async () => {
    const result = await window.gaobai.pickWorkspacePath?.("suno");
    if (result?.ok) updateWorkspacePathLabels(result);
  });
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
  applyTheme(state.theme, false);
  refreshWorkspacePathSettings();
}

function updateWorkspacePathLabels(paths = {}) {
  state.workspacePaths = {
    editorExportDir: paths.editorExportDir || state.workspacePaths.editorExportDir || "",
    sunoWorkDir: paths.sunoWorkDir || state.workspacePaths.sunoWorkDir || "",
  };
  const editorLabel = $("editorExportPathLabel");
  const sunoLabel = $("sunoWorkPathLabel");
  if (editorLabel) {
    editorLabel.textContent = state.workspacePaths.editorExportDir || "使用默认目录";
    editorLabel.title = state.workspacePaths.editorExportDir || "";
  }
  if (sunoLabel) {
    sunoLabel.textContent = state.workspacePaths.sunoWorkDir || "使用默认目录";
    sunoLabel.title = state.workspacePaths.sunoWorkDir || "";
  }
}

async function refreshWorkspacePathSettings() {
  try {
    const result = await window.gaobai.getWorkspacePaths?.();
    if (result?.ok) updateWorkspacePathLabels(result);
  } catch (error) {
    log(`读取保存目录失败：${error.message}`);
  }
}

function unlockerExtension(filePath) {
  const name = basename(filePath).toLowerCase();
  for (const compound of [".wav.xm", ".mp3.xm", ".flac.xm"]) {
    if (name.endsWith(compound)) return compound;
  }
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function basename(filePath) {
  if (!filePath) return "";
  return filePath.split(/[\\/]/).pop();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function editorRealtimeParams() {
  const semitones = state.pitchSemitones || 0;
  const cents = state.pitchCents || 0;
  const totalCents = semitones * 100 + cents;
  const tempo = state.tempoRatio || 1;
  const volume = clamp(Number($("volumeInput")?.value) || 1, 0, 3);
  const active = Math.abs(totalCents) >= 1 || Math.abs(tempo - 1) >= 0.001 || Math.abs(volume - 1) >= 0.001;
  return { totalCents, totalSemitones: totalCents / 100, tempo, volume, active };
}

function parseTimeInput(value, fallback = 0) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const normalized = raw.replace(/：/g, ":");
  const barMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:b|bar|小节)$/i);
  if (barMatch) {
    const bars = Number(barMatch[1]);
    const bpm = clamp(Number(state.editorGrid?.bpm) || 120, 40, 260);
    return Number.isFinite(bars) ? Math.max(0, bars - 1) * (60 / bpm) * 4 : fallback;
  }
  if (!normalized.includes(":")) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? seconds : fallback;
  }

  const parts = normalized.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) {
    return fallback;
  }
  const nums = parts.map(Number);
  if (nums.some((num) => !Number.isFinite(num) || num < 0)) return fallback;

  if (nums.length === 2) {
    return nums[0] * 60 + nums[1];
  }
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

function saveEditorPrefs() {
  try {
    localStorage.setItem("gaobai-editor-prefs", JSON.stringify({
      pitch: state.pitchSemitones,
      cents: state.pitchCents,
      tempo: state.tempoRatio,
      fadeIn: $("fadeInInput").value,
      fadeOut: $("fadeOutInput").value,
      volume: $("volumeInput").value,
      editorBpm: state.editorGrid.bpm,
      editorGridUnit: state.editorGrid.unit,
      editorSnap: state.editorGrid.snap
    }));
  } catch (_) { /* ignore */ }
}

function loadEditorPrefs() {
  try {
    const raw = localStorage.getItem("gaobai-editor-prefs");
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if (typeof prefs.pitch === "number") {
      state.pitchSemitones = prefs.pitch;
      $("pitchInput").value = prefs.pitch;
    }
    if (typeof prefs.cents === "number") {
      state.pitchCents = prefs.cents;
      const ci = $("centsInput");
      if (ci) ci.value = prefs.cents;
    }
    if (typeof prefs.tempo === "number") {
      state.tempoRatio = prefs.tempo;
      $("tempoInput").value = prefs.tempo;
      setActiveTempoChip(prefs.tempo);
    }
    if (prefs.fadeIn !== undefined) $("fadeInInput").value = prefs.fadeIn;
    if (prefs.fadeOut !== undefined) $("fadeOutInput").value = prefs.fadeOut;
    if (prefs.volume !== undefined) $("volumeInput").value = prefs.volume;
    if (Number.isFinite(Number(prefs.editorBpm))) {
      state.editorGrid.bpm = clamp(Number(prefs.editorBpm), 40, 260);
      if ($("editorBpmInput")) $("editorBpmInput").value = String(state.editorGrid.bpm);
    }
    if (["bar", "beat", "half", "quarter", "eighth", "time"].includes(prefs.editorGridUnit)) {
      state.editorGrid.unit = prefs.editorGridUnit;
      if ($("editorGridUnit")) $("editorGridUnit").value = state.editorGrid.unit;
    }
    if (typeof prefs.editorSnap === "boolean") {
      state.editorGrid.snap = prefs.editorSnap;
      if ($("editorSnapToggle")) $("editorSnapToggle").checked = prefs.editorSnap;
    }
  } catch (_) { /* ignore */ }
}

function setActiveTempoChip(tempo) {
  document.querySelectorAll(".tempo-chip").forEach((chip) => {
    chip.classList.toggle("active", Math.abs(Number(chip.dataset.tempo) - tempo) < 0.001);
  });
}

function setBusy(busy) {
  state.busy = busy;
  ["sunoAccountSelect","sunoExtensionBtn","logoutBtn"].forEach(id=>{if($(id))$(id).disabled=busy;});
  const blocked = !state.licenseValid;
  $("startBtn").disabled = busy || blocked;
  $("loginBtn").disabled = busy;
  $("pickBtn").disabled = busy || blocked;
  $("stopBtn").disabled = !busy;
  updateUploadAudioButtons();
  updateBatchQueueControls();
  // 任务结束（busy 从 true 变 false）→ 清掉顶部任务标签，把主状态恢复为"准备就绪"
  if (!busy && state.taskWasBusy) {
    state.taskWasBusy = false;
    clearTaskPill();
    $("mainStatus").textContent = "准备就绪";
  }
  if (busy) {
    state.taskWasBusy = true;
  }
}

function updateUploadAudioButtons() {
  if ($("clearAudioBtn")) $("clearAudioBtn").disabled = state.busy || !state.audioPath;
  if ($("removeAudioBtn")) $("removeAudioBtn").disabled = state.busy || !state.audioPath;
  if ($("openSegmentsBtn")) $("openSegmentsBtn").disabled = !state.uploadSegmentsDir && !state.uploadWorkDir;
  if ($("clearSegmentsBtn")) $("clearSegmentsBtn").disabled = state.busy || (!state.uploadSegmentsDir && !state.uploadWorkDir);
  const dropCard = $("uploadDropArea");
  if (dropCard) dropCard.classList.toggle("has-audio", !!state.audioPath);
}

function setStatus(text, pill = "", pillKind = "running") {
  // 1) 更新页面中部主状态标题
  $("mainStatus").textContent = text;
  // 2) 把"任务状态"小标签设置到 statusPill 内部新增的 #taskPill，
  //    而**不再覆盖** statusPill 内部"准备就绪 · 剩余 N"的 DOM 结构
  setTaskPill(pill || "", pillKind);
}

function setTaskPill(text, kind = "running") {
  const tp = $("taskPill");
  if (!tp) return;
  if (!text) {
    tp.classList.add("hidden");
    tp.textContent = "";
    return;
  }
  tp.textContent = text;
  tp.classList.remove("hidden", "success", "error");
  if (kind === "success") tp.classList.add("success");
  if (kind === "error") tp.classList.add("error");
}

function clearTaskPill() {
  setTaskPill("");
}

// Suno 上传进度 ETA 跟踪（保留最近 6 个样本的 {t, done}）
const etaTrack = [];
let lastUiLogMessage = "";
let lastUiLogAt = 0;

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  return `${s} 秒`;
}

function formatCompactDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "00分00秒";
  sec = Math.round(sec);
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${String(minutes).padStart(2, "0")}分${String(seconds).padStart(2, "0")}秒`;
}

function updateUploadMetrics(next = {}) {
  state.uploadMetrics = {
    ...state.uploadMetrics,
    ...next,
  };
  const total = Math.max(0, Number(state.uploadMetrics.total) || 0);
  const submitted = Math.max(0, Number(state.uploadMetrics.submitted) || 0);
  const done = Math.max(0, Number(state.uploadMetrics.done) || 0);
  const elapsed = Math.max(0, Number(state.uploadMetrics.elapsed) || 0);
  const finished = Boolean(state.uploadMetrics.finished);
  if ($("uploadMetricTotal")) $("uploadMetricTotal").textContent = String(total);
  if ($("uploadMetricSubmitted")) $("uploadMetricSubmitted").textContent = String(submitted);
  if ($("uploadMetricDone")) $("uploadMetricDone").textContent = String(done);
  if ($("uploadMetricFinished")) {
    $("uploadMetricFinished").textContent = `${finished ? "是" : "否"} / ${formatCompactDuration(elapsed)}`;
  }
}

function resetUploadMetrics() {
  updateUploadMetrics({ total: 0, submitted: 0, done: 0, elapsed: 0, finished: false });
}

const TASK_SOUND_URLS = {
  success: new URL("../../assets/sounds/task-complete.mp3", window.location.href).href,
  failure: new URL("../../assets/sounds/system-failure.mp3", window.location.href).href,
};
const TASK_SOUND_ENABLED_STORAGE_KEY = "qiyin-task-sound-enabled";
const TASK_SOUND_VOLUME_STORAGE_KEY = "qiyin-task-sound-volume";
const taskSoundPlayers = new Map();
let activeTaskSound = null;
let taskSoundsPrimed = false;
let lastTaskSound = { kind: "", at: 0 };

function loadTaskSoundSettings() {
  let enabled = true;
  let volume = 0.86;
  try {
    enabled = localStorage.getItem(TASK_SOUND_ENABLED_STORAGE_KEY) !== "false";
    const rawVolume = localStorage.getItem(TASK_SOUND_VOLUME_STORAGE_KEY);
    const storedVolume = rawVolume === null ? NaN : Number(rawVolume);
    if (Number.isFinite(storedVolume)) volume = clamp(storedVolume, 0, 1);
  } catch (_) {}
  return { enabled, volume };
}

const taskSoundSettings = loadTaskSoundSettings();

function applyTaskSoundSettings(next = {}, persist = true) {
  taskSoundSettings.enabled = next.enabled === undefined ? taskSoundSettings.enabled : next.enabled !== false;
  taskSoundSettings.volume = clamp(next.volume ?? taskSoundSettings.volume, 0, 1);
  for (const player of taskSoundPlayers.values()) player.volume = taskSoundSettings.volume;
  if (!taskSoundSettings.enabled && activeTaskSound) {
    activeTaskSound.pause();
    activeTaskSound.currentTime = 0;
    activeTaskSound = null;
  }
  if (persist) {
    try {
      localStorage.setItem(TASK_SOUND_ENABLED_STORAGE_KEY, String(taskSoundSettings.enabled));
      localStorage.setItem(TASK_SOUND_VOLUME_STORAGE_KEY, String(taskSoundSettings.volume));
    } catch (_) {}
  }
  syncTaskSoundControls();
}

function syncTaskSoundControls() {
  const enabledToggle = $("taskSoundEnabledToggle");
  const volumeRange = $("taskSoundVolumeRange");
  const volumeValue = $("taskSoundVolumeValue");
  const settingsPanel = $("taskSoundSettings");
  const percent = Math.round(taskSoundSettings.volume * 100);
  if (enabledToggle) enabledToggle.checked = taskSoundSettings.enabled;
  if (volumeRange) {
    volumeRange.value = String(percent);
    volumeRange.disabled = !taskSoundSettings.enabled;
  }
  if (volumeValue) volumeValue.textContent = `${percent}%`;
  settingsPanel?.classList.toggle("sound-disabled", !taskSoundSettings.enabled);
}

function setupTaskSoundControls() {
  const enabledToggle = $("taskSoundEnabledToggle");
  const volumeRange = $("taskSoundVolumeRange");
  enabledToggle?.addEventListener("change", () => {
    applyTaskSoundSettings({ enabled: enabledToggle.checked });
    if (enabledToggle.checked) primeTaskSounds();
  });
  volumeRange?.addEventListener("input", () => {
    applyTaskSoundSettings({ volume: Number(volumeRange.value) / 100 });
  });
  syncTaskSoundControls();
}

function taskSoundPlayer(kind) {
  const safeKind = kind === "failure" ? "failure" : "success";
  if (!taskSoundPlayers.has(safeKind)) {
    const player = new Audio(TASK_SOUND_URLS[safeKind]);
    player.preload = "auto";
    player.volume = taskSoundSettings.volume;
    taskSoundPlayers.set(safeKind, player);
  }
  return taskSoundPlayers.get(safeKind);
}

function primeTaskSounds() {
  if (taskSoundsPrimed) return;
  if (!taskSoundSettings.enabled) return;
  taskSoundsPrimed = true;
  for (const kind of ["success", "failure"]) {
    const player = taskSoundPlayer(kind);
    const intendedVolume = player.volume;
    player.volume = 0;
    const started = player.play();
    if (started && typeof started.then === "function") {
      started.then(() => {
        player.pause();
        player.currentTime = 0;
        player.volume = intendedVolume;
      }).catch(() => { player.volume = intendedVolume; });
    } else {
      player.volume = intendedVolume;
    }
  }
}

function playTaskSound(kind) {
  if (!taskSoundSettings.enabled || taskSoundSettings.volume <= 0) return;
  const safeKind = kind === "failure" ? "failure" : "success";
  const now = Date.now();
  if (lastTaskSound.kind === safeKind && now - lastTaskSound.at < 1200) return;
  lastTaskSound = { kind: safeKind, at: now };
  try {
    if (activeTaskSound) {
      activeTaskSound.pause();
      activeTaskSound.currentTime = 0;
    }
    const player = taskSoundPlayer(safeKind);
    activeTaskSound = player;
    player.currentTime = 0;
    player.play().catch(() => {});
  } catch (_) {}
}

document.addEventListener("pointerdown", primeTaskSounds, { once: true, capture: true });

function formatCompletionTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const doneAt = new Date(Date.now() + Math.round(sec) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  const time = `${pad(doneAt.getHours())}:${pad(doneAt.getMinutes())}`;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (doneAt.toDateString() === today.toDateString()) return time;
  if (doneAt.toDateString() === tomorrow.toDateString()) return `明天 ${time}`;
  return `${pad(doneAt.getMonth() + 1)}-${pad(doneAt.getDate())} ${time}`;
}

function resetUploadEta() {
  etaTrack.splice(0, etaTrack.length);
  if (state.uploadEtaTimer) clearInterval(state.uploadEtaTimer);
  state.uploadEtaTimer = null;
  state.uploadEtaTargetAt = 0;
  state.uploadEtaPhase = "";
  setUploadEtaBadge("", "");
}

function refreshUploadEtaCountdown() {
  if (!state.uploadEtaTargetAt) return;
  const remaining = Math.max(1, Math.ceil((state.uploadEtaTargetAt - Date.now()) / 1000));
  setUploadEtaBadge(`预计完成 ${formatCompletionTime(remaining)}`, `剩余 ${formatDuration(remaining)}`);
}

function setUploadEtaEstimate(seconds, phase, force = false) {
  const safeSeconds = Math.max(1, Math.round(Number(seconds) || 0));
  if (!safeSeconds) return;
  if (!force && state.uploadEtaPhase === phase && state.uploadEtaTargetAt > Date.now()) return;
  state.uploadEtaPhase = String(phase || "running");
  state.uploadEtaTargetAt = Date.now() + safeSeconds * 1000;
  refreshUploadEtaCountdown();
  if (!state.uploadEtaTimer) {
    state.uploadEtaTimer = setInterval(refreshUploadEtaCountdown, 1000);
  }
}

function stopUploadEtaCountdown() {
  if (state.uploadEtaTimer) clearInterval(state.uploadEtaTimer);
  state.uploadEtaTimer = null;
  state.uploadEtaTargetAt = 0;
  state.uploadEtaPhase = "";
}

function updateOnBeat2xEtaFromProgress(submitted, total, done) {
  const attempt = Math.max(1, Number(state.uploadAdjustmentAttempt) || 1);
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeSubmitted = Math.max(0, Number(submitted) || 0);
  const safeDone = Math.max(0, Number(done) || 0);
  const pending = Math.max(0, safeTotal - safeDone);
  let remaining;
  if (safeDone >= safeTotal) {
    remaining = 35;
  } else if (attempt === 1) {
    remaining = safeSubmitted >= safeTotal ? 85 : 90;
  } else if (attempt === 2) {
    remaining = safeSubmitted >= safeTotal ? 50 : 55;
  } else {
    remaining = 35 + Math.ceil(pending / 2) * 30;
  }
  setUploadEtaEstimate(
    remaining,
    `upload-${attempt}-${safeSubmitted}-${safeDone}-${safeTotal}`,
  );
}

function setUploadEtaBadge(title, detail = "", kind = "") {
  const badge = $("uploadEtaBadge");
  if (!badge) return;
  const titleEl = $("uploadEtaTitle");
  const detailEl = $("uploadEtaDetail");
  if (!title && !detail) {
    badge.classList.add("hidden");
    badge.classList.remove("done", "error");
    if (titleEl) titleEl.textContent = "";
    if (detailEl) detailEl.textContent = "";
    return;
  }
  if (titleEl) titleEl.textContent = title || "";
  if (detailEl) detailEl.textContent = detail || "";
  badge.classList.remove("hidden", "done", "error");
  if (kind === "done") badge.classList.add("done");
  if (kind === "error") badge.classList.add("error");
}

function setProgress(value) {
  const safe = clamp(value, 0, 100);
  $("progressBar").style.width = `${safe}%`;
}

function setSeparationProgress(value) {
  const safe = clamp(value, 0, 100);
  $("separationProgress").style.width = `${safe}%`;
}

function setCurrentAudio(file) {
  state.audioPath = file || "";
  $("audioName").textContent = file ? basename(file) : "未选择";
  $("audioPath").textContent = file || "请选择 mp3、wav、m4a、flac、ogg 等开放音频";
  if (file) {
    // 每次拖入/选择音频，歌曲名自动更新为该音频的文件名（去扩展名）
    $("titleInput").value = basename(file).replace(/\.[^.]+$/, "");
  }
  updateUploadAudioButtons();
  // 把 audioPath 写入后立即刷新 startBtn 的 disabled 状态：
  // setBusy 之外只受 licenseValid 影响，确保下一个动作（自动 click 上传）能立即触发。
  if (!state.busy) {
    const blocked = !state.licenseValid;
    if ($("startBtn")) $("startBtn").disabled = blocked;
  }
}

const ACTIVE_BATCH_STATUSES = new Set(["running", "pausing"]);
const BATCH_STATUS_LABELS = {
  idle: "尚未创建队列",
  ready: "等待开始",
  running: "上传中",
  pausing: "当前歌曲完成后暂停",
  paused: "已暂停",
  waiting_login: "等待重新登录 Suno",
  completed: "已完成",
  cancelled: "已停止",
};
const BATCH_ITEM_STATUS_LABELS = {
  pending: "等待上传",
  preparing: "准备中",
  uploading: "上传中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  waiting_login: "等待登录",
};

function batchQueueIsActive() {
  return ACTIVE_BATCH_STATUSES.has(state.batchQueue?.status);
}

function normalizeBatchQueue(queue) {
  const source = queue && typeof queue === "object" ? queue : {};
  return {
    ...source,
    status: String(source.status || "idle"),
    currentItemId: String(source.currentItemId || ""),
    items: Array.isArray(source.items) ? source.items.map((item, index) => ({
      ...item,
      id: String(item.id || `draft-${Date.now()}-${index}`),
      audioPath: String(item.audioPath || ""),
      title: String(item.title || basename(item.audioPath || "").replace(/\.[^.]+$/, "")),
      speed: item.speed === "stable" ? "stable" : "onbeat2x",
      status: String(item.status || "pending"),
      progress: clamp(Number(item.progress) || 0, 0, 100),
      order: index,
    })) : [],
  };
}

function setUploadType(type) {
  const next = type === "batch" ? "batch" : "single";
  if (batchQueueIsActive() && next !== "batch") return;
  state.uploadType = next;
  document.querySelectorAll("[data-upload-type]").forEach((button) => {
    const active = button.dataset.uploadType === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = batchQueueIsActive() && !active;
  });
  $("singleUploadFields")?.classList.toggle("hidden", next !== "single");
  $("singleUploadActions")?.classList.toggle("hidden", next !== "single");
  $("batchUploadFields")?.classList.toggle("hidden", next !== "batch");
  $("batchUploadActions")?.classList.toggle("hidden", next !== "batch");
  $("batchQueuePanel")?.classList.toggle("hidden", next !== "batch");
  if ($("speedModeLabel")) {
    $("speedModeLabel").textContent = next === "batch" ? "队列默认上传模式" : "上传模式";
  }
  renderBatchQueue();
  updateBatchQueueControls();
}

function batchQueueCounts() {
  const items = state.batchQueue?.items || [];
  return {
    total: items.length,
    pending: items.filter((item) => ["pending", "preparing", "uploading", "waiting_login"].includes(item.status)).length,
    completed: items.filter((item) => item.status === "completed").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

function updateBatchQueueControls() {
  const queue = state.batchQueue || { status: "idle", items: [] };
  const active = ACTIVE_BATCH_STATUSES.has(queue.status);
  const counts = batchQueueCounts();
  const blocked = !state.licenseValid;
  const startButton = $("batchStartBtn");
  const pauseButton = $("batchPauseBtn");
  const cancelButton = $("batchCancelBtn");
  const clearButton = $("batchClearBtn");
  const pickButton = $("batchPickBtn");
  const drop = $("batchUploadDropArea");

  if (startButton) {
    startButton.textContent = ["paused", "waiting_login"].includes(queue.status) ? "继续批量上传" : "开始批量上传";
    startButton.disabled = active || blocked || counts.total === 0 || (counts.pending === 0 && queue.status !== "waiting_login");
  }
  if (pauseButton) {
    pauseButton.disabled = queue.status !== "running";
    pauseButton.textContent = queue.status === "pausing" ? "等待暂停…" : "当前歌曲后暂停";
  }
  if (cancelButton) cancelButton.disabled = !active && !["paused", "waiting_login", "ready"].includes(queue.status);
  if (clearButton) clearButton.disabled = active || queue.status === "pausing" || counts.total === 0;
  if (pickButton) pickButton.disabled = active || queue.status === "pausing" || blocked;
  drop?.classList.toggle("is-disabled", active || queue.status === "pausing" || blocked);
  document.querySelectorAll("[data-upload-type]").forEach((button) => {
    button.disabled = active && button.dataset.uploadType !== "batch";
  });
}

function createBatchQueueButton(text, title, action, disabled = false, kind = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `batch-row-action${kind ? ` ${kind}` : ""}`;
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.dataset.batchAction = action;
  return button;
}

function renderBatchQueue() {
  const list = $("batchQueueList");
  if (!list) return;
  const queue = state.batchQueue || { status: "idle", items: [] };
  const items = queue.items || [];
  const counts = batchQueueCounts();
  const active = ACTIVE_BATCH_STATUSES.has(queue.status);
  const editingDisabled = active || queue.status === "pausing";
  const summary = $("batchQueueSummary");
  if (summary) {
    summary.textContent = `${items.length} 首 · 完成 ${counts.completed} · 失败 ${counts.failed} · ${BATCH_STATUS_LABELS[queue.status] || queue.status}`;
  }
  const countLabel = $("batchAudioCount");
  const hint = $("batchAudioHint");
  if (countLabel) countLabel.textContent = items.length ? `已加入 ${items.length} 首歌曲` : "尚未添加歌曲";
  if (hint) hint.textContent = items.length ? "可继续添加，并在右侧调整顺序和模式" : "点击或拖入多首音频加入队列";

  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "batch-queue-empty";
    empty.textContent = "选择多首歌曲后会在这里显示上传顺序";
    list.appendChild(empty);
    updateBatchQueueControls();
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = `batch-queue-row status-${item.status || "pending"}`;
    if (item.id === queue.currentItemId) row.classList.add("is-current");

    const order = document.createElement("span");
    order.className = "batch-row-order";
    order.textContent = String(index + 1);

    const body = document.createElement("div");
    body.className = "batch-row-body";
    const titleInput = document.createElement("input");
    titleInput.className = "batch-row-title";
    titleInput.value = item.title || basename(item.audioPath).replace(/\.[^.]+$/, "");
    titleInput.title = item.audioPath;
    titleInput.disabled = editingDisabled || item.status === "completed";
    titleInput.addEventListener("change", () => {
      item.title = titleInput.value.trim() || basename(item.audioPath).replace(/\.[^.]+$/, "");
      titleInput.value = item.title;
      persistBatchQueue();
    });

    const meta = document.createElement("div");
    meta.className = "batch-row-meta";
    const status = document.createElement("span");
    status.className = "batch-row-status";
    status.textContent = item.message || BATCH_ITEM_STATUS_LABELS[item.status] || item.status;
    const progress = document.createElement("span");
    progress.textContent = `${Math.round(item.progress || 0)}%`;
    const accountLabel = document.createElement("span");
    accountLabel.textContent = `账号 ${item.accountId || "1"}`;
    meta.append(accountLabel, status, progress);

    const meter = document.createElement("div");
    meter.className = "batch-row-progress";
    const fill = document.createElement("div");
    fill.style.width = `${clamp(item.progress || 0, 0, 100)}%`;
    meter.appendChild(fill);
    body.append(titleInput, meta, meter);

    const speed = document.createElement("select");
    speed.className = "batch-row-speed";
    speed.disabled = editingDisabled || item.status === "completed";
    [["onbeat2x", "快速"], ["stable", "稳定"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = item.speed === value;
      speed.appendChild(option);
    });
    speed.addEventListener("change", () => {
      item.speed = speed.value === "stable" ? "stable" : "onbeat2x";
      persistBatchQueue();
    });

    const actions = document.createElement("div");
    actions.className = "batch-row-actions";
    if (item.resultUrl) {
      const open = createBatchQueueButton("↗", "打开 Suno 结果", "open", false, "open");
      open.addEventListener("click", () => window.gaobai.openUrl(item.resultUrl));
      actions.appendChild(open);
    } else if (["failed", "cancelled"].includes(item.status)) {
      const retry = createBatchQueueButton("↻", "重试这首歌曲", "retry", editingDisabled, "retry");
      retry.addEventListener("click", async () => {
        const result = await window.gaobai.retryUploadBatchItem(item.id);
        if (result?.ok) {
          state.batchQueue = normalizeBatchQueue(result.queue);
          renderBatchQueue();
        } else {
          log(result?.message || "暂时不能重试这首歌曲。");
        }
      });
      actions.appendChild(retry);
    } else {
      const up = createBatchQueueButton("↑", "向上移动", "up", editingDisabled || index === 0);
      const down = createBatchQueueButton("↓", "向下移动", "down", editingDisabled || index === items.length - 1);
      const remove = createBatchQueueButton("×", "从队列移除", "remove", editingDisabled, "remove");
      up.addEventListener("click", () => moveBatchQueueItem(index, -1));
      down.addEventListener("click", () => moveBatchQueueItem(index, 1));
      remove.addEventListener("click", () => removeBatchQueueItem(item.id));
      actions.append(up, down, remove);
    }

    row.append(order, body, speed, actions);
    list.appendChild(row);
  });
  updateBatchQueueControls();
}

async function persistBatchQueue() {
  if (batchQueueIsActive()) return false;
  try {
    const result = await window.gaobai.saveUploadBatch({ items: state.batchQueue.items || [] });
    if (!result?.ok) {
      log(result?.message || "保存批量队列失败。");
      return false;
    }
    state.batchQueue = normalizeBatchQueue(result.queue);
    renderBatchQueue();
    return true;
  } catch (error) {
    log(`保存批量队列失败：${error.message || error}`);
    return false;
  }
}

async function addFilesToBatchQueue(files) {
  const paths = (Array.isArray(files) ? files : []).filter((file) => OPEN_AUDIO_PATTERN.test(basename(file || "")));
  if (!paths.length) return;
  const items = [...(state.batchQueue.items || [])];
  const seen = new Set(items.map((item) => String(item.audioPath || "").toLowerCase()));
  for (const audioPath of paths) {
    const key = String(audioPath).toLowerCase();
    if (!audioPath || seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: `draft-${Date.now()}-${items.length}-${Math.random().toString(36).slice(2, 7)}`,
      ...window.sunoAccountBinding?.(),
      audioPath,
      title: basename(audioPath).replace(/\.[^.]+$/, ""),
      speed: state.speed,
      status: "pending",
      progress: 0,
      message: "等待上传",
    });
  }
  state.batchQueue = normalizeBatchQueue({ ...state.batchQueue, status: items.length ? "ready" : "idle", items });
  await persistBatchQueue();
}

function moveBatchQueueItem(index, offset) {
  if (batchQueueIsActive()) return;
  const items = [...(state.batchQueue.items || [])];
  const target = index + offset;
  if (target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
  state.batchQueue.items = items;
  renderBatchQueue();
  persistBatchQueue();
}

function removeBatchQueueItem(itemId) {
  if (batchQueueIsActive()) return;
  state.batchQueue.items = (state.batchQueue.items || []).filter((item) => item.id !== itemId);
  renderBatchQueue();
  persistBatchQueue();
}

async function refreshUploadBatchQueue() {
  try {
    const result = await window.gaobai.getUploadBatchState?.();
    if (result?.ok) {
      state.batchQueue = normalizeBatchQueue(result.queue);
      renderBatchQueue();
    }
  } catch (error) {
    log(`读取批量队列失败：${error.message || error}`);
  }
}

function handleUploadBatchEvent(event) {
  if (!event?.queue) return;
  const previousStatus = state.batchQueue?.status || "idle";
  const previousItemId = state.batchQueue?.currentItemId || "";
  state.batchQueue = normalizeBatchQueue(event.queue);
  const queue = state.batchQueue;
  const current = queue.items.find((item) => item.id === queue.currentItemId);
  if (current) state.speed = current.speed;
  renderBatchQueue();

  if (ACTIVE_BATCH_STATUSES.has(queue.status)) {
    if (current && current.id !== previousItemId) {
      resetUploadEta();
      resetUploadMetrics();
      state.uploadAdjustmentAttempt = 1;
      setProgress(3);
      setUploadEtaBadge("预计完成 --:--", "当前歌曲计算中");
    }
    setBusy(true);
    setUploadType("batch");
    if (current) {
      setStatus(`批量上传 ${current.order + 1}/${queue.items.length} · ${current.title}`, "队列运行中");
    } else {
      setStatus("批量队列准备下一首", "队列运行中");
    }
  } else {
    setBusy(false);
    if (queue.status === "waiting_login") {
      restoreSunoLoginUi("Suno Token 已失效，批量队列已暂停。重新登录后点击“继续批量上传”。");
      setUploadType("batch");
    } else if (queue.status === "paused") {
      setStatus("批量队列已暂停", "已暂停");
    } else if (queue.status === "cancelled") {
      setStatus("批量队列已停止", "已停止", "error");
    } else if (queue.status === "completed") {
      const counts = batchQueueCounts();
      setProgress(100);
      setStatus("批量上传完成", "队列完成", counts.failed ? "error" : "success");
      setUploadEtaBadge("批量上传完成", `${counts.completed}/${counts.total} 首成功`, counts.failed ? "error" : "done");
      if (previousStatus !== "completed") playTaskSound(counts.failed ? "failure" : "success");
      refreshHistory();
    }
  }
}

// 统一入口：把任意来源的音频送进 Suno 上传槽并立即启动上传。
// 用于「剪辑页 / 解锁页 / 分离页」上的"上传到 Suno"按钮——
// 不管 Suno 上传页之前的占位是什么状态（空 / 已选 / 已删），都能一键到上传。
async function sendToSunoAndUpload(file, { title, switchPanel = true, logTag = "" } = {}) {
  if (!file) {
    log("没有可用的音频文件，无法上传到 Suno。");
    return false;
  }
  setCurrentAudio(file);
  if (typeof title === "string" && title.trim()) {
    $("titleInput").value = title.trim();
  } else if (!$("titleInput").value.trim()) {
    $("titleInput").value = basename(file).replace(/\.[^.]+$/, "");
  }
  if (switchPanel && typeof goToPanel === "function") {
    try { goToPanel("uploadPage"); } catch (_) {}
  }
  if (logTag) log(logTag);
  // 等下一个微任务，让 panel 切换/UI 更新先生效，避免 click 时 startBtn 还在过渡禁用
  await Promise.resolve();
  const btn = $("startBtn");
  if (!btn) {
    log("未找到上传按钮。");
    return false;
  }
  if (btn.disabled) {
    // 解释一下为啥 disabled，给用户可操作的提示
    if (state.busy) {
      log("已有任务在运行，请等当前任务结束后在 Suno 上传页点击「上传到 Suno」。");
    } else if (!state.licenseValid) {
      log("授权未生效，无法自动上传。请先激活后在 Suno 上传页手动开始。");
    } else {
      log("当前不可上传，请到 Suno 上传页手动点击「上传到 Suno」。");
    }
    return false;
  }
  btn.click();
  return true;
}

// ============================================================================
// 启动时检查更新 / 系统公告
// 流程：check_update 先弹（如有）；关闭后再弹系统公告。
// 强制更新时禁用关闭按钮，必须下载或退出。
// ============================================================================
async function checkForUpdatesAndAnnouncements() {
  // 内部使用版：不检查官网更新/公告
}

// 返回 'dismissed' 或 'force_quit'
function showUpdateModal(info) {
  // 内部使用版：更新弹窗已移除
  return Promise.resolve("dismissed");
}

const dismissedAnnouncementIds = new Set();

function showAnnouncementModal(items) {
  // 内部使用版：公告弹窗已移除
  return Promise.resolve();
}

function sanitizeLoginMessage(message) {
  const text = String(message || "");
  if (/SecurityError[\s\S]*cookie|Failed to read[\s\S]*cookie|Access is denied for this document|exceptionId[\s\S]*DOMException/i.test(text)) {
    return "未获取到 Suno 登录 Token 密钥，建议安装 Google Chrome 浏览器，或者更换网络热点！";
  }
  if (/\[login\].*(暂未拿到|href=|__clerk_handshake|meta=|runtime probe|cdp-network|token=|cookies=)/i.test(text)) {
    return "暂未获取到登录的Suno，正在获取中.....";
  }
  if (/\[login\].*(捕获到|token 校验结果|token_valid|status=200|已获取Suno登录信息|已登录)/i.test(text)) {
    return "已获取Suno登录信息，已登录！";
  }
  return text;
}

function log(message) {
  const text = sanitizeLoginMessage(message);
  if (shouldShowUploadNotice(text)) {
    const notice = friendlyUploadNotice(text);
    setUploadNotice(notice, noticeKindForText(notice));
  }
  const now = Date.now();
  if (text === "上传网络重试中" && lastUiLogMessage === text && now - lastUiLogAt < 15000) return;
  lastUiLogMessage = text;
  lastUiLogAt = now;
  const node = document.createElement("p");
  node.className = "log-line";
  node.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  $("logPanel").appendChild(node);
  $("logPanel").scrollTop = $("logPanel").scrollHeight;
}

function shouldShowUploadNotice(text) {
  return /登录|已连接|未连接|授权|激活|浏览器|账号|登录态|登录状态|退出 Suno|token/i.test(String(text || ""));
}

function friendlyUploadNotice(text) {
  const value = String(text || "");
  if (/暂未获取到登录的Suno|正在获取中/i.test(value)) {
    return "暂未获取到登录的Suno，正在获取中.....";
  }
  if (/正在校验Suno登录信息/i.test(value)) {
    return "正在校验Suno登录信息...";
  }
  if (/已获取Suno登录信息|已登录/i.test(value)) {
    return "已获取Suno登录信息，已登录！";
  }
  if (/\[auth\].*token.*ok=True|token_valid|status=200/.test(value)) {
    return "Suno 登录状态有效，可以开始上传。";
  }
  if (/no_saved_token|token_invalid|401|Unauthorized|登录状态已失效/.test(value)) {
    return "Suno 登录状态已失效，请重新登录。";
  }
  return value;
}

function noticeKindForText(text) {
  const value = String(text || "");
  if (/暂未获取到登录的Suno|正在获取中/i.test(value)) return "warn";
  if (/正在校验Suno登录信息/i.test(value)) return "warn";
  if (/已获取Suno登录信息|已登录/i.test(value)) return "success";
  if (/失败|无法|失效|过期|未连接|未登录|未获取|错误|拒绝/.test(value)) return "error";
  if (/等待|请|正在|打开|确认/.test(value)) return "warn";
  if (/成功|有效|已连接|已保存|已退出/.test(value)) return "success";
  return "";
}

function setUploadNotice(text, kind = "") {
  const el = $("uploadNotice");
  if (!el) return;
  el.textContent = text || "请先登录 Suno，然后选择音频开始上传。";
  el.classList.remove("success", "warn", "error");
  if (kind) el.classList.add(kind);
}

function uploadStatusTitle(message) {
  const value = String(message || "");
  if (/Uploading segment|正在上传片段|上传中｜第|Suno accepted/i.test(value)) return "上传中";
  if (/正在切分|正在读取续传切片/.test(value)) return "正在准备切片";
  return value || "运行中";
}

function onBeat2xStatusTitle(event) {
  const progress = Number(event?.progress);
  const message = String(event?.message || "");
  if (Number.isFinite(progress) && progress >= 97) return "下载";
  if ((Number.isFinite(progress) && progress >= 76) || /渲染|On Beat|保存工程|开始渲染/.test(message)) return "渲染";
  const eventAttempt = Number(event?.uploadAttempt);
  if (Number.isFinite(eventAttempt) && eventAttempt >= 1) {
    state.uploadAdjustmentAttempt = Math.floor(eventAttempt);
  }
  return onBeat2xUploadTitle();
}

function onBeat2xUploadTitle() {
  const attempt = Math.max(1, Number(state.uploadAdjustmentAttempt) || 1);
  return attempt > 1 ? `${attempt}次调整上传` : "上传";
}

function onBeat2xUploadProgressTitle(submitted, total) {
  const title = onBeat2xUploadTitle();
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeSubmitted = Math.max(0, Number(submitted) || 0);
  return safeTotal > 0 ? `${title}｜提交 ${safeSubmitted} / ${safeTotal}` : title;
}

// 支持 HTML 内容（含可点击链接）的日志
function logHtml(html, type) {
  const node = document.createElement("p");
  node.className = "log-line" + (type ? ` log-${type}` : "");
  const span = document.createElement("span");
  span.innerHTML = html;
  node.appendChild(span);
  $("logPanel").appendChild(node);
  $("logPanel").scrollTop = $("logPanel").scrollHeight;
  return node;
}

// 跳转到剪辑页，并自动加载当前 Suno 上传占位音频
async function openEditorForReupload() {
  if (typeof goToPanel === "function") {
    try { goToPanel("editorPage"); } catch (_) {}
  }
  const audio = state.audioPath;
  if (!audio) {
    log("当前未选择音频，无法跳到剪辑页。");
    return;
  }
  try {
    await loadEditorAudio(audio);
    log(`已为你加载占位音频到剪辑页：${basename(audio)}`);
    log("可在剪辑页调整升降调 / 变速 / 裁剪，然后回到 Suno 上传页重新上传。");
  } catch (error) {
    log(`加载占位音频到剪辑页失败：${error.message || error}`);
  }
}

async function refreshHistory() {
  try {
    const result = await window.gaobai.listHistory();
    const items = Array.isArray(result.items) ? result.items : [];
    state.historyItems = items;
    renderHistory();
  } catch (error) {
    log(`读取历史失败：${error.message}`);
  }
}

// 检查 Suno 登录状态（启动时自动检测）
async function checkLoginStatus() {
  try {
    const result = await window.gaobai.checkLoginStatus();
    if (result?.accountId && window.sunoAccountBinding && result.accountId !== window.sunoAccountBinding().accountId) return;
    if (result && result.loggedIn) {
      $("loginBtn").style.display = "none";
      $("logoutBtn").style.display = "";
      const src = result.tokenSource || "已保存";
      setStatus(`Suno 已连接 · ${src}`);
      setUploadNotice(`Suno 已连接，登录状态来源：${src}。`, "success");
      log(`Suno 登录状态有效，来源：${src}。`);
    } else {
      $("loginBtn").style.display = "";
      $("logoutBtn").style.display = "none";
      setUploadNotice("Suno 未登录，请先点击登录 Suno。", "warn");
    }
  } catch (_) { /* 静默失败 */ }
}

function restoreSunoLoginUi(message) {
  stopUploadEtaCountdown();
  setBusy(false);
  $("loginBtn").style.display = "";
  $("logoutBtn").style.display = "none";
  setStatus("需要登录 Suno", "登录已失效", "error");
  setUploadEtaBadge("等待重新登录", "上传已停止", "error");
  setUploadNotice(message || "Suno 登录状态已失效，请重新登录后再上传。", "error");
  updateUploadAudioButtons();
}

// 恢复解密输出目录
async function restoreUnlockerOutputDir() {
  try {
    const result = await window.gaobai.getUnlockerPrefs();
    if (result && result.outputDir) {
      unlockerState.outputDir = result.outputDir;
      unlockerState.lastOutputDir = result.outputDir;
      document.getElementById("unlockerOutputDirLabel").textContent = result.outputDir;
      log("已恢复上次解密输出目录。");
    }
    if (result && result.mmkvPath) {
      unlockerState.mmkvPath = result.mmkvPath;
      const lab = document.getElementById("unlockerMmkvPathLabel");
      if (lab) lab.textContent = result.mmkvPath;
    }
  } catch (_) { /* 静默失败 */ }
}

function historyMatchesFilter(item, filter) {
  const status = String(item.status || "").toLowerCase();
  const speed = String(item.speed || "").toLowerCase();
  if (filter === "success") return status.includes("success") || status.includes("done") || status.includes("完成");
  if (filter === "failed") return status.includes("fail") || status.includes("error") || status.includes("失败");
  if (filter === "standard") return speed.includes("standard") || speed.includes("标准");
  if (filter === "stable") return speed.includes("stable") || speed.includes("稳定");
  if (filter === "experiment") return speed.includes("experiment") || speed.includes("实验");
  if (filter === "fast") return speed.includes("fast") || speed.includes("快速");
  return true;
}

function renderHistory() {
  const list = $("historyList");
  if (!list) return;
  const query = ($("historySearchInput")?.value || "").trim().toLowerCase();
  const filter = state.historyFilter || "all";
  const items = state.historyItems || [];
  const filtered = items.filter((item) => {
    const text = `${item.title || ""} ${item.audio || ""} ${item.url || ""}`.toLowerCase();
    return (!query || text.includes(query)) && historyMatchesFilter(item, filter);
  });

  const successCount = items.filter((item) => historyMatchesFilter(item, "success")).length;
  const failedCount = items.filter((item) => historyMatchesFilter(item, "failed")).length;
  if ($("historyTotalCount")) $("historyTotalCount").textContent = String(items.length);
  if ($("historySuccessCount")) $("historySuccessCount").textContent = String(successCount);
  if ($("historyFailedCount")) $("historyFailedCount").textContent = String(failedCount);

  list.innerHTML = "";
  if (!filtered.length) {
    list.innerHTML = `<div class="history-item"><div class="history-title">还没有匹配的上传记录</div><div class="history-meta">完成一次上传后会显示在这里</div></div>`;
    return;
  }

  for (const item of filtered) {
    const el = document.createElement("article");
    el.className = "history-item";
    el.innerHTML = `
      <div class="history-main">
        <div class="history-title"></div>
        <div class="history-meta"></div>
      </div>
      <div class="history-actions">
        <button data-action="open">打开</button>
        <button data-action="copy">复制</button>
        <button data-action="folder">目录</button>
      </div>
    `;
    el.querySelector(".history-title").textContent = item.title || "未命名歌曲";
    el.querySelector(".history-meta").textContent = `${item.status || "unknown"} · ${item.speed || "-"} · ${item.created_at || ""}`;
    el.querySelector('[data-action="open"]').onclick = () => item.url && window.gaobai.openUrl(item.url);
    el.querySelector('[data-action="copy"]').onclick = async () => {
      if (item.url) await navigator.clipboard.writeText(item.url);
    };
    el.querySelector('[data-action="folder"]').onclick = () => window.gaobai.openPath(item.audio || item.work_dir || "");
    list.appendChild(el);
  }
}

function selectedSeparationModel() {
  return (state.separationModels || []).find((model) => model.filename === state.selectedSeparationModel)
    || (state.separationModels || [])[0]
    || { filename: "4_HP-Vocal-UVR.pth", label: "4_HP-Vocal-UVR", installed: true };
}

function separationModelPayload() {
  const model = selectedSeparationModel();
  return {
    modelFilename: model.filename || "4_HP-Vocal-UVR.pth",
    modelLabel: model.label || model.shortLabel || "4_HP-Vocal-UVR",
    deviceMode: state.separationDeviceMode || "auto"
  };
}

function updateSeparationModelUi() {
  const model = selectedSeparationModel();
  const statusEl = $("separationModelStatus");
  const pill = $("separationModelPill");
  const loaded = $("separationLoadedModel");
  const downloadBtn = $("downloadSeparationModelBtn");
  if (pill) pill.textContent = `当前模型：${model.shortLabel || model.label || model.filename}`;
  if (loaded) loaded.textContent = `已选择模型：${model.label || model.filename}`;
  if (statusEl) {
    const installedText = model.installed ? "已安装" : "未下载";
    const sourceText = model.source === "builtin" ? "内置" : (model.source === "user" ? "本地" : "可下载");
    statusEl.textContent = `${installedText} · ${sourceText} · ${model.note || model.quality || ""}`;
  }
  if (downloadBtn) {
    downloadBtn.disabled = Boolean(model.installed || model.builtIn);
    downloadBtn.textContent = model.installed || model.builtIn ? "无需下载" : "下载模型";
  }
}

function renderSeparationModels() {
  const select = $("separationModelSelect");
  if (!select) return;
  select.innerHTML = "";
  for (const model of state.separationModels || []) {
    const option = document.createElement("option");
    option.value = model.filename;
    option.textContent = `${model.installed ? "已安装" : "未下载"} · ${model.label || model.filename}`;
    select.appendChild(option);
  }
  if (!(state.separationModels || []).some((model) => model.filename === state.selectedSeparationModel)) {
    state.selectedSeparationModel = "4_HP-Vocal-UVR.pth";
  }
  select.value = state.selectedSeparationModel;
  updateSeparationModelUi();
}

async function refreshSeparationModels() {
  try {
    const result = await window.gaobai.listSeparationModels();
    if (result?.ok && Array.isArray(result.models)) {
      state.separationModels = result.models;
      state.selectedSeparationModel = state.selectedSeparationModel || result.defaultModel || "4_HP-Vocal-UVR.pth";
      renderSeparationModels();
    }
  } catch (error) {
    if ($("separationModelStatus")) $("separationModelStatus").textContent = `模型列表读取失败：${error.message || error}`;
  }
}

function renderSeparationDeviceUi() {
  document.querySelectorAll("[data-separation-device]").forEach((button) => {
    const active = button.dataset.separationDevice === state.separationDeviceMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
  const statusEl = $("separationDeviceStatus");
  const installBtn = $("installSeparationGpuBtn");
  const info = state.separationDevices || {};
  const nvidia = (info.controllers || []).find((item) => item.nvidia);
  if (statusEl) {
    if (info.gpuRuntimeInstalled && nvidia) {
      statusEl.textContent = `检测到 ${nvidia.name} · GPU组件已安装 · 异常自动回退CPU`;
    } else if (nvidia) {
      statusEl.textContent = `检测到 ${nvidia.name} · 安装GPU组件后可启用加速`;
    } else {
      statusEl.textContent = "未检测到可用的 NVIDIA GPU · 自动模式将使用CPU";
    }
  }
  if (installBtn) {
    installBtn.classList.toggle("hidden", Boolean(info.gpuRuntimeInstalled) || !nvidia);
  }
}

async function refreshSeparationDevices() {
  try {
    const result = await window.gaobai.listSeparationDevices();
    if (result?.ok) state.separationDevices = result;
  } catch (error) {
    state.separationDevices = { controllers: [], hasNvidiaGpu: false, gpuRuntimeInstalled: false };
    if ($("separationDeviceStatus")) {
      $("separationDeviceStatus").textContent = `设备检测失败：${error.message || error}`;
    }
  }
  renderSeparationDeviceUi();
}

function handleBackendEvent(event) {
  if (!event || typeof event !== "object") return;
  const batchEvent = Boolean(event.batchMode);
  if (event.type === "log") {
    if (event.detail) return;
    log(event.message || "");
  } else if (event.type === "status") {
    if (event.detail) return;
    const onBeat2x = state.speed === "onbeat2x";
    const title = onBeat2x ? onBeat2xStatusTitle(event) : uploadStatusTitle(event.message);
    if (onBeat2x) {
      const attempt = Number(event.uploadAttempt);
      const message = String(event.message || "");
      const progress = Number(event.progress);
      if (Number.isFinite(attempt) && attempt >= 1) {
        const initialSeconds = attempt === 1 ? 125 : (attempt === 2 ? 65 : 125);
        setUploadEtaEstimate(initialSeconds, `attempt-${attempt}`, true);
      } else if ((Number.isFinite(progress) && progress >= 97) || /下载结果/.test(message)) {
        setUploadEtaEstimate(8, "download");
      } else if ((Number.isFinite(progress) && progress >= 76) || /渲染|On Beat|保存工程|开始渲染/.test(message)) {
        setUploadEtaEstimate(35, "render");
      }
    }
    setStatus(title, onBeat2x ? title : "上传中");
    if (event.progress !== undefined) setProgress(event.progress);
  } else if (event.type === "workdir") {
    state.uploadWorkDir = event.workDir || "";
    state.uploadSegmentsDir = event.segmentsDir || state.uploadWorkDir || "";
    updateUploadAudioButtons();
  } else if (event.type === "progress") {
    // 后端节流 0.4s 推一次 progress 事件，含 total / done / failed / elapsed_sec
    const total = Number(event.total) || 0;
    const submitted = Number(event.submitted) || 0;
    const done = Number(event.done) || 0;
    const failed = Number(event.failed) || 0;
    const elapsed = Number(event.elapsed_sec) || 0;
    if (!total) return;
    const submitPct = Math.min(1, submitted / total);
    const donePct = Math.min(1, done / total);
    const percent = Math.min(75, Math.max(0, 35 + Math.round(submitPct * 25) + Math.round(donePct * 15)));
    setProgress(percent);
    // 计算 ETA：使用最近 3 个样本的简单移动平均（不重写算法，稳定即可）
    etaTrack.push({ t: Date.now(), done });
    etaTrack.splice(0, etaTrack.length - 6); // 保留最近 6 个
    let etaText = "";
    let completionText = "";
    if (etaTrack.length >= 2) {
      const first = etaTrack[0];
      const last = etaTrack[etaTrack.length - 1];
      const dt = (last.t - first.t) / 1000; // 秒
      const dd = Math.max(0, last.done - first.done);
      let etaSec = 0;
      if (dt > 0.5 && dd > 0) {
        const rate = dd / dt; // 段 / 秒
        const remain = Math.max(0, total - done);
        etaSec = rate > 0 ? remain / rate : 0;
      } else if (etaTrack.length >= 3) {
        // 数据平稳时基于已用时间线性外推
        etaSec = elapsed * Math.max(0, total - done) / Math.max(1, done);
      }
      if (etaSec > 0) {
        etaText = formatDuration(etaSec);
        completionText = formatCompletionTime(etaSec);
        setUploadEtaBadge(`预计完成 ${completionText}`, `剩余 ${etaText}`);
      }
    }
    updateUploadMetrics({ total, submitted, done, elapsed, finished: false });
    if (state.speed === "onbeat2x") {
      updateOnBeat2xEtaFromProgress(submitted, total, done);
      const title = onBeat2xUploadProgressTitle(submitted, total);
      setStatus(title, title);
    } else {
      setStatus(failed > 0 ? `上传中｜失败 ${failed}` : "上传中", "上传中");
    }
  } else if (event.type === "segment") {
    const text = event.message || `片段状态：${event.status || "unknown"} ${event.index || "-"} / ${event.total || "-"}`;
    if (event.status === "queued") {
      const total = event.total || 0;
      if (total) updateUploadMetrics({ total, finished: false });
    } else if (event.status === "complete" || event.status === "saved") {
      const done = event.uploaded || event.success || event.index || 0;
      const total = event.total || 0;
      if (total) {
        updateUploadMetrics({ total, done, finished: false });
        if (state.speed === "onbeat2x") {
          const title = onBeat2xUploadProgressTitle(state.uploadMetrics.submitted, total);
          setStatus(title, title);
        }
        else setStatus("上传中", "上传中");
        setProgress(35 + Math.min(40, Math.round((done / total) * 40)));
      }
    } else if (event.status === "failed") {
      log(text);
      setStatus("片段上传失败", "片段失败", "error");
      const node = logHtml(`↳ <a href="#" data-action="open-editor-for-reupload">修改后重传（升降调 / 变速 / 裁剪后重传）</a>`, "warn");
      const link = node.querySelector('a[data-action="open-editor-for-reupload"]');
      if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openEditorForReupload(); });
    }
  } else if (event.type === "result") {
    if (event.loginOk) {
      setBusy(false);
      setStatus("已登录 Suno", "登录成功", "success");
      setUploadNotice("Suno 登录成功，登录态已保存。", "success");
      log("Suno 登录成功，登录态已保存。");
      $("loginBtn").style.display = "none";
      $("logoutBtn").style.display = "";
      // 1.5s 后自动清掉"登录成功"小标签，回到默认"准备就绪 · 剩余 N"
      setTimeout(clearTaskPill, 1500);
      return;
    }
    state.lastUrl = event.songUrl || event.url || "";
    if (batchEvent) {
      setProgress(100);
      const elapsed = Number(event.elapsedSec || event.elapsed_sec || 0);
      updateUploadMetrics({ finished: true, elapsed });
      if (state.lastUrl) $("openResultBtn").disabled = false;
      refreshHistory();
      return;
    }
    setBusy(false);
    setProgress(100);
    if (state.speed === "onbeat2x") setStatus("完成", "完成", "success");
    else setStatus("任务已完成", "上传完成", "success");
    setUploadEtaBadge("上传完成", "100%", "done");
    stopUploadEtaCountdown();
    const elapsed = Number(event.elapsedSec || event.elapsed_sec || 0);
    updateUploadMetrics({ finished: true, elapsed });
    playTaskSound("success");
    $("openResultBtn").disabled = false;
    updateUploadAudioButtons();
    if (state.lastUrl) {
      window.gaobai.openUrl(state.lastUrl).catch(() => {
        setUploadNotice("上传已完成，但自动打开 Suno 页面失败，可点击“打开上传页面”。", "warn");
      });
    }
    refreshHistory();
    setTimeout(clearTaskPill, 2000);
  } else if (event.type === "auth_required") {
    if (!batchEvent) playTaskSound("failure");
    log(event.message || "Suno Token 无法恢复，上传任务已停止，请重新登录 Suno。");
    restoreSunoLoginUi("Suno Token 无法恢复，上传已停止。请重新登录 Suno 后选择继续旧任务或新建项目。");
    refreshHistory();
  } else if (event.type === "failed") {
    if (batchEvent) {
      log(`当前队列歌曲上传失败${event.code !== undefined ? `，退出码：${event.code}` : ""}，队列将处理下一首。`);
      refreshHistory();
      return;
    }
    playTaskSound("failure");
    stopUploadEtaCountdown();
    setBusy(false);
    setStatus("任务失败", "任务失败", "error");
    setUploadEtaBadge("上传失败", "请查看日志", "error");
    log(`任务失败，退出码：${event.code}`);
    // 检测版权拒收，输出友好中文建议到日志（不弹窗）
    const recentLog = ($("logPanel") && $("logPanel").innerText) || "";
    if (/版权指纹|片段被 Suno 拒收|片段被拒绝/.test(recentLog)) {
      log("⚠️ Suno 检测到版权指纹，本次上传被拒收。");
      log("建议处理方式：");
      log("  1. 在【可视化音频剪辑】调整升降调（±2~5 半音）或音分");
      log("  2. 调整变速（0.85x 或 1.15x）");
      log("  3. 先用【伴奏/人声分离】去除人声后再上传");
      log("  4. 缩短或重新选择片段时长后再上传");
    }
    refreshHistory();
    setTimeout(clearTaskPill, 2500);
  } else if (event.type === "done") {
    if (batchEvent) return;
    stopUploadEtaCountdown();
    setBusy(false);
    setStatus("任务结束", "任务结束", "success");
    setUploadEtaBadge("任务结束", "已完成", "done");
    refreshHistory();
    setTimeout(clearTaskPill, 1500);
  } else if (event.type === "cancelled") {
    if (batchEvent) {
      log(event.message || "批量上传队列已停止。");
      return;
    }
    stopUploadEtaCountdown();
    setBusy(false);
    setStatus("已停止", "已停止", "error");
    setUploadEtaBadge("已停止", "任务取消", "error");
    log(event.message || "已终止当前上传任务。下次上传将重新创建 Suno 项目并从头上传。");
    setTimeout(clearTaskPill, 2000);
  } else if (event.type === "idle") {
    setBusy(false);
    setStatus("准备就绪");
    resetUploadEta();
  }
}

function getClipBounds() {
  const max = Math.max(0.1, state.editorDuration || 30);
  const startFallback = parseTimeInput($("clipStartRange").value, 0);
  const endFallback = parseTimeInput($("clipEndRange").value, Math.min(max, startFallback + 30));
  let start = clamp(parseTimeInput($("clipStartInput").value, startFallback), 0, max);
  let end = clamp(parseTimeInput($("clipEndInput").value, endFallback), 0.1, max);
  if (end <= start) end = Math.min(max, start + 0.1);
  return { start, end, duration: end - start };
}

function normalizeEditorSegments(segments) {
  const total = Math.max(0, state.editorDuration || 0);
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start: clamp(Number(segment?.start) || 0, 0, total),
      end: clamp(Number(segment?.end) || 0, 0, total)
    }))
    .filter((segment) => segment.end - segment.start >= 0.001)
    .sort((a, b) => a.start - b.start);
}

function ensureEditorSegmentMode() {
  if (state.editorSegmentMode) return;
  state.editorSegmentMode = true;
  state.editorSegments = state.editorDuration > 0.001
    ? [{ start: 0, end: state.editorDuration }]
    : [];
}

function getEditorExportSegments() {
  if (state.editorSegmentMode) {
    const segments = normalizeEditorSegments(state.editorSegments);
    if (segments.length) {
      return segments.reduce((merged, segment) => {
        const previous = merged.at(-1);
        if (previous && Math.abs(previous.end - segment.start) < 0.001) {
          previous.end = segment.end;
        } else {
          merged.push({ ...segment });
        }
        return merged;
      }, []);
    }
  }
  const bounds = getClipBounds();
  return [{ start: bounds.start, end: bounds.end }];
}

function syncSelectedDawClipFromEditorSegments() {
  if (!state.editorSegmentMode || !state.editorAudioPath) return;
  let found = dawFindClip(state.dawSelectedClipId);
  if (!found || found.clip.sourcePath !== state.editorAudioPath) {
    for (const track of state.dawTracks) {
      const clip = track.clips.find((item) => item.sourcePath === state.editorAudioPath);
      if (clip) { found = { track, clip }; break; }
    }
  }
  if (!found) return;
  const sourceStart = found.clip.sourceStart;
  const sourceEnd = found.clip.sourceEnd;
  const pieces = normalizeEditorSegments(state.editorSegments)
    .map((segment) => ({
      start: Math.max(sourceStart, segment.start),
      end: Math.min(sourceEnd, segment.end)
    }))
    .filter((segment) => segment.end - segment.start >= 0.001);
  if (!pieces.length) return;
  const originalIndex = found.track.clips.findIndex((clip) => clip.id === found.clip.id);
  let timelineCursor = found.clip.timelineStart;
  const replacement = pieces.map((segment, index) => {
    const duration = segment.end - segment.start;
    const clip = {
      ...found.clip,
      id: index === 0 ? found.clip.id : dawId("clip"),
      sourceStart: segment.start,
      sourceEnd: segment.end,
      duration,
      timelineStart: timelineCursor
    };
    timelineCursor += duration;
    return clip;
  });
  found.track.clips.splice(originalIndex, 1, ...replacement);
  state.dawSelectedTrackId = found.track.id;
  state.dawSelectedClipId = replacement[0].id;
  state.editorUndoDomain = "clip";
  renderDawProject();
}

function buildEditorExportPayload(sourcePath) {
  const bounds = getClipBounds();
  return {
    sourcePath,
    start: bounds.start,
    end: bounds.end,
    segments: getEditorExportSegments(),
    fadeIn: $("fadeInInput").value,
    fadeOut: $("fadeOutInput").value,
    volume: $("volumeInput").value,
    pitch: $("pitchInput").value,
    cents: $("centsInput") ? $("centsInput").value : 0,
    tempo: $("tempoInput").value
  };
}

function createEditorEditSnapshot() {
  return {
    audioPath: state.editorAudioPath,
    outputPath: state.editorOutputPath,
    outputDir: state.editorOutputDir,
    duration: state.editorDuration,
    waveformPeaks: state.waveformPeaks.slice(),
    waveformAllPeaks: state.waveformAllPeaks.slice(),
    clipStart: $("clipStartInput").value,
    clipEnd: $("clipEndInput").value,
    pitch: $("pitchInput").value,
    cents: $("centsInput") ? $("centsInput").value : 0,
    tempo: $("tempoInput").value,
    fadeIn: $("fadeInInput").value,
    fadeOut: $("fadeOutInput").value,
    volume: $("volumeInput").value,
    segments: state.editorSegments.map((segment) => ({ ...segment })),
    segmentMode: state.editorSegmentMode,
    dawTracks: JSON.parse(JSON.stringify(state.dawTracks)),
    dawSelectedTrackId: state.dawSelectedTrackId,
    dawSelectedClipId: state.dawSelectedClipId
  };
}

function saveEditorEditSnapshot() {
  state.undoStack.push(createEditorEditSnapshot());
  state.editorUndoDomain = "clip";
  $("undoClipBtn").disabled = false;
}

function splitEditorSegmentAt(time) {
  const cut = snapEditorTime(time);
  const segments = state.editorSegmentMode
    ? state.editorSegments.map((segment) => ({ ...segment }))
    : (state.editorDuration > 0.001 ? [{ start: 0, end: state.editorDuration }] : []);
  const index = segments.findIndex((segment) => (
    cut > segment.start + 0.001 && cut < segment.end - 0.001
  ));
  if (index < 0) {
    $("clipStatus").textContent = "切点需要落在保留片段内";
    return false;
  }
  saveEditorEditSnapshot();
  const segment = segments[index];
  segments.splice(index, 1,
    { start: segment.start, end: cut },
    { start: cut, end: segment.end });
  state.editorSegmentMode = true;
  state.editorSegments = normalizeEditorSegments(segments);
  syncSelectedDawClipFromEditorSegments();
  state.editorCursor = cut;
  $("clipStatus").textContent = `已添加切点：${formatTime(cut)}`;
  return true;
}

function deleteEditorSelection() {
  const bounds = getClipBounds();
  const segments = state.editorSegmentMode
    ? state.editorSegments
    : (state.editorDuration > 0.001 ? [{ start: 0, end: state.editorDuration }] : []);
  const next = [];
  segments.forEach((segment) => {
    if (bounds.end <= segment.start || bounds.start >= segment.end) {
      next.push(segment);
      return;
    }
    if (bounds.start > segment.start + 0.001) {
      next.push({ start: segment.start, end: Math.min(bounds.start, segment.end) });
    }
    if (bounds.end < segment.end - 0.001) {
      next.push({ start: Math.max(bounds.end, segment.start), end: segment.end });
    }
  });
  const normalized = normalizeEditorSegments(next);
  if (!normalized.length) {
    $("clipStatus").textContent = "不能删除全部音频";
    return false;
  }
  saveEditorEditSnapshot();
  state.editorSegmentMode = true;
  state.editorSegments = normalized;
  syncSelectedDawClipFromEditorSegments();
  const nextSegment = state.editorSegments.find((segment) => segment.end > bounds.end) || state.editorSegments.at(-1);
  setClipBoundsFromSeconds(nextSegment.start, nextSegment.end);
  $("clipStatus").textContent = `已删除选区，保留 ${state.editorSegments.length} 段`;
  return true;
}

function getEditorGridSeconds() {
  const bpm = clamp(Number(state.editorGrid?.bpm) || 120, 40, 260);
  const beat = 60 / bpm;
  const units = { bar: beat * 4, beat, half: beat / 2, quarter: beat / 4, eighth: beat / 8, time: 0.1 };
  return units[state.editorGrid?.unit] || beat;
}

function snapEditorTime(time, bypass = false) {
  const max = Math.max(0.001, state.editorDuration || 0);
  const raw = clamp(Number(time) || 0, 0, max);
  if (!state.editorGrid?.snap || bypass) return raw;
  const grid = getEditorGridSeconds();
  return clamp(Math.round(raw / grid) * grid, 0, max);
}

function getWaveView() {
  const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
  const total = Math.max(0.001, state.editorDuration || 0);
  const zoom = Math.max(1, state.waveformZoom || 1);
  const visibleDuration = total / zoom;
  const start = clamp(Number(state.waveformScroll || 0), 0, 1) * Math.max(0, total - visibleDuration);
  return { start, end: start + visibleDuration, duration: visibleDuration, total, allPeaks };
}

function setWaveViewStart(start, zoom = state.waveformZoom) {
  const total = Math.max(0.001, state.editorDuration || 0);
  const visibleDuration = total / Math.max(1, zoom || 1);
  const maxStart = Math.max(0, total - visibleDuration);
  state.waveformScroll = maxStart > 0
    ? clamp(Number(start) || 0, 0, maxStart) / maxStart
    : 0;
}

function setWaveZoomAroundCursor(nextZoom) {
  const total = Math.max(0.001, state.editorDuration || 0);
  const zoom = clamp(Number(nextZoom) || 1, 1, 16);
  const anchor = clamp(Number(state.editorCursor) || 0, 0, total);
  state.waveformZoom = zoom;
  setWaveViewStart(anchor - (total / zoom) / 2, zoom);
}

function centerWaveViewAt(time) {
  const view = getWaveView();
  setWaveViewStart((Number(time) || 0) - view.duration / 2);
}

function followEditorTimeInView(time) {
  if (Math.max(1, state.waveformZoom || 1) <= 1 || !state.editorDuration) return false;
  const view = getWaveView();
  const current = clamp(Number(time) || 0, 0, state.editorDuration);
  const leftLimit = view.start + view.duration * 0.12;
  const rightLimit = view.end - view.duration * 0.12;
  if (current >= leftLimit && current <= rightLimit) return false;
  // Keep the running cursor around 40% from the left, like a DAW follow mode.
  setWaveViewStart(current - view.duration * 0.4);
  return true;
}

function updateEditorCursor(time = state.editorCursor) {
  const cursor = $("editorCursor");
  if (!cursor || !state.editorDuration) return;
  state.editorCursor = clamp(Number(time) || 0, 0, state.editorDuration);
  const view = getWaveView();
  const x = ((state.editorCursor - view.start) / Math.max(0.001, view.duration)) * 100;
  cursor.style.display = x >= 0 && x <= 100 ? "" : "none";
  cursor.style.left = `${clamp(x, 0, 100)}%`;
}

function drawWaveRuler() {
  const canvas = $("waveRulerCanvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width || canvas.width / dpr));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(30 * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = state.theme === "dark";
  ctx.clearRect(0, 0, width, 30);
  ctx.fillStyle = dark ? "#160a0f" : "#f8fbff";
  ctx.fillRect(0, 0, width, 30);
  if (!state.editorDuration) return;
  const view = getWaveView();
  const grid = getEditorGridSeconds();
  const first = Math.ceil(view.start / grid) * grid;
  ctx.font = "10px Microsoft YaHei UI, sans-serif";
  ctx.textBaseline = "top";
  for (let t = first, count = 0; t <= view.end + grid && count < 600; t += grid, count += 1) {
    const x = ((t - view.start) / view.duration) * width;
    const isBar = state.editorGrid?.unit !== "time" && Math.abs((t / (60 / (state.editorGrid?.bpm || 120))) % 4) < 0.001;
    ctx.strokeStyle = dark ? (isBar ? "rgba(244,114,182,.62)" : "rgba(244,114,182,.27)") : (isBar ? "rgba(47,124,255,.55)" : "rgba(47,124,255,.22)");
    ctx.beginPath(); ctx.moveTo(x + .5, isBar ? 0 : 12); ctx.lineTo(x + .5, 30); ctx.stroke();
    if (isBar || state.editorGrid?.unit === "time") { ctx.fillStyle = dark ? "#f2c8d8" : "#315575"; ctx.fillText(state.editorGrid?.unit === "time" ? formatTime(t) : `${Math.floor(t / ((60 / (state.editorGrid?.bpm || 120)) * 4)) + 1}`, x + 3, 2); }
  }
}

function syncClipInputs(source) {
  const max = Math.max(0.1, state.editorDuration || 30);
  if (source === "range") {
    $("clipStartInput").value = formatTime($("clipStartRange").value);
    $("clipEndInput").value = formatTime($("clipEndRange").value);
  } else if (source === "number") {
    $("clipStartRange").value = parseTimeInput($("clipStartInput").value, $("clipStartRange").value).toFixed(3);
    $("clipEndRange").value = parseTimeInput($("clipEndInput").value, $("clipEndRange").value).toFixed(3);
  }

  const bounds = getClipBounds();
  $("clipStartInput").value = formatTime(bounds.start);
  $("clipEndInput").value = formatTime(bounds.end);
  $("clipStartRange").max = max.toFixed(3);
  $("clipEndRange").max = max.toFixed(3);
  $("clipStartRange").value = bounds.start.toFixed(3);
  $("clipEndRange").value = bounds.end.toFixed(3);
  $("clipDurationLabel").textContent = `片段：${formatTime(bounds.start)} - ${formatTime(bounds.end)}，时长 ${bounds.duration.toFixed(1)} 秒`;
  if ($("editorSelectedDurationLabel")) $("editorSelectedDurationLabel").textContent = formatTime(bounds.duration);
  drawWaveform();
  updateEditorCursor();
}

function drawWaveform() {
  const canvas = $("waveformCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const darkTheme = state.theme === "dark";
  ctx.fillStyle = darkTheme ? "#160a0f" : "#fff";
  ctx.fillRect(0, 0, width, height);

  // 动态调整 canvas 分辨率以匹配容器
  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0) {
    canvas.width = Math.round(rect.width * (window.devicePixelRatio || 1));
    canvas.height = Math.round(220 * (window.devicePixelRatio || 1));
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    var drawWidth = rect.width;
    var drawHeight = 220;
  } else {
    var drawWidth = width;
    var drawHeight = height;
  }

  ctx.fillStyle = darkTheme ? "#160a0f" : "#fff";
  ctx.fillRect(0, 0, drawWidth, drawHeight);

  const gradient = ctx.createLinearGradient(0, 0, drawWidth, 0);
  gradient.addColorStop(0, darkTheme ? "#f9a8d4" : "#9cc6ff");
  gradient.addColorStop(0.45, darkTheme ? "#ec4899" : "#5b9bff");
  gradient.addColorStop(1, darkTheme ? "#f472b6" : "#b8d6ff");
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 1.4;

  const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
  if (!allPeaks.length) {
    ctx.fillStyle = darkTheme ? "#c9a8b0" : "#78829a";
    ctx.font = "16px Microsoft YaHei UI, sans-serif";
    ctx.fillText("选择音频后会在这里显示波形", 28, drawHeight / 2);
    drawMiniWaveform();
    return;
  }

  const center = drawHeight / 2;
  const usableHeight = drawHeight * 0.72;

  // 缩放逻辑：zoom=1 时显示全部，zoom>1 时放大显示部分
  const zoom = Math.max(1, state.waveformZoom);
  const scrollPct = clamp(state.waveformScroll, 0, 1);
  const visibleCount = Math.round(allPeaks.length / zoom);
  const maxStart = Math.max(0, allPeaks.length - visibleCount);
  const startIdx = Math.round(scrollPct * maxStart);
  const endIdx = Math.min(startIdx + visibleCount, allPeaks.length);

  drawWaveRuler();
  const view = getWaveView();
  const grid = getEditorGridSeconds();
  const firstGrid = Math.ceil(view.start / grid) * grid;
  ctx.strokeStyle = darkTheme ? "rgba(244,114,182,.13)" : "rgba(47,124,255,.11)";
  ctx.lineWidth = 1;
  for (let t = firstGrid, count = 0; t <= view.end + grid && count < 600; t += grid, count += 1) {
    const x = ((t - view.start) / view.duration) * drawWidth;
    ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, drawHeight); ctx.stroke();
  }

  for (let x = 0; x < drawWidth; x += 1) {
    const peakIdx = startIdx + Math.floor((x / drawWidth) * (endIdx - startIdx));
    const peak = allPeaks[Math.min(peakIdx, allPeaks.length - 1)] || 0;
    const bar = Math.max(2, peak * usableHeight);
    ctx.beginPath();
    ctx.moveTo(x, center - bar / 2);
    ctx.lineTo(x, center + bar / 2);
    ctx.stroke();
  }

  if (state.editorSegmentMode) {
    const segments = normalizeEditorSegments(state.editorSegments);
    let cursor = view.start;
    const shadeDeletedRange = (start, end) => {
      if (end <= start) return;
      const left = ((start - view.start) / view.duration) * drawWidth;
      const right = ((end - view.start) / view.duration) * drawWidth;
      ctx.fillStyle = darkTheme ? "rgba(12, 3, 7, 0.64)" : "rgba(20, 43, 79, 0.28)";
      ctx.fillRect(Math.max(0, left), 0, Math.max(0, Math.min(drawWidth, right) - Math.max(0, left)), drawHeight);
    };
    segments.forEach((segment) => {
      shadeDeletedRange(cursor, Math.min(segment.start, view.end));
      cursor = Math.max(cursor, segment.end);
    });
    shadeDeletedRange(cursor, view.end);
    ctx.strokeStyle = darkTheme ? "#f59e0b" : "#d97706";
    ctx.lineWidth = 1.5;
    segments.forEach((segment) => {
      [segment.start, segment.end].forEach((time) => {
        if (time <= view.start || time >= view.end) return;
        const x = ((time - view.start) / view.duration) * drawWidth;
        ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, drawHeight); ctx.stroke();
      });
    });
  }

  // 选区高亮 — 将时间映射到像素
  const { start: clipStart, end: clipEnd } = getClipBounds();
  const total = Math.max(0.1, state.editorDuration);
  const left = ((clipStart / total) * allPeaks.length - startIdx) / (endIdx - startIdx) * drawWidth;
  const right = ((clipEnd / total) * allPeaks.length - startIdx) / (endIdx - startIdx) * drawWidth;
  ctx.fillStyle = darkTheme ? "rgba(236, 72, 153, 0.18)" : "rgba(76, 146, 255, 0.18)";
  ctx.fillRect(Math.max(0, left), 0, Math.max(2, right - left), drawHeight);
  ctx.strokeStyle = darkTheme ? "#ec4899" : "#2f7cff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (left > 0 && left < drawWidth) {
    ctx.moveTo(left, 0);
    ctx.lineTo(left, drawHeight);
  }
  if (right > 0 && right < drawWidth) {
    ctx.moveTo(right, 0);
    ctx.lineTo(right, drawHeight);
  }
  ctx.stroke();

  ctx.fillStyle = darkTheme ? "#f472b6" : "#2f7cff";
  ctx.font = "bold 13px Microsoft YaHei UI, sans-serif";
  ctx.textAlign = "center";
  if (left > 0 && left < drawWidth) {
    ctx.fillText(formatTime(clipStart), Math.max(34, Math.min(drawWidth - 34, left)), 18);
  }
  if (right > 0 && right < drawWidth) {
    ctx.fillText(formatTime(clipEnd), Math.max(34, Math.min(drawWidth - 34, right)), 18);
  }

  drawMiniWaveform();
  updateTimelineSelection();
  updateEditorCursor();
}

function drawMiniWaveform() {
  const canvas = $("miniWaveformCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0) {
    canvas.width = Math.round(rect.width * (window.devicePixelRatio || 1));
    canvas.height = Math.round(54 * (window.devicePixelRatio || 1));
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  }
  const width = rect.width || canvas.width;
  const height = 54;
  ctx.clearRect(0, 0, width, height);
  const darkTheme = state.theme === "dark";
  ctx.fillStyle = darkTheme ? "rgba(26, 10, 16, 0.94)" : "rgba(234, 244, 255, 0.9)";
  ctx.fillRect(0, 0, width, height);
  const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
  if (!allPeaks.length) return;
  ctx.strokeStyle = darkTheme ? "rgba(244, 114, 182, 0.68)" : "rgba(93, 151, 238, 0.55)";
  ctx.lineWidth = 1;
  const center = height / 2;
  const usableHeight = height * 0.68;
  for (let x = 0; x < width; x += 1) {
    const peak = allPeaks[Math.floor((x / width) * allPeaks.length)] || 0;
    const bar = Math.max(1, peak * usableHeight);
    ctx.beginPath();
    ctx.moveTo(x, center - bar / 2);
    ctx.lineTo(x, center + bar / 2);
    ctx.stroke();
  }

  // 在 mini-timeline 上显示选区可见范围（缩放时）
  const zoom = Math.max(1, state.waveformZoom);
  if (zoom > 1) {
    const visibleCount = Math.round(allPeaks.length / zoom);
    const maxStart = Math.max(0, allPeaks.length - visibleCount);
    const startIdx = Math.round(clamp(state.waveformScroll, 0, 1) * maxStart);
    const viewLeft = (startIdx / allPeaks.length) * width;
    const viewRight = (Math.min(startIdx + visibleCount, allPeaks.length) / allPeaks.length) * width;
    ctx.fillStyle = darkTheme ? "rgba(236, 72, 153, 0.12)" : "rgba(47, 124, 255, 0.08)";
    ctx.fillRect(viewLeft, 0, viewRight - viewLeft, height);
    ctx.strokeStyle = darkTheme ? "rgba(244, 114, 182, 0.48)" : "rgba(47, 124, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(viewLeft, 0, viewRight - viewLeft, height);
  }

  // mini-timeline 播放指针
  const player = $("editorPlayer");
  if ((state.virtualPlaying || (player && !player.paused)) && state.editorDuration > 0) {
    const total = Math.max(0.1, state.editorDuration);
    const px = (currentEditorTime() / total) * width;
    ctx.strokeStyle = "#ff446d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }
}

function updateTimelineSelection() {
  const timeline = $("clipTimeline");
  const selection = $("timelineSelection");
  const viewport = $("timelineViewport");
  if (!timeline || !selection) return;
  const { start, end } = getClipBounds();
  const total = Math.max(0.1, state.editorDuration || 30);
  const leftPct = (start / total) * 100;
  const widthPct = Math.max(0.5, ((end - start) / total) * 100);
  selection.style.left = `${leftPct}%`;
  selection.style.width = `${widthPct}%`;
  if (viewport) {
    const view = getWaveView();
    viewport.style.left = `${(view.start / total) * 100}%`;
    viewport.style.width = `${Math.max(1, (view.duration / total) * 100)}%`;
  }
}

async function loadEditorAudio(file, preserveUndo = false) {
  stopRealtimePreview(false);
  state.editorAudioPath = file || "";
  state.editorOutputPath = "";
  state.editorOutputDir = "";
  state.processedPreviewReadyKey = "";
  state.processedPreviewClipStart = 0;
  state.processedPreviewClipEnd = 0;
  state.processedPreviewTempo = 1;
  $("editorAudioName").textContent = file ? basename(file) : "默认使用当前音频";
  $("editorAudioPath").textContent = file || "也可以单独选择一首歌进行剪辑";
  $("clipStatus").textContent = "正在读取音频";
  state.waveformPeaks = [];
  drawWaveform();

  if (!file) return;
  const url = await window.gaobai.fileUrl(file);
  $("editorPlayer").src = url;

  // 新音频载入时重置升降调/变速/音量/音分为默认值
  $("pitchInput").value = 0;
  state.pitchSemitones = 0;
  const ci = $("centsInput");
  if (ci) ci.value = 0;
  state.pitchCents = 0;
  $("tempoInput").value = 1;
  state.tempoRatio = 1;
  setActiveTempoChip(1);
  $("fadeInInput").value = 0;
  $("fadeOutInput").value = 0;
  $("volumeInput").value = 1;
  // 加载新音频时清空撤回栈（除非是内部调用要求保留）
  if (!preserveUndo) {
    state.undoStack = [];
    $("undoClipBtn").disabled = true;
  }
  saveEditorPrefs();

  const bytes = await window.gaobai.readAudioFile(file);
  if (!bytes) throw new Error("读取音频失败");
  const view = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const tempCtx = new AudioContext();
  const decoded = await tempCtx.decodeAudioData(view);
  await tempCtx.close();
  // 缓存 AudioBuffer 用于实时变调变速
  state.editorAudioBuffer = decoded;
  state.dawBufferCache.set(file, decoded);
  state.editorDuration = decoded.duration || 0;
  state.editorCursor = 0;
  state.editorSegments = [];
  state.editorSegmentMode = false;
  if ($("editorTotalDurationLabel")) $("editorTotalDurationLabel").textContent = formatTime(state.editorDuration);
  const channel = decoded.getChannelData(0);
  // 高精度波形数据用于缩放浏览
  const highBuckets = 4800;
  const highStep = Math.max(1, Math.floor(channel.length / highBuckets));
  state.waveformAllPeaks = Array.from({ length: highBuckets }, (_, index) => {
    let max = 0;
    const offset = index * highStep;
    for (let i = 0; i < highStep && offset + i < channel.length; i += 1) {
      max = Math.max(max, Math.abs(channel[offset + i]));
    }
    return max;
  });
  // 适配视图用的低精度波形
  const buckets = 960;
  const step = Math.max(1, Math.floor(channel.length / buckets));
  state.waveformPeaks = Array.from({ length: buckets }, (_, index) => {
    let max = 0;
    const offset = index * step;
    for (let i = 0; i < step && offset + i < channel.length; i += 1) {
      max = Math.max(max, Math.abs(channel[offset + i]));
    }
    return max;
  });
  // 重置缩放
  state.waveformZoom = 1;
  state.waveformScroll = 0;
  $("clipStartRange").max = state.editorDuration.toFixed(1);
  $("clipEndRange").max = state.editorDuration.toFixed(1);
  $("clipStartInput").value = "0.0";
  $("clipStartRange").value = "0.0";
  $("clipEndInput").value = state.editorDuration.toFixed(1);
  $("clipEndRange").value = state.editorDuration.toFixed(1);
  $("clipStatus").textContent = `已载入：${formatTime(state.editorDuration)}`;
  if (!preserveUndo) resetDawProjectForSource(file, state.editorDuration);
  else renderDawProject();
  syncClipInputs("number");
}

function updateEffectSummary() {
  const el = $("effectSummary");
  if (!el) return;
  const pitch = state.pitchSemitones || 0;
  const cents = state.pitchCents || 0;
  const total = pitch + cents / 100;
  const tempo = state.tempoRatio || 1;
  const parts = [];
  if (Math.abs(total) >= 0.01) {
    parts.push(`升降调 ${total > 0 ? "+" : ""}${total.toFixed(2)} 半音`);
  }
  if (Math.abs(tempo - 1) >= 0.001) {
    parts.push(`速度 ${tempo.toFixed(2)}x`);
  }
  if (parts.length === 0) {
    el.classList.remove("active");
    el.textContent = "效果：原音（未处理）";
  } else {
    el.classList.add("active");
    el.textContent = "已应用效果：" + parts.join("，") + "。参数变化后会先渲染预览，完成后再播放。";
  }
}

function processedPreviewBounds(sourceTime = null) {
  const clip = getClipBounds();
  const clipStart = Number(clip.start || 0);
  const clipEnd = Number(clip.end || Math.max(clipStart + 0.5, state.editorDuration || clipStart + 0.5));
  const rawCenter = Number.isFinite(Number(sourceTime)) ? Number(sourceTime) : currentEditorTime();
  const center = clamp(rawCenter, clipStart, clipEnd);
  if (
    state.processedPreviewReadyKey &&
    center >= Number(state.processedPreviewClipStart || 0) &&
    center <= Number(state.processedPreviewClipEnd || 0)
  ) {
    return {
      start: Number(state.processedPreviewClipStart || clipStart),
      end: Number(state.processedPreviewClipEnd || clipEnd),
      center
    };
  }
  const start = Math.max(clipStart, center - 10);
  const end = Math.min(clipEnd, Math.max(start + 0.5, center + 40));
  return { start, end, center };
}

function processedPreviewKey(sourceTime = null) {
  const sourcePath = state.editorAudioPath || state.audioPath || "";
  const bounds = processedPreviewBounds(sourceTime);
  return [
    sourcePath,
    Number(bounds.start || 0).toFixed(3),
    Number(bounds.end || 0).toFixed(3),
    String($("fadeInInput")?.value ?? 0),
    String($("fadeOutInput")?.value ?? 0),
    String($("volumeInput")?.value ?? 1),
    String($("pitchInput")?.value ?? 0),
    String($("centsInput")?.value ?? 0),
    String($("tempoInput")?.value ?? 1),
  ].join("|");
}

function setEditorPlayDisabled(disabled) {
  const button = $("editorPlayBtn");
  if (!button) return;
  button.disabled = false;
  button.setAttribute("aria-busy", Boolean(disabled) ? "true" : "false");
  button.classList.remove("is-disabled");
}

function startPreviewProgress(message = "Rendering preview") {
  clearInterval(state.processedPreviewProgressTimer);
  state.processedPreviewStartedAt = Date.now();
  state.processedPreviewProgress = 1;
  $("clipStatus").textContent = `${message}... 1%`;
  state.processedPreviewProgressTimer = setInterval(() => {
    const elapsed = Math.max(1, Math.round((Date.now() - state.processedPreviewStartedAt) / 1000));
    const next = Math.min(95, Math.max(state.processedPreviewProgress || 1, Math.round(elapsed * 3)));
    state.processedPreviewProgress = next;
    $("clipStatus").textContent = `${message}... ${next}% (${elapsed}s)`;
  }, 1000);
}

function updatePreviewProgress(progress, message = "Rendering preview") {
  const safe = clamp(Number(progress) || 0, 1, 99);
  state.processedPreviewProgress = Math.max(state.processedPreviewProgress || 0, safe);
  const elapsed = state.processedPreviewStartedAt ? Math.max(0, Math.round((Date.now() - state.processedPreviewStartedAt) / 1000)) : 0;
  $("clipStatus").textContent = `${message}... ${state.processedPreviewProgress}%${elapsed ? ` (${elapsed}s)` : ""}`;
}

function stopPreviewProgress(message = "") {
  clearInterval(state.processedPreviewProgressTimer);
  state.processedPreviewProgressTimer = null;
  if (message) $("clipStatus").textContent = message;
}

function waitForAudioReady(player, timeoutMs = 5000) {
  if (!player) return Promise.resolve(false);
  if (player.readyState >= 2) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      player.removeEventListener("canplay", onReady);
      player.removeEventListener("loadedmetadata", onReady);
      player.removeEventListener("error", onError);
      resolve(ok);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(player.readyState >= 1), timeoutMs);
    player.addEventListener("canplay", onReady, { once: true });
    player.addEventListener("loadedmetadata", onReady, { once: true });
    player.addEventListener("error", onError, { once: true });
  });
}

function sourceTimeToProcessedPreviewTime(sourceTime) {
  const tempo = Math.max(0.001, Number(state.processedPreviewTempo) || 1);
  return Math.max(0, (Number(sourceTime || 0) - Number(state.processedPreviewClipStart || 0)) / tempo);
}

async function restoreOriginalEditorPlayer() {
  const sourcePath = state.editorAudioPath || state.audioPath;
  const player = $("editorPlayer");
  if (!sourcePath || !player) return;
  const url = await window.gaobai.fileUrl(sourcePath);
  const currentUrl = player.src || "";
  if (!currentUrl || currentUrl.startsWith(url)) return;
  const t = clamp(currentEditorTime(), 0, state.editorDuration || 0);
  player.pause();
  player.src = url;
  player.currentTime = Math.min(t, state.editorDuration || t);
}

async function previewClip() {
  const sourcePath = state.editorAudioPath || state.audioPath;
  if (!sourcePath) {
    log("请先选择要剪辑的音频。");
    return;
  }
  if (!state.editorAudioPath) await loadEditorAudio(sourcePath);
  await renderProcessedPreview(true);
}

async function renderProcessedPreview(autoplay = true, resumeSourceTime = null) {
  const sourcePath = state.editorAudioPath || state.audioPath;
  const player = $("editorPlayer");
  if (!sourcePath || !player) return false;
  const seq = ++state.processedPreviewSeq;
  const resumeAt = Number.isFinite(Number(resumeSourceTime)) ? Number(resumeSourceTime) : currentEditorTime();
  const previewBounds = processedPreviewBounds(resumeAt);
  const readyKey = processedPreviewKey(resumeAt);
  state.processedPreviewReadyKey = "";
  state.processedPreviewBusy = true;
  setEditorPlayDisabled(true);
  stopRealtimePreview(true);
  try { player.pause(); } catch (_) {}
  startPreviewProgress(`Rendering preview ${Number(previewBounds.start).toFixed(1)}s-${Number(previewBounds.end).toFixed(1)}s`);
  const payload = {
    sourcePath,
    start: previewBounds.start,
    end: previewBounds.end,
    fadeIn: $("fadeInInput").value,
    fadeOut: $("fadeOutInput").value,
    volume: $("volumeInput").value,
    pitch: $("pitchInput").value,
    cents: $("centsInput") ? $("centsInput").value : 0,
    tempo: $("tempoInput").value,
  };
  try {
    log(`正在生成正确的升降调/变速预览：片段 ${Number(payload.start).toFixed(2)}s-${Number(payload.end).toFixed(2)}s，音量=${payload.volume}，半音=${payload.pitch}，音分=${payload.cents}，速度=${payload.tempo}x`);
    const result = await window.gaobai.exportClip(payload);
    if (seq !== state.processedPreviewSeq) return false;
    if (!result || !result.ok) {
      stopPreviewProgress("Preview failed");
      $("clipStatus").textContent = `Preview failed: ${(result && result.message) || "unknown error"}`;
      log((result && result.message) || "生成预览失败。");
      return false;
    }
    if (result.log) {
      result.log.split(/\r?\n/).filter(Boolean).slice(-6).forEach((line) => log(`[预览后端] ${line}`));
    }
    if (result.stderr) {
      result.stderr.split(/\r?\n/).filter(Boolean).slice(-3).forEach((line) => log(`[预览后端错误] ${line}`));
    }
    if (result.pitch !== undefined || result.tempo !== undefined) {
      log(`后端确认参数：半音=${result.pitch ?? "?"}，速度=${result.tempo ?? "?"}x`);
    }
    stopRealtimePreview(true);
    const url = await window.gaobai.fileUrl(result.outputPath);
    player.pause();
    player.removeAttribute("src");
    player.load();
    player.src = `${url}${url.includes("?") ? "&" : "?"}preview=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await waitForAudioReady(player);
    const tempo = Math.max(0.001, Number(payload.tempo) || 1);
    state.processedPreviewClipStart = Number(payload.start) || 0;
    state.processedPreviewClipEnd = Number(payload.end) || state.processedPreviewClipStart;
    state.processedPreviewTempo = tempo;
    const previewDuration = Math.max(0, (Number(payload.end) - Number(payload.start)) / tempo);
    const previewTime = clamp((resumeAt - Number(payload.start)) / tempo, 0, previewDuration || Number.MAX_SAFE_INTEGER);
    player.currentTime = previewTime;
    if ($("playbackTimeLabel")) $("playbackTimeLabel").textContent = formatTime(previewTime);
    updateWavePlayhead();
    drawMiniWaveform();
    state.processedPreviewReadyKey = readyKey;
    setEditorPlayDisabled(false);
    stopPreviewProgress("Preview ready - playing");
    if (autoplay) {
      try {
        await player.play();
      } catch (playError) {
        $("clipStatus").textContent = "Preview ready - press play";
        log("Preview autoplay failed: " + playError.message);
      }
    }
    log("处理预览已生成并载入。正式导出仍会基于原始音频处理。 ");
    state.processedPreviewReadyKey = readyKey;
    setEditorPlayDisabled(false);
    return true;
  } catch (err) {
    stopPreviewProgress("Preview failed");
    if (seq === state.processedPreviewSeq) log("生成预览失败：" + err.message);
    return false;
  } finally {
    if (seq === state.processedPreviewSeq) {
      state.processedPreviewBusy = false;
      setEditorPlayDisabled(false);
    }
  }
}

function scheduleProcessedPreview() {
  clearTimeout(state.processedPreviewTimer);
  const resumeAt = currentEditorTime();
  pauseEditorPlayback();
  state.processedPreviewReadyKey = "";
  setEditorPlayDisabled(true);
  $("clipStatus").textContent = "Rendering preview...";
  state.processedPreviewTimer = setTimeout(() => {
    renderProcessedPreview(true, resumeAt);
  }, 500);
}
window.gaobai.onBackendEvent(handleBackendEvent);
window.gaobai.onUploadBatchEvent?.(handleUploadBatchEvent);
if (window.gaobai.onEditorEvent) {
  window.gaobai.onEditorEvent((event) => {
    if (!event || typeof event !== "object") return;
    if (state.dawExporting && event.type === "status") {
      setDawExportProgress(Math.min(94, Number(event.progress) || 12), event.message || "正在导出混音");
    }
    if (!state.processedPreviewBusy) return;
    if (event.type === "status") {
      updatePreviewProgress(event.progress || state.processedPreviewProgress || 1, event.message || "Rendering preview");
      log(`[preview] ${event.message || "Rendering preview"} ${event.progress !== undefined ? event.progress + "%" : ""}`);
    } else if (event.type === "log" && event.message) {
      log(`[editor] ${event.message}`);
    } else if (event.type === "cancelled") {
      stopPreviewProgress("Preview render cancelled");
      state.processedPreviewBusy = false;
      setEditorPlayDisabled(false);
    }
  });
}
window.gaobai.onSeparationEvent((event) => {
  if (!event || typeof event !== "object") return;
  if (event.type === "gpu-runtime-download") {
    const statusEl = $("separationDeviceStatus");
    if (event.status === "progress") {
      const doneGb = (Number(event.downloaded || 0) / 1024 / 1024 / 1024).toFixed(2);
      const totalGb = event.total ? (Number(event.total) / 1024 / 1024 / 1024).toFixed(2) : "--";
      if (statusEl) statusEl.textContent = `GPU组件下载中 ${event.percent || 0}% · ${doneGb}/${totalGb} GB`;
      setSeparationProgress(Math.max(3, Math.min(80, Math.round((Number(event.percent) || 0) * 0.8))));
    } else if (event.status === "extracting") {
      if (statusEl) statusEl.textContent = event.message || "正在自动安装GPU组件";
      setSeparationProgress(86);
    } else if (event.status === "verifying") {
      if (statusEl) statusEl.textContent = event.message || "正在验证CUDA运行环境";
      setSeparationProgress(94);
    } else if (event.status === "complete") {
      if (statusEl) statusEl.textContent = `${event.gpuName || "NVIDIA GPU"} · GPU组件已安装`;
      setSeparationProgress(100);
      refreshSeparationDevices();
    } else if (event.status === "cancelled") {
      if (statusEl) statusEl.textContent = "GPU组件下载安装已取消，可稍后继续";
      setSeparationProgress(0);
    } else if (event.status === "error") {
      if (statusEl) statusEl.textContent = `GPU组件安装失败：${event.message || "未知错误"}`;
      setSeparationProgress(0);
    } else if (statusEl && event.message) {
      statusEl.textContent = event.message;
    }
  } else if (event.type === "model-download") {
    const statusEl = $("separationModelStatus");
    if (event.status === "progress") {
      const totalMb = event.total ? (event.total / 1024 / 1024).toFixed(1) : "--";
      const doneMb = event.downloaded ? (event.downloaded / 1024 / 1024).toFixed(1) : "0";
      if (statusEl) statusEl.textContent = `下载中 ${event.percent || 0}% · ${doneMb}/${totalMb} MB · ${event.source || ""}`;
      setSeparationProgress(Math.max(4, Math.min(99, Number(event.percent) || 0)));
    } else if (event.status === "complete") {
      if (statusEl) statusEl.textContent = event.message || "模型下载完成";
      log(event.message || "模型下载完成。");
      setSeparationProgress(0);
      refreshSeparationModels();
    } else if (event.status === "cancelled") {
      if (statusEl) statusEl.textContent = "模型下载已取消";
      log(event.message || "模型下载已取消。");
      setSeparationProgress(0);
    } else {
      if (statusEl && event.message) statusEl.textContent = event.message;
      if (event.message) log(event.message);
    }
  } else if (event.type === "status") {
    $("separationStatus").textContent = event.message || "处理中";
    if (event.progress !== undefined) setSeparationProgress(event.progress);
    log(event.message || "伴奏/人声分离中");
  } else if (event.type === "device") {
    const usingGpu = String(event.actual || "").startsWith("cuda");
    $("separationDeviceStatus").textContent = usingGpu
      ? "正在使用 NVIDIA GPU 加速处理"
      : "正在使用 CPU 稳定处理";
    log(event.message || (usingGpu ? "正在使用 GPU 加速。" : "正在使用 CPU 处理。"));
  } else if (event.type === "device-fallback") {
    $("separationStatus").textContent = "GPU不可用，已切换CPU";
    $("separationDeviceStatus").textContent = "GPU加速失败 · 已自动回退CPU继续处理";
    setSeparationProgress(8);
    log(`${event.message || "已自动切换CPU"}：${event.reason || ""}`);
  } else if (event.type === "log") {
    log(event.message || "");
  } else if (event.type === "result") {
    state.vocalsPath = event.vocalsPath || "";
    state.instrumentalPath = event.instrumentalPath || "";
    state.separationOutputDir = event.outputDir || "";
    $("separationStatus").textContent = "分离完成";
    $("separationOutputDir").textContent = state.separationOutputDir || "输出完成";
    if ($("separationLoadedModel")) $("separationLoadedModel").textContent = `已加载模型：${event.model || selectedSeparationModel().label || ""}`;
    setSeparationProgress(100);
    playTaskSound("success");
    log("伴奏/人声分离完成，已生成人声和伴奏。");
    // 加载伴奏和人声波形
    state.stemWaveformPeaks = { instrumental: [], vocals: [] };
    loadStemWaveform("instrumental");
    loadStemWaveform("vocals");
  } else if (event.type === "error") {
    playTaskSound("failure");
    $("separationStatus").textContent = "分离失败";
    log(`分离失败：${event.message || ""}`);
  } else if (event.type === "failed") {
    playTaskSound("failure");
    $("separationStatus").textContent = "分离失败";
    log(`分离进程退出，代码：${event.code}`);
  } else if (event.type === "cancelled") {
    $("separationStatus").textContent = "已取消";
    log("已取消分离任务。");
  }
});

function currentEditorTime() {
  const player = $("editorPlayer");
  if (state.virtualPlaying) {
    const elapsed = Math.max(0, (performance.now() - (state.virtualStartedAt || performance.now())) / 1000);
    return clamp((state.virtualStartTime || 0) + elapsed * (state.virtualClockTempo || 1), 0, state.editorDuration || Number.MAX_SAFE_INTEGER);
  }
  if (
    player &&
    state.processedPreviewReadyKey &&
    Number(state.processedPreviewClipEnd || 0) > Number(state.processedPreviewClipStart || 0)
  ) {
    const tempo = Math.max(0.001, Number(state.processedPreviewTempo) || 1);
    return clamp(Number(state.processedPreviewClipStart || 0) + (player.currentTime || 0) * tempo, 0, state.editorDuration || Number.MAX_SAFE_INTEGER);
  }
  return clamp(player ? (player.currentTime || 0) : 0, 0, state.editorDuration || Number.MAX_SAFE_INTEGER);
}

function updateMainWavePlayhead(time = currentEditorTime()) {
  const playhead = $("wavePlayhead");
  if (!playhead || !state.editorDuration) return;
  if (followEditorTimeInView(time)) drawWaveform();
  const total = Math.max(0.1, state.editorDuration);
  const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
  if (!allPeaks.length) {
    playhead.style.display = "none";
    return;
  }
  const zoom = Math.max(1, state.waveformZoom || 1);
  const visibleCount = Math.max(1, Math.round(allPeaks.length / zoom));
  const maxStart = Math.max(0, allPeaks.length - visibleCount);
  const startIdx = Math.round(clamp(state.waveformScroll, 0, 1) * maxStart);
  const endIdx = Math.min(startIdx + visibleCount, allPeaks.length);
  const peakIdx = clamp(time, 0, total) / total * allPeaks.length;
  const denominator = Math.max(1, endIdx - startIdx);
  const px = ((peakIdx - startIdx) / denominator) * 100;
  if (px >= 0 && px <= 100) {
    playhead.style.display = "";
    playhead.style.left = `${px}%`;
  } else {
    playhead.style.display = "none";
  }
}

function setVirtualClock(time, playing, tempo = 1) {
  state.virtualStartTime = clamp(time || 0, 0, state.editorDuration || Number.MAX_SAFE_INTEGER);
  state.virtualStartedAt = performance.now();
  state.virtualClockTempo = Math.max(0.5, Math.min(2, Number(tempo) || 1));
  state.virtualPlaying = Boolean(playing);
}

function stopRealtimeWebAudio() {
  if (state.realtimeSource) {
    try { state.realtimeSource.onended = null; } catch (_) {}
    try { state.realtimeSource.stop(0); } catch (_) {}
    try { state.realtimeSource.disconnect(); } catch (_) {}
    state.realtimeSource = null;
  }
  if (state.realtimeSoundTouch) {
    try { state.realtimeSoundTouch.disconnect(); } catch (_) {}
    state.realtimeSoundTouch = null;
  }
  if (state.realtimeGain) {
    try { state.realtimeGain.disconnect(); } catch (_) {}
    state.realtimeGain = null;
  }
}

async function ensureRealtimeAudioContext() {
  if (!state.audioContext || state.audioContext.state === "closed") {
    state.audioContext = new AudioContext();
  }
  if (state.audioContext.state === "suspended") {
    try { await state.audioContext.resume(); } catch (_) {}
  }
  return state.audioContext;
}

async function loadSoundTouchNodeClass() {
  if (state.soundTouchNodeClass) return state.soundTouchNodeClass;
  if (state.soundTouchLoadFailed) return null;
  try {
    const externalUrl = window.gaobai.soundTouchModuleUrl
      ? await window.gaobai.soundTouchModuleUrl()
      : "";
    const mod = await import(externalUrl || "./vendor/soundtouchjs/SoundTouchNode.js");
    state.soundTouchNodeClass = mod.SoundTouchNode;
    return state.soundTouchNodeClass;
  } catch (error) {
    state.soundTouchLoadFailed = true;
    log("SoundTouch realtime engine load failed: " + error.message);
    return null;
  }
}

async function ensureSoundTouchRegistered(ctx) {
  const SoundTouchNode = await loadSoundTouchNodeClass();
  if (!SoundTouchNode) return null;
  if (!state.soundTouchRegistered) {
    const processorUrls = [];
    try {
      const source = window.gaobai.soundTouchProcessorSource
        ? await window.gaobai.soundTouchProcessorSource()
        : "";
      if (source) {
        if (state.soundTouchProcessorBlobUrl) URL.revokeObjectURL(state.soundTouchProcessorBlobUrl);
        state.soundTouchProcessorBlobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        processorUrls.push(state.soundTouchProcessorBlobUrl);
      }
    } catch (error) {
      log("SoundTouch processor source load failed: " + error.message);
    }
    const externalUrl = window.gaobai.soundTouchProcessorUrl
      ? await window.gaobai.soundTouchProcessorUrl()
      : "";
    if (externalUrl) processorUrls.push(externalUrl);
    processorUrls.push(new URL("./vendor/soundtouchjs/soundtouch-processor.js", window.location.href).toString());
    let lastError = null;
    for (const processorUrl of [...new Set(processorUrls.filter(Boolean))]) {
      try {
        await SoundTouchNode.register(ctx, processorUrl);
        state.soundTouchRegistered = true;
        return SoundTouchNode;
      } catch (error) {
        lastError = error;
        log(`SoundTouch processor register failed (${processorUrl}): ${error.message}`);
      }
    }
    throw lastError || new Error("SoundTouch processor register failed");
  }
  return SoundTouchNode;
}

function applyRealtimeWebAudioParams(params = editorRealtimeParams()) {
  const now = state.audioContext ? state.audioContext.currentTime : 0;
  if (state.realtimeSoundTouch) {
    try {
      state.realtimeSoundTouch.pitch.cancelScheduledValues(now);
      state.realtimeSoundTouch.pitch.setTargetAtTime(1, now, 0.015);
    } catch (_) {
      try { state.realtimeSoundTouch.pitch.value = 1; } catch (_) {}
    }
    try {
      state.realtimeSoundTouch.pitchSemitones.cancelScheduledValues(now);
      state.realtimeSoundTouch.pitchSemitones.setTargetAtTime(params.totalSemitones || 0, now, 0.015);
    } catch (_) {
      try { state.realtimeSoundTouch.pitchSemitones.value = params.totalSemitones || 0; } catch (_) {}
    }
    try {
      state.realtimeSoundTouch.playbackRate.cancelScheduledValues(now);
      state.realtimeSoundTouch.playbackRate.setTargetAtTime(params.tempo || 1, now, 0.015);
    } catch (_) {
      try { state.realtimeSoundTouch.playbackRate.value = params.tempo || 1; } catch (_) {}
    }
  }
  if (state.realtimeSource) {
    try {
      state.realtimeSource.playbackRate.cancelScheduledValues(now);
      state.realtimeSource.playbackRate.setTargetAtTime(params.tempo || 1, now, 0.015);
    } catch (_) {
      try { state.realtimeSource.playbackRate.value = params.tempo || 1; } catch (_) {}
    }
  }
  if (state.realtimeGain) {
    try {
      state.realtimeGain.gain.cancelScheduledValues(now);
      state.realtimeGain.gain.setTargetAtTime(Math.min(1.5, params.volume || 1), now, 0.02);
    } catch (_) {
      try { state.realtimeGain.gain.value = Math.min(1.5, params.volume || 1); } catch (_) {}
    }
  }
}

async function startRealtimeWebAudioFrom(time) {
  if (!state.editorAudioBuffer) return false;
  const params = editorRealtimeParams();
  const ctx = await ensureRealtimeAudioContext();
  const SoundTouchNode = await ensureSoundTouchRegistered(ctx);
  if (!SoundTouchNode) return false;
  stopRealtimeWebAudio();
  const source = ctx.createBufferSource();
  const soundTouch = new SoundTouchNode({ context: ctx, interpolationStrategy: "lanczos" });
  const gain = ctx.createGain();
  source.buffer = state.editorAudioBuffer;
  source.playbackRate.value = params.tempo || 1;
  soundTouch.pitch.value = 1;
  soundTouch.pitchSemitones.value = params.totalSemitones || 0;
  soundTouch.playbackRate.value = params.tempo || 1;
  try { soundTouch.setStretchParameters({ quickSeek: true, overlapMs: 8 }); } catch (_) {}
  gain.gain.value = Math.min(1.5, params.volume || 1);
  source.connect(soundTouch);
  soundTouch.connect(gain);
  gain.connect(ctx.destination);
  state.realtimeSource = source;
  state.realtimeSoundTouch = soundTouch;
  state.realtimeGain = gain;
  state.soundTouchUnderrunWarned = false;
  try {
    soundTouch.addEventListener("metrics", (event) => {
      const metrics = event.detail || {};
      if (!state.soundTouchUnderrunWarned && Number(metrics.underrunCount || 0) > 0) {
        state.soundTouchUnderrunWarned = true;
        log("Realtime preview warning: audio buffer underrun detected.");
      }
    });
  } catch (_) {}
  const bounds = getClipBounds();
  const startAt = clamp(time || 0, bounds.start || 0, bounds.end || state.editorDuration || 0);
  setVirtualClock(startAt, true, params.tempo);
  source.onended = () => {
    if (state.realtimeSource === source && state.virtualPlaying) pauseEditorPlayback();
  };
  try {
    source.start(0, startAt);
    return true;
  } catch (error) {
    stopRealtimeWebAudio();
    log("Realtime audio engine failed: " + error.message);
    return false;
  }
}

function startRealtimePlayheadLoop() {
  if (state.realtimeRAF) cancelAnimationFrame(state.realtimeRAF);
  const loop = () => {
    const player = $("editorPlayer");
    const preview = $("previewPlayer");
    const anyPlaying = state.virtualPlaying || (player && !player.paused) || (preview && !preview.paused);
    if (!anyPlaying || !player) {
      state.realtimeRAF = null;
      return;
    }
    const t = currentEditorTime();
    if (Number.isFinite(t)) {
      if ($("playbackTimeLabel")) $("playbackTimeLabel").textContent = formatTime(t);
      try { updateMainWavePlayhead(t); } catch (_) {}
      try { maybeQueueNextRealtimeWindow(t); } catch (_) {}
    }
    state.realtimeRAF = requestAnimationFrame(loop);
  };
  state.realtimeRAF = requestAnimationFrame(loop);
}

function stopRealtimePreview(syncTime = true) {
  const player = $("editorPlayer");
  const preview = $("previewPlayer");
  const syncedTime = syncTime ? currentEditorTime() : (player ? player.currentTime || 0 : 0);
  if (state.realtimeRAF) {
    try { cancelAnimationFrame(state.realtimeRAF); } catch (_) {}
    state.realtimeRAF = null;
  }
  if (state.previewRenderTimer) {
    clearTimeout(state.previewRenderTimer);
    state.previewRenderTimer = null;
  }
  if (preview) {
    try { preview.pause(); } catch (_) {}
    preview.removeAttribute("src");
    try { preview.load(); } catch (_) {}
  }
  stopRealtimeWebAudio();
  if (syncTime && player && Number.isFinite(syncedTime)) {
    player.currentTime = syncedTime;
  }
  state.virtualPlaying = false;
  state.realtimeStarting = false;
  state.realtimePlaying = false;
  state.previewUsingRendered = false;
  state.previewRenderSeq += 1;
  state.previewPendingKey = "";
  state.previewActiveRenderKey = "";
  return syncedTime;
}

function pauseEditorPlayback() {
  const player = $("editorPlayer");
  const preview = $("previewPlayer");
  const t = currentEditorTime();
  state.virtualPlaying = false;
  state.realtimeStarting = false;
  state.realtimePlaying = false;
  if (state.realtimeRAF) {
    try { cancelAnimationFrame(state.realtimeRAF); } catch (_) {}
    state.realtimeRAF = null;
  }
  if (state.previewFadeTimer) {
    clearInterval(state.previewFadeTimer);
    state.previewFadeTimer = null;
  }
  stopRealtimeWebAudio();
  try { if (preview) preview.pause(); } catch (_) {}
  try { if (player) player.pause(); } catch (_) {}
  if (player && Number.isFinite(t)) player.currentTime = t;
  if ($("editorPlayBtn")) $("editorPlayBtn").textContent = "▶";
  updateWavePlayhead();
  drawMiniWaveform();
  return t;
}

function seekEditorPlayback(time, keepPlaying = true) {
  const player = $("editorPlayer");
  const preview = $("previewPlayer");
  if (!player) return;
  const target = clamp(time || 0, 0, state.editorDuration || player.duration || 0);
  player.currentTime = target;
  if (preview) {
    try { preview.pause(); } catch (_) {}
  }
  stopRealtimeWebAudio();
  if ((state.virtualPlaying || state.realtimePlaying) && keepPlaying) {
    const params = editorRealtimeParams();
    setVirtualClock(target, true, params.active ? params.tempo : 1);
    state.previewUsingRendered = false;
    if (params.active) {
      startRealtimePreviewFrom(target);
    } else {
      player.play().catch(() => {});
    }
    startRealtimePlayheadLoop();
  } else {
    try { if (typeof updateWavePlayhead === "function") updateWavePlayhead(); } catch (_) {}
    try { if (typeof drawMiniWaveform === "function") drawMiniWaveform(); } catch (_) {}
  }
}

function pauseAllAudio() {
  stopRealtimePreview(true);
  const ids = ["editorPlayer", "audioPlayer", "previewPlayer", "instrumentalPlayer", "vocalsPlayer"];
  ids.forEach((id) => {
    const el = $(id);
    if (el && typeof el.pause === "function") {
      try { el.pause(); } catch (_) {}
    }
  });
  if (state.stemAudio && typeof state.stemAudio.pause === "function") {
    try { state.stemAudio.pause(); } catch (_) {}
  }
}

function goToPanel(panelId) {
  if (!panelId) return;
  const activePage = document.querySelector(".module-page.active");
  if (!activePage || activePage.id !== panelId) pauseAllAudio();
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.panel === panelId);
  });
  document.querySelectorAll(".module-page").forEach((page) => {
    page.classList.toggle("active", page.id === panelId);
  });
  if (panelId === "editorPage") {
    setTimeout(drawWaveform, 80);
  }
}

// ── 定时轮询：每 120 秒检查更新和公告 ──
let _pollingTimer = null;
const POLLING_INTERVAL_MS = 120_000; // 120 秒

function startPolling() {
  // 内部使用版：不做官网更新/公告轮询
  if (_pollingTimer) return;
  _pollingTimer = setInterval(async () => {
    try {
      // 保留空轮询，避免其它逻辑依赖定时器；更新/公告检查已禁用
    } catch (_) {
    }
  }, POLLING_INTERVAL_MS);
}

// ── 官网账号权益验证 ──

function isNetworkOnlyLicenseError(status) {
  return status && status.reason_code === "license_network_error";
}

function shouldLockFromOnlineLicense(status) {
  if (!status || status.valid) return false;
  return !isNetworkOnlyLicenseError(status);
}

async function runStartupLicenseVerify(localStatus) {
  // 内部使用版：不做启动授权核对
  updateLicenseUI({ ok: true, valid: true, is_permanent: true });
}

function accountInitials(name) {
  const text = String(name || "GB").trim();
  return text ? text.slice(0, 2).toUpperCase() : "GB";
}

function accountLicenseStatus(account) {
  const loggedIn = Boolean(account?.loggedIn);
  const reasonMessages = {
    membership_required: "当前账号没有有效权益，请前往商城购买。",
    device_limit_reached: "绑定设备已达上限，请先解绑旧设备。",
    concurrent_limit_reached: "同时在线设备已达上限，请先退出其他设备。",
    session_expired: "登录会话已过期，请重新登录。",
    session_replaced: "当前会话已被其他登录替换，请重新登录。",
    device_mismatch: "登录凭证与当前设备不匹配，请重新登录。",
    device_revoked: "当前设备已被解绑或停用，请重新登录。",
    entitlement_expired: "会员权益已到期，请续费后继续使用。",
    session_service_unavailable: "账号会话服务暂时不可用，请稍后重试。",
  };
  return {
    ok: Boolean(account?.valid),
    valid: Boolean(account?.valid),
    source: "account",
    reason_code: account?.reason_code || "account_no_entitlement",
    reason: account?.valid
      ? "官网账号权益有效"
      : (reasonMessages[account?.reason_code] || (loggedIn ? "当前官网账号没有可用的软件权益" : "请登录官网账号同步软件权益")),
    expires_at: account?.expires_at || null,
    is_permanent: Boolean(account?.is_permanent),
    duration_label: account?.duration_label || "",
    countdown_text: account?.countdown_text || "未激活",
    account: account?.user || null,
  };
}

function formatAccountEntitlementMeta(account) {
  if (account?.is_permanent) return "永久权益 · 已解锁";
  const expiresAt = Date.parse(account?.expires_at || "");
  if (Number.isFinite(expiresAt)) {
    return `有效至 ${new Date(expiresAt).toLocaleDateString("zh-CN")} · 已解锁`;
  }
  return `${account?.countdown_text || account?.duration_label || "会员权益"} · 已解锁`;
}

function accountAvatarIdentity(account) {
  const user = account?.user || {};
  return String(user.id || user.email || "").trim().toLowerCase();
}

function cachedAccountAvatarUrl(identity) {
  if (!identity) return "";
  try {
    const cached = JSON.parse(localStorage.getItem(ACCOUNT_AVATAR_CACHE_KEY) || "{}");
    return cached.identity === identity ? String(cached.url || "") : "";
  } catch (_) {
    return "";
  }
}

function isOfficialAccountAvatarUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && ["gaobaijifeng.top", "gblicensehub.xyz"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch (_) {
    return false;
  }
}

function showAccountAvatarFallback(avatar, name) {
  avatar.classList.remove("has-avatar-image");
  avatar.textContent = accountInitials(name);
  avatar.style.backgroundImage = "";
  state.accountAvatarUrl = "";
}

function updateStableAccountAvatar(account, name) {
  const avatar = $("accountAvatar");
  if (!avatar) return;
  const loggedIn = Boolean(account?.loggedIn);
  const identity = loggedIn ? accountAvatarIdentity(account) : "";
  if (!loggedIn) {
    state.accountAvatarIdentity = "";
    state.accountAvatarSeq += 1;
    showAccountAvatarFallback(avatar, name);
    return;
  }
  if (!identity) {
    if (!avatar.classList.contains("has-avatar-image")) showAccountAvatarFallback(avatar, name);
    return;
  }

  const directUrl = String(account?.user?.avatar_url || "").trim();
  const officialUrl = isOfficialAccountAvatarUrl(directUrl) ? directUrl : "";
  const avatarUrl = officialUrl || cachedAccountAvatarUrl(identity);
  const identityChanged = state.accountAvatarIdentity && state.accountAvatarIdentity !== identity;
  state.accountAvatarIdentity = identity;
  if (identityChanged) showAccountAvatarFallback(avatar, name);
  if (!avatarUrl) {
    if (!avatar.classList.contains("has-avatar-image")) showAccountAvatarFallback(avatar, name);
    return;
  }
  if (state.accountAvatarUrl === avatarUrl && avatar.classList.contains("has-avatar-image")) return;

  const sequence = ++state.accountAvatarSeq;
  const avatarLoader = window.gaobai.accountAvatarSource;
  if (typeof avatarLoader !== "function") {
    if (!avatar.classList.contains("has-avatar-image")) showAccountAvatarFallback(avatar, name);
    return;
  }
  avatarLoader(avatarUrl).then((result) => {
    if (sequence !== state.accountAvatarSeq || state.accountAvatarIdentity !== identity) return;
    const source = String(result?.source || "");
    if (!result?.ok || !source.startsWith("data:image/")) {
      if (!avatar.classList.contains("has-avatar-image")) showAccountAvatarFallback(avatar, name);
      return;
    }
    avatar.textContent = "";
    avatar.style.backgroundImage = `url(${JSON.stringify(source)})`;
    avatar.classList.add("has-avatar-image");
    state.accountAvatarUrl = avatarUrl;
    try {
      localStorage.setItem(ACCOUNT_AVATAR_CACHE_KEY, JSON.stringify({ identity, url: avatarUrl }));
    } catch (_) {}
  }).catch(() => {
    if (sequence === state.accountAvatarSeq && !avatar.classList.contains("has-avatar-image")) {
      showAccountAvatarFallback(avatar, name);
    }
  });
}

function updateAccountUI(account) {
  // 内部使用版：官网账号UI已移除，此函数仅维护状态，不做任何显示更新
  const next = account && typeof account === "object" ? account : { loggedIn: false, valid: false };
  state.account = next;
}

async function refreshAccountStatus() {
  // 内部使用版：不做官网账号联网校验，恒为未登录/恒授权
  updateAccountUI({ loggedIn: false, valid: false });
  updateLicenseUI({ ok: true, valid: true, is_permanent: true });
  return { loggedIn: false, valid: false };
}

async function beginAccountLogin() {
  // 内部使用版：官网账号登录已移除
  log("官网账号登录已停用。", "warn");
  return;
}

function showAccountLoginOverlay() {
  // 内部使用版：官网账号登录UI已移除
}

function hideAccountLoginOverlay() {
  // 内部使用版：官网账号登录UI已移除
}

function setAccountPasswordVisibility(visible) {
  // 内部使用版：官网账号登录UI已移除
}

function syncAccountLoginOptions() {
  // 内部使用版：官网账号登录UI已移除
}

async function loadAccountLoginPreferences() {
  // 内部使用版：官网账号登录UI已移除
}

let accountAssistMode = "register";
let accountAssistCooldownUntil = 0;
let accountAssistCooldownTimer = null;

function setAccountAssistMessage(message, success = false) {
  // 内部使用版：官网注册UI已移除
}

function updateAccountAssistCooldown() {
  // 内部使用版：官网注册UI已移除
}

function startAccountAssistCooldown(seconds = 60) {
  // 内部使用版：官网注册UI已移除
}

function showAccountAssist(mode) {
  // 内部使用版：官网注册UI已移除
}

function hideAccountAssist(returnToLogin = true) {
  // 内部使用版：官网注册UI已移除
}

function setAccountAssistSubmitting(submitting) {
  // 内部使用版：官网注册UI已移除
}

function setupAccountAssist() {
  // 内部使用版：官网注册绑定已移除
}

function formatAccountDeviceTime(value) {
  // 内部使用版：设备管理UI已移除
  return "--";
}

function hideAccountDevicesOverlay() {
  // 内部使用版：设备管理UI已移除
}

function renderAccountDevices(result) {
  // 内部使用版：设备管理UI已移除
}

async function refreshAccountDevices() {
  // 内部使用版：设备管理UI已移除
  return { ok: true, devices: [] };
}

async function showAccountDevicesOverlay() {
  // 内部使用版：设备管理UI已移除
}

function setAccountLoginSubmitting(submitting) {
  // 内部使用版：官网账号登录UI已移除
}

function setupEmbeddedAccountLogin() {
  // 内部使用版：官网账号登录/注册UI已移除，无需绑定
}

function setupAccountControls() {
  // 内部使用版：官网账号/会员菜单已移除，无需绑定
}

function runStartupBackgroundTasks(localStatus) {
  // 内部使用版：不注册官网账号，不做授权核对，不检查更新/公告
}

async function initLicense() {
  // 内部使用版：授权恒为永久有效，不做任何联网核对或激活引导
  updateLicenseUI({ ok: true, valid: true, is_permanent: true });
  runStartupBackgroundTasks(null);
  startPolling();
}

// ============================================================================
// 启动核对失败 → 引导弹窗
//  - 一码一机：reason_code=device_already_bound → 弹"换绑"提示
//  - 到期/失效：reason_code=license_expired/license_disabled/license_not_found/...
//  - 网络异常：reason_code=license_network_error
//  - 严重失败（人工审核 / 封禁）：卡片整体变红
// ============================================================================
const ACTIVATION_PROMPTS = {
  account_not_logged_in: {
    icon: "🔒",
    title: "登录官网账号",
    meta: "未激活",
    severity: "warning",
    primary: { text: "登录官网账号", action: "accountLogin" },
    secondary: null,
  },
  account_logged_out: {
    icon: "🔒",
    title: "登录官网账号",
    meta: "已退出登录",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: null,
  },
  account_no_entitlement: {
    icon: "🛍",
    title: "当前账号暂无软件权益",
    meta: "未激活",
    severity: "warning",
    primary: { text: "前往官网商城", action: "store" },
    secondary: { text: "切换账号", action: "accountLogin" },
  },
  account_network_error: {
    icon: "📡",
    title: "账号权益验证失败",
    meta: "网络异常",
    severity: "warning",
    primary: { text: "稍后重试", action: "retry" },
    secondary: { text: "重新登录", action: "accountLogin" },
  },
  membership_required: {
    icon: "🛍",
    title: "当前账号暂无软件权益",
    meta: "需要购买会员",
    severity: "warning",
    primary: { text: "前往官网商城", action: "store" },
    secondary: { text: "切换账号", action: "accountLogin" },
  },
  entitlement_expired: {
    icon: "⏰",
    title: "会员权益已到期",
    meta: "需要续费",
    severity: "warning",
    primary: { text: "前往官网商城续费", action: "store" },
    secondary: { text: "切换账号", action: "accountLogin" },
  },
  device_limit_reached: {
    icon: "🚫",
    title: "绑定设备已达上限",
    meta: "请释放设备名额",
    severity: "warning",
    primary: { text: "设备管理", action: "devices" },
    secondary: { text: "切换账号", action: "accountLogin" },
  },
  concurrent_limit_reached: {
    icon: "🚫",
    title: "在线设备已达上限",
    meta: "请退出其他设备",
    severity: "warning",
    primary: { text: "设备管理", action: "devices" },
    secondary: { text: "重新登录", action: "accountLogin" },
  },
  session_expired: {
    icon: "🔒",
    title: "登录会话已过期",
    meta: "需要重新登录",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: null,
  },
  session_replaced: {
    icon: "🔒",
    title: "登录会话已被替换",
    meta: "账号已在其他位置重新登录",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: null,
  },
  device_mismatch: {
    icon: "🔐",
    title: "设备验证不匹配",
    meta: "禁止使用复制的登录凭证",
    severity: "critical",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: null,
  },
  session_service_unavailable: {
    icon: "📡",
    title: "账号服务暂时不可用",
    meta: "会员功能已暂停",
    severity: "warning",
    primary: { text: "稍后重试", action: "retry" },
    secondary: null,
  },
  missing_license_code: {
    icon: "🔒",
    title: "登录官网账号",
    meta: "未激活",
    severity: "warning",
    primary: { text: "登录官网账号", action: "accountLogin" },
    secondary: null,
  },
  license_not_found: {
    icon: "❓",
    title: "账号权益不存在",
    meta: "核对失败",
    severity: "warning",
    primary: { text: "登录官网账号", action: "accountLogin" },
    secondary: { text: "前往官网商城", action: "store" },
  },
  invalid_license_code: {
    icon: "❓",
    title: "账号权益验证失败",
    meta: "长度不对",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: { text: "前往官网商城", action: "store" },
  },
  license_expired: {
    icon: "⏰",
    title: "授权已过期",
    meta: "需要续费",
    severity: "warning",
    primary: { text: "前往官网商城续费", action: "store" },
    secondary: { text: "切换账号", action: "accountLogin" },
  },
  license_disabled: {
    icon: "🚫",
    title: "授权已被停用",
    meta: "需要联系管理员",
    severity: "critical",
    primary: { text: "联系管理员", action: "contact" },
    secondary: null,
  },
  deactivated: {
    icon: "🔓",
    title: "设备已解绑",
    meta: "需要重新激活",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: { text: "联系管理员", action: "contact" },
  },
  device_not_bound: {
    icon: "🔓",
    title: "当前设备未绑定授权",
    meta: "需要重新激活",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: { text: "联系管理员", action: "contact" },
  },
  device_revoked: {
    icon: "🔓",
    title: "本地授权已失效",
    meta: "需要重新激活",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: { text: "联系管理员", action: "contact" },
  },
  rebind_required: {
    icon: "🔓",
    title: "需要重新绑定设备",
    meta: "请重新激活",
    severity: "warning",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: { text: "联系管理员", action: "contact" },
  },
  device_already_bound: {
    icon: "🚫",
    title: "账号权益已绑定其他设备",
    meta: "一码一机",
    severity: "critical",
    primary: { text: "我已解绑，重新登录", action: "accountLogin" },
    secondary: { text: "联系管理员换绑", action: "contact" },
    showDeviceBlock: true,
  },
  rebind_limit_exceeded: {
    icon: "⚠️",
    title: "换绑次数超限",
    meta: "本月已达上限",
    severity: "critical",
    primary: { text: "联系管理员人工换绑", action: "contact" },
    secondary: null,
  },
  device_limit_exceeded: {
    icon: "🚫",
    title: "设备数已达上限",
    meta: "无法在更多设备使用",
    severity: "critical",
    primary: { text: "联系管理员解绑", action: "contact" },
    secondary: null,
  },
  device_banned: {
    icon: "🚫",
    title: "当前设备已被封禁",
    meta: "无法使用",
    severity: "critical",
    primary: { text: "联系管理员", action: "contact" },
    secondary: null,
  },
  manual_review_required: {
    icon: "⚠️",
    title: "已进入人工审核",
    meta: "授权状态异常",
    severity: "critical",
    primary: { text: "联系管理员", action: "contact" },
    secondary: null,
  },
  signature_invalid: {
    icon: "🔐",
    title: "签名验证失败",
    meta: "客户端签名无效",
    severity: "critical",
    primary: { text: "重新登录", action: "accountLogin" },
    secondary: { text: "联系管理员", action: "contact" },
  },
  app_mismatch: {
    icon: "🚫",
    title: "应用权益不匹配",
    meta: "当前账号权益不适用于此应用",
    severity: "critical",
    primary: { text: "联系管理员", action: "contact" },
    secondary: null,
  },
  license_network_error: {
    icon: "📡",
    title: "网络异常",
    meta: "无法连接授权服务器",
    severity: "warning",
    primary: { text: "稍后重试", action: "retry" },
    secondary: null,
  },
};

async function showActivationRequiredModal(info) {
  // 内部使用版：激活弹窗已移除
  return;
}

function openActivationModal() {
  // 内部使用版：激活/账号引导已移除
  return;
}

function promptLicenseRequired(featureName = "当前功能") {
  // 内部使用版：授权恒放行，无需账号/激活提示
  return;
}

function requireLicense(featureName) {
  // 内部使用版：授权恒放行，不弹激活/账号提示
  return true;
}

function updateLicenseUI(status) {
  // 内部使用版：授权恒为永久有效，直接显示"已解锁"，不再有激活/倒计时逻辑
  state.licenseValid = true;
  state.licenseReasonCode = "internal_permanent";
  state.licenseExpiresAt = null;
  state.licenseCountdown = "永久";
  state.licenseExpiryCheckDoneFor = "";

  const lockedEl = $("licenseLockedEl");
  const activeEl = $("licenseActiveEl");
  const countdownEl = $("licenseCountdown");
  const pillEl = $("statusPill");
  if (pillEl) {
    pillEl.classList.add("licensed");
    pillEl.title = "内部使用版 · 已解锁";
  }
  if (lockedEl) lockedEl.style.display = "none";
  if (activeEl) activeEl.style.display = "";
  if (countdownEl) {
    countdownEl.textContent = "永久";
    countdownEl.classList.remove("license-countdown-urgent");
  }

  if (!state.busy) {
    $("startBtn").disabled = false;
    $("loginBtn").disabled = false;
    $("pickBtn").disabled = false;
  }
  updateBatchQueueControls();
  stopLicenseTimer();
}

function parseLicenseExpiryMs(expiresAt) {
  if (!expiresAt) return 0;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function licenseCountdownText(status = {}) {
  if (status.is_permanent) return "永久";
  const expiryMs = parseLicenseExpiryMs(status.expires_at);
  if (!expiryMs) return status.countdown_text || "授权时间未返回";
  const remainingMs = expiryMs - Date.now();
  if (remainingMs <= 0) return "已过期";
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${Math.max(1, minutes)}分钟`;
}

async function lockAppForExpiredLicense(status) {
  // 内部使用版：授权永久有效，永不锁定
  return;
}

async function verifyLicenseExpiryNow(reason = "expiry_window") {
  // 内部使用版：授权永久有效，无需到期核对
  return;
}

function startLicenseTimer(status = {}) {
  // 内部使用版：授权永久有效，无需到期计时
  stopLicenseTimer();
}

function stopLicenseTimer() {
  if (state.licenseTimer) {
    clearTimeout(state.licenseTimer);
    state.licenseTimer = null;
  }
}

// ── 导航 ──

function setupNavigation() {
  // 已收敛为核心三入口；未授权时停留在当前并提示，不再强制跳到空壳分离页
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.dataset.panel;
      if (!state.licenseValid) {
        promptLicenseRequired(button.textContent.trim() || "该模块");
        return;
      }
      goToPanel(panel);
    });
  });
}

function setupWindowControls() {
  setupThemeControls();
  $("windowMinimizeBtn")?.addEventListener("click", () => window.gaobai.windowMinimize?.());
  $("windowMaximizeBtn")?.addEventListener("click", () => window.gaobai.windowMaximize?.());
  $("windowCloseBtn")?.addEventListener("click", () => {
    // 顺序：先尝试 windowClose（按用户配置的 ask / minimize / exit 走），
    //      5 秒后如果进程还在（说明 close handler 出问题或 minimize 找不到托盘），
    //      自动用 force-quit 兜底，确保用户一定能退出。
    if (typeof window.gaobai?.windowClose === "function") {
      window.gaobai.windowClose();
      setTimeout(() => {
        // 如果 5s 后进程还在，说明 close handler 走不通，
        // （Win11 上 minimize 找不到托盘、托盘右键退不出都属于这种），
        // 直接 force-quit 兜底。
        if (typeof window.gaobai?.forceQuit === "function") {
          window.gaobai.forceQuit();
        }
      }, 5000);
    } else {
      try { window.close(); } catch (_) {}
    }
  });

  // 设置按钮 - 弹出关于对话框
  document.querySelectorAll(".round-tool").forEach((btn) => {
    if (btn.title === "帮助") {
      btn.addEventListener("click", () => window.gaobai.showAbout?.());
    }
  });
}

function setupHistoryFilters() {
  $("historySearchInput")?.addEventListener("input", renderHistory);
  document.querySelectorAll("[data-history-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.historyFilter = button.dataset.historyFilter || "all";
      document.querySelectorAll("[data-history-filter]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderHistory();
    });
  });
}

function setupSpeedOptions() {
  const buttons = Array.from(document.querySelectorAll("[data-speed]"));
  if (!buttons.length) return;
  const modeNote = $("speedModeNote");
  const modeNotes = {
    stable: "上传速度较慢，但保证音频高质量；推荐上传半首歌曲或片段。",
    onbeat2x: "快速上传会损失一部分音频质量，但不影响翻唱。",
  };
  const setSpeed = (speed) => {
    state.speed = ["stable", "onbeat2x"].includes(speed) ? speed : "onbeat2x";
    buttons.forEach((button) => {
      button.classList.toggle("active", button.dataset.speed === state.speed);
    });
    if (modeNote) modeNote.textContent = modeNotes[state.speed];
  };
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      setSpeed(button.dataset.speed || "stable");
      if (state.uploadType === "batch" && !batchQueueIsActive()) {
        (state.batchQueue.items || []).forEach((item) => {
          if (["pending", "failed", "cancelled", "waiting_login"].includes(item.status)) item.speed = state.speed;
        });
        renderBatchQueue();
        persistBatchQueue();
      }
    });
  });
  setSpeed(state.speed || "experiment");
}

function setupUploadBatchControls() {
  document.querySelectorAll("[data-upload-type]").forEach((button) => {
    button.addEventListener("click", () => setUploadType(button.dataset.uploadType || "single"));
  });

  const pickBatchFiles = async () => {
    if (batchQueueIsActive() || !requireLicense("选择批量上传歌曲")) return;
    const files = await window.gaobai.pickAudios?.();
    await addFilesToBatchQueue(files || []);
  };
  $("batchPickBtn")?.addEventListener("click", pickBatchFiles);
  $("batchUploadDropArea")?.addEventListener("click", pickBatchFiles);
  $("batchUploadDropArea")?.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!batchQueueIsActive()) $("batchUploadDropArea")?.classList.add("dragover");
  });
  $("batchUploadDropArea")?.addEventListener("dragleave", () => {
    $("batchUploadDropArea")?.classList.remove("dragover");
  });
  $("batchUploadDropArea")?.addEventListener("drop", async (event) => {
    event.preventDefault();
    $("batchUploadDropArea")?.classList.remove("dragover");
    if (batchQueueIsActive() || !requireLicense("添加批量上传歌曲")) return;
    const files = Array.from(event.dataTransfer?.files || [])
      .filter((file) => OPEN_AUDIO_PATTERN.test(file.name || ""))
      .map((file) => window.getPathForFile(file))
      .filter(Boolean);
    await addFilesToBatchQueue(files);
  });

  $("batchStartBtn")?.addEventListener("click", async () => {
    if (!requireLicense("批量上传 Suno")) return;
    if (!(state.batchQueue.items || []).length) {
      log("请先添加要批量上传的歌曲。");
      return;
    }
    setBusy(true);
    setUploadType("batch");
    setStatus("正在启动批量队列", "队列准备中");
    setUploadEtaBadge("批量队列准备中", `${state.batchQueue.items.length} 首歌曲`);
    const continuing = ["paused", "waiting_login"].includes(state.batchQueue.status);
    const result = continuing
      ? await window.gaobai.resumeUploadBatch()
      : await window.gaobai.startUploadBatch({ items: state.batchQueue.items });
    if (!result?.ok) {
      setBusy(false);
      if (result?.code === "suno_login_required") {
        restoreSunoLoginUi(result.message || "Suno 登录已失效，请重新登录后继续批量队列。");
      } else {
        setStatus("批量队列启动失败", "启动失败", "error");
        setUploadEtaBadge("队列启动失败", result?.message || "请稍后重试", "error");
        log(result?.message || "批量上传队列启动失败。");
      }
      return;
    }
    state.batchQueue = normalizeBatchQueue(result.queue);
    renderBatchQueue();
  });

  $("batchPauseBtn")?.addEventListener("click", async () => {
    const result = await window.gaobai.pauseUploadBatch();
    if (!result?.ok) {
      log(result?.message || "暂停批量队列失败。");
      return;
    }
    state.batchQueue = normalizeBatchQueue(result.queue);
    renderBatchQueue();
    setStatus("当前歌曲完成后暂停", "等待暂停");
  });

  $("batchCancelBtn")?.addEventListener("click", async () => {
    if (!window.confirm("确定停止整个批量上传队列吗？正在上传的歌曲也会停止。")) return;
    const result = await window.gaobai.cancelUploadBatch();
    if (!result?.ok) {
      log(result?.message || "停止批量队列失败。");
      return;
    }
    state.batchQueue = normalizeBatchQueue(result.queue);
    renderBatchQueue();
  });

  $("batchClearBtn")?.addEventListener("click", async () => {
    if (batchQueueIsActive()) return;
    const result = await window.gaobai.saveUploadBatch({ items: [] });
    if (!result?.ok) {
      log(result?.message || "清空批量队列失败。");
      return;
    }
    state.batchQueue = normalizeBatchQueue(result.queue);
    renderBatchQueue();
    setStatus("批量队列已清空");
  });

  setUploadType("single");
  refreshUploadBatchQueue().then(() => {
    if (["paused", "waiting_login", "running", "pausing"].includes(state.batchQueue.status)) {
      setUploadType("batch");
    }
  });
}

function timelineClientToSeconds(clientX) {
  const timeline = $("clipTimeline");
  if (!timeline) return 0;
  const rect = timeline.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  return ratio * Math.max(0.1, state.editorDuration || 30);
}

function setClipBoundsFromSeconds(start, end) {
  const max = Math.max(0.1, state.editorDuration || 30);
  const safeStart = clamp(snapEditorTime(start), 0, max);
  const safeEnd = clamp(snapEditorTime(end), 0.001, max);
  let normalizedStart = Math.min(safeStart, max - 0.001);
  let normalizedEnd = Math.max(safeEnd, normalizedStart + 0.001);
  if (normalizedEnd > max) {
    normalizedEnd = max;
    normalizedStart = Math.max(0, normalizedEnd - 0.001);
  }
  $("clipStartInput").value = formatTime(normalizedStart);
  $("clipEndInput").value = formatTime(normalizedEnd);
  $("clipStartRange").value = normalizedStart.toFixed(3);
  $("clipEndRange").value = normalizedEnd.toFixed(3);
  syncClipInputs("number");
}

function dawId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDawTrack(track) {
  const rawGain = Number(track?.gain);
  const rawPan = Number(track?.pan);
  const rawHeight = Number(track?.height);
  track.gain = Number.isFinite(rawGain) ? clamp(rawGain, 0, 1.5) : 1;
  track.pan = Number.isFinite(rawPan) ? clamp(rawPan, -1, 1) : 0;
  track.height = Number.isFinite(rawHeight)
    ? clamp(rawHeight, DAW_TRACK_MIN_HEIGHT, DAW_TRACK_MAX_HEIGHT)
    : DAW_TRACK_DEFAULT_HEIGHT;
  track.muted = Boolean(track.muted);
  track.solo = Boolean(track.solo);
  return track;
}

function normalizeDawClip(clip) {
  const pitch = Number(clip?.pitch);
  const cents = Number(clip?.cents);
  const tempo = Number(clip?.tempo);
  const bufferDuration = Number(state.dawBufferCache.get(clip?.sourcePath)?.duration);
  const rawSourceStart = Math.max(0, Number(clip?.sourceStart) || 0);
  const rawSourceEnd = Math.max(rawSourceStart + 0.001, Number(clip?.sourceEnd) || rawSourceStart + 0.001);
  const knownSourceDuration = Number(clip?.sourceDuration);
  clip.pitch = Number.isFinite(pitch) ? clamp(pitch, -12, 12) : 0;
  clip.cents = Number.isFinite(cents) ? clamp(cents, -100, 100) : 0;
  clip.tempo = Number.isFinite(tempo) ? clamp(tempo, 0.5, 2) : 1;
  clip.sourceDuration = Math.max(
    rawSourceEnd,
    Number.isFinite(knownSourceDuration) ? knownSourceDuration : 0,
    Number.isFinite(bufferDuration) ? bufferDuration : 0
  );
  clip.sourceStart = clamp(rawSourceStart, 0, Math.max(0, clip.sourceDuration - 0.001));
  clip.sourceEnd = clamp(rawSourceEnd, clip.sourceStart + 0.001, clip.sourceDuration);
  clip.duration = Math.max(0.001, (clip.sourceEnd - clip.sourceStart) / clip.tempo);
  return clip;
}

function ensureDawTracks() {
  if (state.dawTracks.length) {
    state.dawTracks.forEach(normalizeDawTrack);
    return;
  }
  state.dawTracks = [
    { id: dawId("track"), name: "轨道 1", muted: false, solo: false, gain: 1, pan: 0, height: DAW_TRACK_DEFAULT_HEIGHT, clips: [] },
    { id: dawId("track"), name: "轨道 2", muted: false, solo: false, gain: 1, pan: 0, height: DAW_TRACK_DEFAULT_HEIGHT, clips: [] }
  ];
  state.dawSelectedTrackId = state.dawTracks[0].id;
}

function resetDawProjectForSource(filePath, duration) {
  stopDawPlayback(false);
  const mainTrack = { id: dawId("track"), name: "主音轨", muted: false, solo: false, gain: 1, pan: 0, height: DAW_TRACK_DEFAULT_HEIGHT, clips: [] };
  const secondTrack = { id: dawId("track"), name: "轨道 2", muted: false, solo: false, gain: 1, pan: 0, height: DAW_TRACK_DEFAULT_HEIGHT, clips: [] };
  const clip = {
    id: dawId("clip"),
    sourcePath: filePath,
    name: basename(filePath),
    sourceStart: 0,
    sourceEnd: duration,
    sourceDuration: duration,
    duration,
    timelineStart: 0,
    gain: 1,
    pitch: 0,
    cents: 0,
    tempo: 1
  };
  mainTrack.clips.push(clip);
  state.dawTracks = [mainTrack, secondTrack];
  state.dawSelectedTrackId = mainTrack.id;
  state.dawSelectedClipId = clip.id;
  state.dawUndoStack = [];
  state.dawPlayhead = 0;
  state.dawSelection = null;
  state.dawExportRange = null;
  state.dawExportDialogAction = "";
  closeDawExportDialog();
  if ($("dawExportName")) {
    const sourceName = basename(filePath || "").replace(/\.[^.]+$/, "").trim() || "音频工程";
    $("dawExportName").value = `${sourceName}_混音`;
  }
  if ($("dawUndoBtn")) $("dawUndoBtn").disabled = true;
  renderDawProject();
  if ($("dawProjectStatus")) $("dawProjectStatus").textContent = "主音轨已创建，可直接剪辑或拖动编排";
  detectAndApplyDawBpm(filePath);
}

function dawContentDuration() {
  return state.dawTracks.reduce((projectEnd, track) => (
    Math.max(projectEnd, ...track.clips.map((clip) => clip.timelineStart + clip.duration))
  ), 0);
}

function dawProjectDuration() {
  const clipEnd = dawContentDuration();
  return Math.max(30, clipEnd + 5);
}

function effectiveDawExportRange() {
  const contentEnd = Math.max(0.001, dawContentDuration());
  const range = state.dawExportRange;
  if (!range) return { start: 0, end: contentEnd };
  const start = clamp(Number(range.start) || 0, 0, Math.max(0, contentEnd - 0.001));
  const end = clamp(Number(range.end) || contentEnd, start + 0.001, contentEnd);
  return { start, end };
}

function dawPixelsPerSecond() {
  return 6 * clamp(state.dawZoom || 1, DAW_ZOOM_MIN, DAW_ZOOM_MAX);
}

function dawTrackById(trackId) {
  return state.dawTracks.find((track) => track.id === trackId) || null;
}

function dawFindClip(clipId) {
  for (const track of state.dawTracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function saveDawSnapshot() {
  state.dawUndoStack.push(JSON.stringify({
    tracks: state.dawTracks,
    selectedTrackId: state.dawSelectedTrackId,
    selectedClipId: state.dawSelectedClipId,
    selection: state.dawSelection,
    exportRange: state.dawExportRange
  }));
  if (state.dawUndoStack.length > 60) state.dawUndoStack.shift();
  state.editorUndoDomain = "daw";
  if ($("dawUndoBtn")) $("dawUndoBtn").disabled = false;
}

function undoDawEdit() {
  const raw = state.dawUndoStack.pop();
  if (!raw) return;
  const snapshot = JSON.parse(raw);
  state.dawTracks = snapshot.tracks || [];
  state.dawSelectedTrackId = snapshot.selectedTrackId || state.dawTracks[0]?.id || "";
  state.dawSelectedClipId = snapshot.selectedClipId || "";
  state.dawSelection = snapshot.selection || null;
  state.dawExportRange = snapshot.exportRange || null;
  $("dawUndoBtn").disabled = state.dawUndoStack.length === 0;
  stopDawPlayback(false);
  renderDawProject();
  $("dawProjectStatus").textContent = "已撤回上一步编排";
}

async function ensureDawAudioBuffer(filePath) {
  if (state.dawBufferCache.has(filePath)) return state.dawBufferCache.get(filePath);
  const bytes = await window.gaobai.readAudioFile(filePath);
  if (!bytes) throw new Error(`无法读取 ${basename(filePath)}`);
  const view = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const tempContext = new AudioContextClass();
  try {
    const decoded = await tempContext.decodeAudioData(view);
    state.dawBufferCache.set(filePath, decoded);
    return decoded;
  } finally {
    await tempContext.close();
  }
}

async function detectAndApplyDawBpm(filePath) {
  if (!filePath || typeof window.gaobai?.detectEditorBpm !== "function") return;
  const sequence = ++state.dawBpmDetectionSeq;
  if ($("dawProjectStatus")) $("dawProjectStatus").textContent = "正在分析歌曲 BPM…";
  try {
    const result = await window.gaobai.detectEditorBpm(filePath);
    if (sequence !== state.dawBpmDetectionSeq) return;
    const bpm = Number(result?.bpm);
    if (!result?.ok || !Number.isFinite(bpm)) {
      if ($("dawProjectStatus")) $("dawProjectStatus").textContent = result?.message || "未能自动识别 BPM，可手动输入";
      return;
    }
    state.editorGrid.bpm = clamp(Math.round(bpm * 10) / 10, 40, 260);
    if ($("editorBpmInput")) $("editorBpmInput").value = String(state.editorGrid.bpm);
    saveEditorPrefs();
    renderDawProject();
    if ($("dawProjectStatus")) {
      $("dawProjectStatus").textContent = `已自动匹配歌曲 BPM：${state.editorGrid.bpm}${result.cached ? "（已缓存）" : ""}`;
    }
  } catch (error) {
    if (sequence === state.dawBpmDetectionSeq && $("dawProjectStatus")) {
      $("dawProjectStatus").textContent = `BPM 自动识别失败：${error.message}`;
    }
  }
}

function dawDefaultInsertTime(track) {
  const selected = dawFindClip(state.dawSelectedClipId);
  if (selected && selected.track.id === track.id) {
    return selected.clip.timelineStart + selected.clip.duration;
  }
  return track.clips.reduce((end, clip) => Math.max(end, clip.timelineStart + clip.duration), 0);
}

async function addDawClip(filePath, sourceStart = 0, sourceEnd = null, analyzeBpm = false) {
  ensureDawTracks();
  const buffer = await ensureDawAudioBuffer(filePath);
  const safeStart = clamp(sourceStart, 0, Math.max(0, buffer.duration - 0.001));
  const safeEnd = clamp(sourceEnd == null ? buffer.duration : sourceEnd, safeStart + 0.001, buffer.duration);
  const track = dawTrackById(state.dawSelectedTrackId) || state.dawTracks[0];
  const clip = {
    id: dawId("clip"),
    sourcePath: filePath,
    name: basename(filePath),
    sourceStart: safeStart,
    sourceEnd: safeEnd,
    sourceDuration: buffer.duration,
    duration: safeEnd - safeStart,
    timelineStart: dawDefaultInsertTime(track),
    gain: 1,
    pitch: 0,
    cents: 0,
    tempo: 1
  };
  saveDawSnapshot();
  track.clips.push(clip);
  state.dawSelectedTrackId = track.id;
  state.dawSelectedClipId = clip.id;
  renderDawProject();
  $("dawProjectStatus").textContent = `已加入 ${clip.name}，可拖动调整位置或换轨`;
  if (analyzeBpm) detectAndApplyDawBpm(filePath);
  return clip;
}

function addDawTrack() {
  ensureDawTracks();
  saveDawSnapshot();
  const track = { id: dawId("track"), name: `轨道 ${state.dawTracks.length + 1}`, muted: false, solo: false, gain: 1, pan: 0, height: DAW_TRACK_DEFAULT_HEIGHT, clips: [] };
  state.dawTracks.push(track);
  state.dawSelectedTrackId = track.id;
  state.dawSelectedClipId = "";
  renderDawProject();
}

function removeDawTrack(trackId) {
  if (state.dawTracks.length <= 1) {
    $("dawProjectStatus").textContent = "工程至少保留一条轨道";
    return;
  }
  saveDawSnapshot();
  state.dawTracks = state.dawTracks.filter((track) => track.id !== trackId);
  if (state.dawSelectedTrackId === trackId) state.dawSelectedTrackId = state.dawTracks[0].id;
  if (!dawFindClip(state.dawSelectedClipId)) state.dawSelectedClipId = "";
  renderDawProject();
}

function removeDawClip(clipId) {
  const found = dawFindClip(clipId);
  if (!found) return;
  saveDawSnapshot();
  found.track.clips = found.track.clips.filter((clip) => clip.id !== clipId);
  state.dawSelectedClipId = "";
  renderDawProject();
}

function makeDawButton(text, title, className = "daw-track-button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.title = title;
  return button;
}

function drawDawClipWaveform(canvas, clip) {
  const buffer = state.dawBufferCache.get(clip.sourcePath);
  if (!canvas || !buffer) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(12, Math.round(rect.width || 120));
  const height = Math.max(20, Math.round(rect.height || 30));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const channel = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor(clip.sourceStart * sampleRate));
  const endSample = Math.min(channel.length, Math.ceil(clip.sourceEnd * sampleRate));
  const samplesPerPixel = Math.max(1, Math.floor((endSample - startSample) / width));
  const center = height / 2;
  context.strokeStyle = state.theme === "dark" ? "rgba(255,228,240,.82)" : "rgba(13,63,129,.72)";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const offset = startSample + x * samplesPerPixel;
    let peak = 0;
    for (let index = 0; index < samplesPerPixel && offset + index < endSample; index += 1) {
      peak = Math.max(peak, Math.abs(channel[offset + index]));
    }
    const amplitude = Math.max(1, peak * (height - 4) * 0.5);
    context.moveTo(x + 0.5, center - amplitude);
    context.lineTo(x + 0.5, center + amplitude);
  }
  context.stroke();
}

function formatDawBars(time) {
  const beatSeconds = 60 / clamp(Number(state.editorGrid?.bpm) || 120, 40, 260);
  const absoluteBeat = Math.max(0, time) / beatSeconds;
  const bar = Math.floor(absoluteBeat / 4) + 1;
  const beat = Math.floor(absoluteBeat % 4) + 1;
  return `${bar}.${beat}`;
}

function syncDawRulerWithGrid() {
  state.dawRulerMode = state.editorGrid?.unit === "time" ? "time" : "bars";
  if ($("dawRulerMode")) $("dawRulerMode").value = state.dawRulerMode;
  localStorage.setItem("qiyin-daw-ruler", state.dawRulerMode);
}

function dawTimelineGrid(pps) {
  const baseSeconds = Math.max(0.001, getEditorGridSeconds());
  const minorMultipliers = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
  const minorMultiplier = minorMultipliers.find((value) => baseSeconds * value * pps >= 24) || 512;
  const minorSeconds = baseSeconds * minorMultiplier;
  const majorMultipliers = [1, 2, 4, 5, 8, 10, 16];
  const majorMultiplier = majorMultipliers.find((value) => minorSeconds * value * pps >= 78) || 16;
  return {
    minorSeconds,
    majorSeconds: minorSeconds * majorMultiplier,
    minorPixels: minorSeconds * pps
  };
}

function dawTimeFromLanePointer(clientX, lane, bypassSnap = false) {
  const rect = lane.getBoundingClientRect();
  return clamp(
    snapDawTime(Math.max(0, (clientX - rect.left) / dawPixelsPerSecond()), bypassSnap),
    0,
    dawProjectDuration()
  );
}

function updateDawSelectionOverlay() {
  const overlay = $("dawProjectSelection");
  if (!overlay) return;
  const selection = state.dawSelection;
  const trackIndex = selection ? state.dawTracks.findIndex((track) => track.id === selection.trackId) : -1;
  if (!selection || trackIndex < 0 || selection.end - selection.start < 0.001) {
    overlay.hidden = true;
    return;
  }
  const trackTop = state.dawTracks
    .slice(0, trackIndex)
    .reduce((top, track) => top + normalizeDawTrack(track).height, 28);
  const trackHeight = normalizeDawTrack(state.dawTracks[trackIndex]).height;
  overlay.hidden = false;
  overlay.style.left = `${DAW_TRACK_HEADER_WIDTH + selection.start * dawPixelsPerSecond()}px`;
  overlay.style.top = `${trackTop}px`;
  overlay.style.width = `${Math.max(2, (selection.end - selection.start) * dawPixelsPerSecond())}px`;
  overlay.style.height = `${trackHeight}px`;
}

function updateDawExportMarkers() {
  const startMarker = $("dawExportStartMarker");
  const endMarker = $("dawExportEndMarker");
  const label = $("dawExportRangeLabel");
  const contentEnd = dawContentDuration();
  const hasAudio = contentEnd > 0.001;
  if (startMarker) startMarker.hidden = !hasAudio;
  if (endMarker) endMarker.hidden = !hasAudio;
  if (!hasAudio) {
    if (label) label.textContent = "导出范围：等待音频";
    return;
  }
  const range = effectiveDawExportRange();
  const pps = dawPixelsPerSecond();
  if (startMarker) {
    startMarker.style.left = `${DAW_TRACK_HEADER_WIDTH + range.start * pps}px`;
    startMarker.title = `导出入点 ${formatTime(range.start)}`;
  }
  if (endMarker) {
    endMarker.style.left = `${DAW_TRACK_HEADER_WIDTH + range.end * pps}px`;
    endMarker.title = `导出出点 ${formatTime(range.end)}`;
  }
  if (label) label.textContent = `导出 ${formatTime(range.start)} - ${formatTime(range.end)}`;
}

function setDawExportRange(start, end, announce = false) {
  const contentEnd = dawContentDuration();
  if (contentEnd <= 0.001) {
    state.dawExportRange = null;
    updateDawExportMarkers();
    return;
  }
  const normalizedStart = clamp(Math.min(start, end), 0, Math.max(0, contentEnd - 0.001));
  const normalizedEnd = clamp(Math.max(start, end), normalizedStart + 0.001, contentEnd);
  state.dawExportRange = { start: normalizedStart, end: normalizedEnd };
  updateDawExportMarkers();
  if (announce && $("dawProjectStatus")) {
    $("dawProjectStatus").textContent = `导出范围已设为 ${formatTime(normalizedStart)} - ${formatTime(normalizedEnd)}`;
  }
}

function setDawSelection(trackId, start, end, syncInputs = true) {
  const max = dawProjectDuration();
  const normalizedStart = clamp(Math.min(start, end), 0, max);
  const normalizedEnd = clamp(Math.max(start, end), 0, max);
  state.dawSelection = normalizedEnd - normalizedStart >= 0.001
    ? { trackId, start: normalizedStart, end: normalizedEnd }
    : null;
  if (syncInputs && state.dawSelection) {
    $("clipStartInput").value = formatTime(state.dawSelection.start);
    $("clipEndInput").value = formatTime(state.dawSelection.end);
  }
  updateDawSelectionOverlay();
}

function splitDawClipAt(track, clip, projectTime) {
  const offset = projectTime - clip.timelineStart;
  if (offset <= 0.01 || offset >= clip.duration - 0.01) return false;
  saveDawSnapshot();
  const originalSourceEnd = clip.sourceEnd;
  const originalTimelineEnd = clip.timelineStart + clip.duration;
  clip.sourceEnd = clip.sourceStart + offset * clip.tempo;
  clip.duration = offset;
  const right = {
    ...clip,
    id: dawId("clip"),
    sourceStart: clip.sourceEnd,
    sourceEnd: originalSourceEnd,
    duration: originalTimelineEnd - projectTime,
    timelineStart: projectTime
  };
  track.clips.push(right);
  state.dawSelectedTrackId = track.id;
  state.dawSelectedClipId = right.id;
  state.dawSelection = null;
  renderDawProject();
  $("dawProjectStatus").textContent = `已在 ${formatTime(projectTime)} 切开片段`;
  return true;
}

function deleteDawProjectSelection() {
  const selection = state.dawSelection;
  if (!selection) {
    if (state.dawSelectedClipId) removeDawClip(state.dawSelectedClipId);
    return;
  }
  const track = dawTrackById(selection.trackId);
  if (!track) return;
  const overlaps = track.clips.some((clip) => (
    clip.timelineStart < selection.end && clip.timelineStart + clip.duration > selection.start
  ));
  if (!overlaps) return;
  saveDawSnapshot();
  const nextClips = [];
  track.clips.forEach((clip) => {
    const clipStart = clip.timelineStart;
    const clipEnd = clip.timelineStart + clip.duration;
    if (clipEnd <= selection.start || clipStart >= selection.end) {
      nextClips.push(clip);
      return;
    }
    if (selection.start > clipStart + 0.001) {
      const leftDuration = selection.start - clipStart;
      nextClips.push({ ...clip, sourceEnd: clip.sourceStart + leftDuration * clip.tempo, duration: leftDuration });
    }
    if (selection.end < clipEnd - 0.001) {
      const trim = selection.end - clipStart;
      nextClips.push({
        ...clip,
        id: dawId("clip"),
        sourceStart: clip.sourceStart + trim * clip.tempo,
        duration: clipEnd - selection.end,
        timelineStart: selection.end
      });
    }
  });
  track.clips = nextClips;
  state.dawSelection = null;
  state.dawSelectedClipId = "";
  renderDawProject();
  $("dawProjectStatus").textContent = "已删除轨道选区，时间线位置保持不变";
}

function updateDawToolHint() {
  const hints = {
    cursor: "光标：点击或拖动定位播放位置",
    select: "选区：拖动选择，左右边缘可调整；点击其他位置仍会保留",
    cut: "剪刀：在片段上双击完成切割"
  };
  if ($("dawToolHint")) $("dawToolHint").textContent = hints[state.editorTool] || hints.cursor;
  $("dawProject")?.classList.toggle("cut-mode", state.editorTool === "cut");
}

function dawPanLabel(value) {
  const pan = clamp(Number(value) || 0, -1, 1);
  if (Math.abs(pan) < 0.01) return "C";
  return pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(pan * 100)}`;
}

function isDawTrackAudible(track) {
  const hasSolo = state.dawTracks.some((item) => item.solo);
  return !track.muted && (!hasSolo || track.solo);
}

function updateDawTrackAudioNodes(track) {
  const nodes = state.dawTrackNodes.get(track.id) || [];
  nodes.forEach(({ gainNode, panNode, clipGain = 1 }) => {
    if (gainNode) gainNode.gain.value = isDawTrackAudible(track) ? clamp(track.gain * clipGain, 0, 4.5) : 0;
    if (panNode) panNode.pan.value = clamp(track.pan, -1, 1);
  });
}

function updateAllDawTrackAudioNodes() {
  state.dawTracks.forEach(updateDawTrackAudioNodes);
}

function closeDawClipMenu() {
  const menu = $("dawClipMenu");
  if (menu) menu.hidden = true;
  state.dawContextClipId = "";
}

function openDawClipMenu(clip, clientX, clientY) {
  const menu = $("dawClipMenu");
  if (!menu) return;
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  normalizeDawClip(clip);
  state.dawContextClipId = clip.id;
  $("dawClipMenuName").textContent = clip.name;
  $("dawClipPitchInput").value = String(clip.pitch);
  $("dawClipCentsInput").value = String(clip.cents);
  $("dawClipTempoInput").value = String(clip.tempo);
  menu.hidden = false;
  menu.style.visibility = "hidden";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${clamp(clientX + 6, 8, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${clamp(clientY + 6, 8, window.innerHeight - rect.height - 8)}px`;
  menu.style.visibility = "visible";
}

function applyDawClipEffects() {
  const found = dawFindClip(state.dawContextClipId);
  if (!found) return closeDawClipMenu();
  saveDawSnapshot();
  found.clip.pitch = clamp(Number($("dawClipPitchInput").value) || 0, -12, 12);
  found.clip.cents = clamp(Number($("dawClipCentsInput").value) || 0, -100, 100);
  found.clip.tempo = clamp(Number($("dawClipTempoInput").value) || 1, 0.5, 2);
  normalizeDawClip(found.clip);
  const label = `${found.clip.pitch >= 0 ? "+" : ""}${found.clip.pitch} 半音 / ${found.clip.cents >= 0 ? "+" : ""}${found.clip.cents} 音分 / ${found.clip.tempo.toFixed(2)}x`;
  closeDawClipMenu();
  renderDawProject();
  $("dawProjectStatus").textContent = `片段参数已更新：${label}`;
}

function renderDawProject() {
  const project = $("dawProject");
  const trackList = $("dawTrackList");
  const ruler = $("dawProjectRuler");
  if (!project || !trackList || !ruler) return;
  ensureDawTracks();
  const pps = dawPixelsPerSecond();
  const duration = dawProjectDuration();
  const timelineGrid = dawTimelineGrid(pps);
  const viewportWidth = Math.max(320, ($("dawProjectScroll")?.clientWidth || 720) - DAW_TRACK_HEADER_WIDTH);
  const laneWidth = Math.max(viewportWidth, duration * pps);
  project.style.width = `${laneWidth + DAW_TRACK_HEADER_WIDTH}px`;
  project.style.setProperty("--daw-grid-step", `${timelineGrid.minorPixels}px`);
  ruler.replaceChildren();
  const tickSeconds = timelineGrid.majorSeconds;
  for (let time = 0; time <= duration + tickSeconds; time += tickSeconds) {
    const tick = document.createElement("span");
    tick.className = "daw-ruler-tick";
    tick.style.left = `${time * pps}px`;
    tick.textContent = state.dawRulerMode === "bars" ? formatDawBars(time) : formatTime(time);
    ruler.appendChild(tick);
  }

  trackList.replaceChildren();
  state.dawTracks.forEach((track) => {
    normalizeDawTrack(track);
    const row = document.createElement("div");
    row.className = "daw-track-row";
    row.dataset.trackId = track.id;
    row.style.height = `${track.height}px`;

    const header = document.createElement("div");
    header.className = "daw-track-header";
    header.style.height = `${track.height}px`;
    const headerTop = document.createElement("div");
    headerTop.className = "daw-track-header-top";
    const name = document.createElement("span");
    name.className = "daw-track-name";
    name.textContent = track.name;
    name.title = "单击选择轨道";
    name.addEventListener("click", () => {
      state.dawSelectedTrackId = track.id;
      state.dawSelectedClipId = "";
      renderDawProject();
    });
    const mute = makeDawButton("M", track.muted ? "取消静音" : "静音轨道");
    mute.classList.toggle("active", track.muted);
    mute.addEventListener("click", () => {
      saveDawSnapshot();
      track.muted = !track.muted;
      updateAllDawTrackAudioNodes();
      renderDawProject();
    });
    const solo = makeDawButton("S", track.solo ? "取消独奏" : "独奏轨道");
    solo.classList.toggle("active", track.solo);
    solo.addEventListener("click", () => {
      saveDawSnapshot();
      track.solo = !track.solo;
      updateAllDawTrackAudioNodes();
      renderDawProject();
    });
    const removeTrack = makeDawButton("×", "删除轨道");
    removeTrack.addEventListener("click", () => removeDawTrack(track.id));
    headerTop.append(name, mute, solo, removeTrack);

    const mixer = document.createElement("div");
    mixer.className = "daw-track-mixer";
    const makeMixerSlider = (labelText, valueText, min, max, step, value, onInput) => {
      const label = document.createElement("label");
      label.className = "daw-track-slider";
      const caption = document.createElement("span");
      caption.textContent = labelText;
      const valueNode = document.createElement("output");
      valueNode.textContent = valueText(value);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.title = labelText;
      input.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        saveDawSnapshot();
      });
      input.addEventListener("input", () => {
        const next = Number(input.value);
        valueNode.textContent = valueText(next);
        onInput(next);
        updateDawTrackAudioNodes(track);
      });
      label.append(caption, input, valueNode);
      return label;
    };
    mixer.append(
      makeMixerSlider("声像", dawPanLabel, -1, 1, 0.01, track.pan, (value) => { track.pan = clamp(value, -1, 1); }),
      makeMixerSlider("音量", (value) => `${Math.round(value * 100)}%`, 0, 1.5, 0.01, track.gain, (value) => { track.gain = clamp(value, 0, 1.5); })
    );
    header.append(headerTop, mixer);

    const lane = document.createElement("div");
    lane.className = "daw-track-lane";
    lane.dataset.trackId = track.id;
    lane.style.width = `${laneWidth}px`;
    lane.style.height = `${track.height}px`;
    lane.addEventListener("pointerdown", (event) => {
      if (event.target !== lane) return;
      state.dawSelectedTrackId = track.id;
      state.dawSelectedClipId = "";
      const time = dawTimeFromLanePointer(event.clientX, lane, event.altKey);
      if (state.editorTool === "select" || event.shiftKey) {
        state.dawSelectionDrag = { trackId: track.id, start: time, lane, pointerId: event.pointerId };
        setDawSelection(track.id, time, time, false);
        lane.setPointerCapture?.(event.pointerId);
        return;
      }
      state.dawPlayhead = time;
      state.dawPlayheadDrag = { lane, pointerId: event.pointerId };
      lane.setPointerCapture?.(event.pointerId);
      updateDawPlayhead();
      updateDawSelectionOverlay();
    });

    if (!track.clips.length) {
      const empty = document.createElement("div");
      empty.className = "daw-empty-lane";
      empty.style.height = `${track.height}px`;
      empty.textContent = state.dawSelectedTrackId === track.id ? "当前轨道" : "";
      lane.appendChild(empty);
    }

    track.clips.forEach((clip) => {
      normalizeDawClip(clip);
      const clipEl = document.createElement("div");
      clipEl.className = "daw-clip";
      clipEl.classList.toggle("selected", state.dawSelectedClipId === clip.id);
      clipEl.classList.toggle("dragging", state.dawDrag?.clipId === clip.id);
      clipEl.dataset.clipId = clip.id;
      clipEl.style.left = `${clip.timelineStart * pps}px`;
      clipEl.style.width = `${Math.max(12, clip.duration * pps)}px`;
      clipEl.style.height = `${Math.max(48, track.height - 4)}px`;
      clipEl.title = `${clip.name}\n${formatTime(clip.sourceStart)} - ${formatTime(clip.sourceEnd)}\n右键调整升降调、音分与变速`;
      const clipName = document.createElement("span");
      clipName.className = "daw-clip-name";
      clipName.textContent = clip.name;
      const fxActive = Math.abs(clip.pitch) >= 0.001 || Math.abs(clip.cents) >= 0.001 || Math.abs(clip.tempo - 1) >= 0.001;
      const fxBadge = document.createElement("span");
      fxBadge.className = "daw-clip-fx";
      fxBadge.textContent = fxActive ? `${clip.pitch >= 0 ? "+" : ""}${clip.pitch}st · ${clip.cents >= 0 ? "+" : ""}${clip.cents}ct · ${clip.tempo.toFixed(2)}x` : "";
      fxBadge.hidden = !fxActive;
      const wave = document.createElement("canvas");
      wave.className = "daw-clip-wave";
      wave.setAttribute("aria-label", `${clip.name} 波形`);
      const startTrim = document.createElement("button");
      startTrim.className = "daw-clip-trim-handle start";
      startTrim.type = "button";
      startTrim.title = "拖动调整片段开头";
      startTrim.setAttribute("aria-label", `调整 ${clip.name} 的开头`);
      const endTrim = document.createElement("button");
      endTrim.className = "daw-clip-trim-handle end";
      endTrim.type = "button";
      endTrim.title = "拖动调整片段结尾";
      endTrim.setAttribute("aria-label", `调整 ${clip.name} 的结尾`);
      const removeClip = makeDawButton("×", "删除片段", "daw-clip-remove");
      removeClip.addEventListener("pointerdown", (event) => event.stopPropagation());
      removeClip.addEventListener("click", (event) => {
        event.stopPropagation();
        removeDawClip(clip.id);
      });
      const beginClipTrim = (edge, event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        normalizeDawClip(clip);
        state.dawSelectedTrackId = track.id;
        state.dawSelectedClipId = clip.id;
        state.dawClipTrim = {
          edge,
          clipId: clip.id,
          trackId: track.id,
          originalTimelineStart: clip.timelineStart,
          originalTimelineEnd: clip.timelineStart + clip.duration,
          originalSourceStart: clip.sourceStart,
          originalSourceEnd: clip.sourceEnd,
          sourceDuration: clip.sourceDuration,
          tempo: clip.tempo,
          moved: false,
          snapshotSaved: false
        };
      };
      startTrim.addEventListener("pointerdown", (event) => beginClipTrim("start", event));
      endTrim.addEventListener("pointerdown", (event) => beginClipTrim("end", event));
      clipEl.append(clipName, fxBadge, wave, startTrim, endTrim, removeClip);
      clipEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        state.dawSelectedTrackId = track.id;
        state.dawSelectedClipId = clip.id;
        const time = dawTimeFromLanePointer(event.clientX, lane, event.altKey);
        if (state.editorTool === "select" || event.shiftKey) {
          state.dawSelectionDrag = { trackId: track.id, start: time, lane, pointerId: event.pointerId };
          setDawSelection(track.id, time, time, false);
          clipEl.setPointerCapture?.(event.pointerId);
          return;
        }
        if (state.editorTool === "cut") {
          return;
        }
        state.dawPlayhead = time;
        updateDawPlayhead();
        state.dawDrag = {
          clipId: clip.id,
          trackId: track.id,
          startX: event.clientX,
          startScrollLeft: $("dawProjectScroll")?.scrollLeft || 0,
          originalStart: clip.timelineStart,
          moved: false,
          snapshotSaved: false
        };
        renderDawProject();
      });
      clipEl.addEventListener("dblclick", (event) => {
        if (state.editorTool !== "cut") return;
        event.preventDefault();
        event.stopPropagation();
        const projectTime = dawTimeFromLanePointer(event.clientX, lane, event.altKey);
        state.dawPlayhead = projectTime;
        splitDawClipAt(track, clip, projectTime);
      });
      clipEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.dawSelectedTrackId = track.id;
        state.dawSelectedClipId = clip.id;
        openDawClipMenu(clip, event.clientX, event.clientY);
      });
      lane.appendChild(clipEl);
      requestAnimationFrame(() => drawDawClipWaveform(wave, clip));
    });
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "daw-track-resize-handle";
    resizeHandle.title = "上下拖动调整轨道高度";
    resizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      state.dawTrackResize = {
        trackId: track.id,
        startY: event.clientY,
        startHeight: track.height,
        snapshotSaved: false
      };
      resizeHandle.setPointerCapture?.(event.pointerId);
    });
    row.append(header, lane, resizeHandle);
    trackList.appendChild(row);
  });
  updateDawPlayhead();
  updateDawSelectionOverlay();
  updateDawExportMarkers();
}

function updateDawPlayhead() {
  const playhead = $("dawProjectPlayhead");
  if (!playhead) return;
  const pps = dawPixelsPerSecond();
  playhead.style.left = `${DAW_TRACK_HEADER_WIDTH + state.dawPlayhead * pps}px`;
  playhead.style.display = state.dawTracks.some((track) => track.clips.length) ? "" : "none";
  if ($("dawPlayTime")) $("dawPlayTime").textContent = formatTime(state.dawPlayhead);
}

function stopDawPlayback(resetButton = true) {
  state.dawSources.forEach((source) => {
    try { source.stop(); } catch (_) {}
  });
  state.dawSources = [];
  state.dawTrackNodes.clear();
  state.dawPlaying = false;
  if (state.dawRaf) cancelAnimationFrame(state.dawRaf);
  state.dawRaf = null;
  if (resetButton && $("dawPlayBtn")) $("dawPlayBtn").textContent = "▶";
}

async function startDawPlayback() {
  const scheduled = state.dawTracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));
  const audible = scheduled.filter(({ track }) => isDawTrackAudible(track));
  if (!audible.length) {
    $("dawProjectStatus").textContent = "请先把音频放入轨道";
    return;
  }
  stopDawPlayback(false);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!state.dawAudioContext || state.dawAudioContext.state === "closed") state.dawAudioContext = new AudioContextClass();
  await state.dawAudioContext.resume();
  $("dawProjectStatus").textContent = "正在准备多轨预览";
  const uniquePaths = [...new Set(scheduled.map(({ clip }) => clip.sourcePath))];
  await Promise.all(uniquePaths.map(ensureDawAudioBuffer));
  const projectEnd = dawContentDuration();
  if (state.dawPlayhead >= projectEnd) state.dawPlayhead = 0;
  const startedAt = state.dawAudioContext.currentTime;
  scheduled.forEach(({ track, clip }) => {
    const clipEnd = clip.timelineStart + clip.duration;
    if (clipEnd <= state.dawPlayhead) return;
    const source = state.dawAudioContext.createBufferSource();
    const gain = state.dawAudioContext.createGain();
    const pan = typeof state.dawAudioContext.createStereoPanner === "function"
      ? state.dawAudioContext.createStereoPanner()
      : null;
    source.buffer = state.dawBufferCache.get(clip.sourcePath);
    source.playbackRate.value = clip.tempo || 1;
    if (source.detune) source.detune.value = (clip.pitch || 0) * 100 + (clip.cents || 0);
    gain.gain.value = isDawTrackAudible(track) ? clamp((clip.gain || 1) * track.gain, 0, 4.5) : 0;
    if (pan) {
      pan.pan.value = clamp(track.pan, -1, 1);
      source.connect(gain).connect(pan).connect(state.dawAudioContext.destination);
    } else {
      source.connect(gain).connect(state.dawAudioContext.destination);
    }
    const trackNodes = state.dawTrackNodes.get(track.id) || [];
    trackNodes.push({ gainNode: gain, panNode: pan, clipGain: clip.gain || 1 });
    state.dawTrackNodes.set(track.id, trackNodes);
    const insideOffset = Math.max(0, state.dawPlayhead - clip.timelineStart);
    const delay = Math.max(0, clip.timelineStart - state.dawPlayhead);
    const sourceOffset = clip.sourceStart + insideOffset * clip.tempo;
    const sourceDuration = Math.max(0.001, clip.sourceEnd - sourceOffset);
    source.start(startedAt + delay, sourceOffset, sourceDuration);
    state.dawSources.push(source);
  });
  state.dawPlaying = true;
  state.dawStartedAt = performance.now();
  state.dawStartPosition = state.dawPlayhead;
  $("dawPlayBtn").textContent = "Ⅱ";
  $("dawProjectStatus").textContent = "正在播放工程";
  const tick = () => {
    if (!state.dawPlaying) return;
    state.dawPlayhead = state.dawStartPosition + (performance.now() - state.dawStartedAt) / 1000;
    if (state.dawPlayhead >= projectEnd) {
      state.dawPlayhead = projectEnd;
      stopDawPlayback();
      $("dawProjectStatus").textContent = "工程播放完成";
      updateDawPlayhead();
      return;
    }
    updateDawPlayhead();
    const scroll = $("dawProjectScroll");
    const x = DAW_TRACK_HEADER_WIDTH + state.dawPlayhead * dawPixelsPerSecond();
    if (scroll && (x < scroll.scrollLeft + 140 || x > scroll.scrollLeft + scroll.clientWidth - 40)) {
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.4);
    }
    state.dawRaf = requestAnimationFrame(tick);
  };
  state.dawRaf = requestAnimationFrame(tick);
}

function dawExportPayload() {
  const hasSolo = state.dawTracks.some((track) => track.solo);
  const exportRange = effectiveDawExportRange();
  const outputFormat = $("dawExportFormat")?.value === "mp3" ? "mp3" : "wav";
  const sampleRate = Number($("dawExportSampleRate")?.value) === 48000 ? 48000 : 44100;
  const sourceName = basename(state.editorAudioPath || state.audioPath || "音频工程.wav").replace(/\.[^.]+$/, "");
  const outputName = $("dawExportName")?.value.trim() || `${sourceName || "音频工程"}_混音`;
  return {
    projectName: basename(state.editorAudioPath || state.audioPath || "音频工程.wav"),
    outputName,
    outputFormat,
    sampleRate,
    tracks: state.dawTracks.map((track) => ({
      id: track.id,
      name: track.name,
      muted: track.muted || (hasSolo && !track.solo),
      solo: track.solo,
      gain: track.gain,
      pan: track.pan,
      clips: track.clips.map((clip) => ({
        sourcePath: clip.sourcePath,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        timelineStart: clip.timelineStart,
        gain: clip.gain || 1,
        pitch: clip.pitch || 0,
        cents: clip.cents || 0,
        tempo: clip.tempo || 1
      }))
    })),
    exportRange
  };
}

function dawExportSignature(payload) {
  return JSON.stringify(payload);
}

async function reusableDawExport(signature) {
  const cached = state.dawExportCache.get(signature);
  if (!cached?.outputPath) return null;
  if (typeof window.gaobai?.fileExists === "function") {
    try {
      if (!await window.gaobai.fileExists(cached.outputPath)) {
        state.dawExportCache.delete(signature);
        return null;
      }
    } catch (_) {
      return null;
    }
  }
  return { ok: true, ...cached, reused: true };
}

function rememberDawExport(signature, result) {
  state.dawExportCache.set(signature, {
    outputPath: result.outputPath,
    outputDir: result.outputDir || "",
    duration: result.duration,
    clips: result.clips
  });
  while (state.dawExportCache.size > 8) {
    state.dawExportCache.delete(state.dawExportCache.keys().next().value);
  }
}

function setDawExportProgress(progress, label) {
  const value = clamp(progress, 0, 100);
  const feedback = $("dawExportFeedback");
  if (feedback) feedback.hidden = false;
  if ($("dawExportProgressLabel")) $("dawExportProgressLabel").textContent = label || "正在导出混音";
  if ($("dawExportProgressPercent")) $("dawExportProgressPercent").textContent = `${Math.round(value)}%`;
  if ($("dawExportProgressBar")) $("dawExportProgressBar").style.width = `${value}%`;
}

function setDawExportControlsDisabled(disabled) {
  ["dawExportSettingsBtn", "dawSeparateBtn", "dawExportBtn", "dawUploadBtn"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = Boolean(disabled);
  });
}

function dawExportActionCopy(action) {
  if (action === "separation") return { title: "导出到伴奏/人声分离", confirm: "确认并导出到分离" };
  if (action === "upload") return { title: "导出混音并上传 Suno", confirm: "确认导出并上传" };
  if (action === "export") return { title: "导出混音", confirm: "确认导出" };
  return { title: "混音导出设置", confirm: "保存设置" };
}

function closeDawExportDialog() {
  const dialog = $("dawExportDialog");
  if (dialog) dialog.classList.add("hidden");
  if ($("dawExportDialogError")) $("dawExportDialogError").classList.add("hidden");
  state.dawExportDialogAction = "";
}

function openDawExportDialog(action = "") {
  const dialog = $("dawExportDialog");
  if (!dialog) return;
  state.dawExportDialogAction = action;
  const copy = dawExportActionCopy(action);
  if ($("dawExportDialogTitle")) $("dawExportDialogTitle").textContent = copy.title;
  if ($("dawExportDialogConfirm")) $("dawExportDialogConfirm").textContent = copy.confirm;
  if ($("dawExportDialogError")) $("dawExportDialogError").classList.add("hidden");
  dialog.classList.remove("hidden");
  requestAnimationFrame(() => {
    $("dawExportName")?.focus();
    $("dawExportName")?.select();
  });
}

function requestDawExport(action) {
  const clips = state.dawTracks.filter(isDawTrackAudible).flatMap((track) => track.clips);
  if (!clips.length) {
    if ($("dawProjectStatus")) $("dawProjectStatus").textContent = "工程里没有可生成的音频";
    return;
  }
  openDawExportDialog(action);
}

function showDawExportNotice(message, isError = false) {
  const notice = $("dawExportNotice");
  if (!notice) return;
  clearTimeout(state.dawExportNoticeTimer);
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
  state.dawExportNoticeTimer = setTimeout(() => { notice.hidden = true; }, isError ? 9000 : 7000);
}

function acquireEditorLock() {
  if (state.editorBusy) {
    log("请等待当前编辑操作完成后再试。");
    return false;
  }
  state.editorBusy = true;
  return true;
}

function releaseEditorLock() {
  state.editorBusy = false;
}

async function renderDawSong(action = "export") {
  const clips = state.dawTracks.filter(isDawTrackAudible).flatMap((track) => track.clips);
  if (!clips.length) {
    $("dawProjectStatus").textContent = "工程里没有可生成的音频";
    return;
  }
  if (!acquireEditorLock()) return;
  let uploadReady = false;
  let separationReady = false;
  try {
    stopDawPlayback();
    state.dawExporting = true;
    setDawExportControlsDisabled(true);
    setDawExportProgress(5, "正在检查现有混音");
    const payload = dawExportPayload();
    const signature = dawExportSignature(payload);
    let result = await reusableDawExport(signature);
    const reused = Boolean(result?.reused);
    if (!result) {
      $("dawProjectStatus").textContent = "正在导出多轨混音";
      result = await window.gaobai.exportProject(payload);
      if (result?.ok) rememberDawExport(signature, result);
    }
    if (!result?.ok) {
      const message = result?.message || "多轨生成失败";
      $("dawProjectStatus").textContent = message;
      showDawExportNotice(`导出失败：${message}`, true);
      playTaskSound("failure");
      return;
    }
    state.editorOutputPath = result.outputPath;
    state.editorOutputDir = result.outputDir;
    setDawExportProgress(100, reused ? "已使用现有混音" : "导出完成");
    if (action === "separation") {
      state.separationAudioPath = result.outputPath;
      state.vocalsPath = "";
      state.instrumentalPath = "";
      state.separationOutputDir = "";
      $("separationAudioName").textContent = basename(result.outputPath);
      $("separationAudioPath").textContent = result.outputPath;
      $("separationStatus").textContent = `${reused ? "现有" : "导出的"}混音已载入，选择模型后开始分离`;
      $("separationOutputDir").textContent = "等待开始";
      setSeparationProgress(0);
      separationReady = true;
      $("dawProjectStatus").textContent = `${reused ? "现有混音已复用" : "混音已导出"}，正在进入伴奏/人声分离`;
      showDawExportNotice(`${reused ? "已使用现有混音" : "已完成导出"}：${result.outputPath}`);
    } else {
      if (action === "upload") {
        setCurrentAudio(result.outputPath);
        uploadReady = true;
        $("dawProjectStatus").textContent = `${reused ? "现有混音已复用" : "混音已导出"}，正在进入 Suno 上传`;
      } else {
        $("dawProjectStatus").textContent = `${reused ? "已使用现有混音" : "混音已导出"}：${result.outputPath}`;
      }
      showDawExportNotice(`${reused ? "已使用现有混音" : "已完成导出"}：${result.outputPath}`);
      log(`${reused ? "已复用" : "已导出"}多轨混音：${result.outputPath}`);
      if (action === "export") playTaskSound("success");
    }
  } catch (error) {
    const message = error?.message || String(error || "多轨生成失败");
    $("dawProjectStatus").textContent = `导出失败：${message}`;
    showDawExportNotice(`导出失败：${message}`, true);
    playTaskSound("failure");
  } finally {
    state.dawExporting = false;
    setDawExportControlsDisabled(false);
    releaseEditorLock();
  }
  if (uploadReady) {
    setTimeout(() => {
      goToPanel("uploadPage");
      setTimeout(() => $("startBtn")?.click(), 80);
    }, 500);
  } else if (separationReady) {
    setTimeout(() => goToPanel("separationPage"), 500);
  }
}

function snapDawTime(time, bypass = false) {
  const raw = Math.max(0, Number(time) || 0);
  if (!state.editorGrid?.snap || bypass) return raw;
  const grid = getEditorGridSeconds();
  return Math.max(0, Math.round(raw / grid) * grid);
}

function dawHorizontalDragActive() {
  return Boolean(
    state.dawExportMarkerDrag
    || state.dawSelectionResize
    || state.dawSelectionDrag
    || state.dawPlayheadDrag
    || state.dawClipTrim
    || state.dawDrag
  );
}

function updateDawPointerDrag(clientX, clientY, bypassSnap = false) {
  if (state.dawClipTrim) {
    const drag = state.dawClipTrim;
    const found = dawFindClip(drag.clipId);
    if (!found) return true;
    const lane = $("dawTrackList")?.querySelector(`.daw-track-lane[data-track-id="${found.track.id}"]`);
    if (!lane) return true;
    const rect = lane.getBoundingClientRect();
    const pointerTime = snapDawTime(Math.max(0, (clientX - rect.left) / dawPixelsPerSecond()), bypassSnap);
    const minDuration = 0.01;
    let nextTimelineStart = drag.originalTimelineStart;
    let nextTimelineEnd = drag.originalTimelineEnd;
    let nextSourceStart = drag.originalSourceStart;
    let nextSourceEnd = drag.originalSourceEnd;
    if (drag.edge === "start") {
      const earliestBySource = drag.originalTimelineStart - drag.originalSourceStart / drag.tempo;
      const earliest = Math.max(0, earliestBySource);
      nextTimelineStart = clamp(pointerTime, earliest, drag.originalTimelineEnd - minDuration);
      nextSourceStart = clamp(
        drag.originalSourceStart + (nextTimelineStart - drag.originalTimelineStart) * drag.tempo,
        0,
        drag.originalSourceEnd - minDuration * drag.tempo
      );
    } else {
      const latest = drag.originalTimelineEnd + (drag.sourceDuration - drag.originalSourceEnd) / drag.tempo;
      nextTimelineEnd = clamp(pointerTime, drag.originalTimelineStart + minDuration, latest);
      nextSourceEnd = clamp(
        drag.originalSourceEnd + (nextTimelineEnd - drag.originalTimelineEnd) * drag.tempo,
        drag.originalSourceStart + minDuration * drag.tempo,
        drag.sourceDuration
      );
    }
    const changed = Math.abs(nextTimelineStart - drag.originalTimelineStart) >= 0.001
      || Math.abs(nextTimelineEnd - drag.originalTimelineEnd) >= 0.001;
    if (!changed) return true;
    if (!drag.snapshotSaved) {
      saveDawSnapshot();
      drag.snapshotSaved = true;
    }
    drag.moved = true;
    found.clip.timelineStart = nextTimelineStart;
    found.clip.sourceStart = nextSourceStart;
    found.clip.sourceEnd = nextSourceEnd;
    normalizeDawClip(found.clip);
    renderDawProject();
    return true;
  }
  if (state.dawExportMarkerDrag) {
    const drag = state.dawExportMarkerDrag;
    const time = dawTimeFromLanePointer(clientX, drag.lane, bypassSnap);
    const range = effectiveDawExportRange();
    if (drag.edge === "start") setDawExportRange(Math.min(time, range.end - 0.001), range.end);
    else setDawExportRange(range.start, Math.max(time, range.start + 0.001));
    return true;
  }
  if (state.dawSelectionResize) {
    const drag = state.dawSelectionResize;
    const time = dawTimeFromLanePointer(clientX, drag.lane, bypassSnap);
    if (drag.edge === "start") {
      setDawSelection(drag.trackId, Math.min(time, drag.fixedTime - 0.001), drag.fixedTime);
    } else {
      setDawSelection(drag.trackId, drag.fixedTime, Math.max(time, drag.fixedTime + 0.001));
    }
    return true;
  }
  if (state.dawSelectionDrag) {
    const drag = state.dawSelectionDrag;
    const time = dawTimeFromLanePointer(clientX, drag.lane, bypassSnap);
    setDawSelection(drag.trackId, drag.start, time);
    return true;
  }
  if (state.dawPlayheadDrag) {
    state.dawPlayhead = dawTimeFromLanePointer(clientX, state.dawPlayheadDrag.lane, bypassSnap);
    updateDawPlayhead();
    return true;
  }
  const drag = state.dawDrag;
  if (!drag) return false;
  const found = dawFindClip(drag.clipId);
  if (!found) return true;
  const scroll = $("dawProjectScroll");
  const scrollDelta = (scroll?.scrollLeft || 0) - (drag.startScrollLeft || 0);
  const deltaX = clientX - drag.startX + scrollDelta;
  if (!drag.moved && Math.abs(deltaX) < 2) return true;
  if (!drag.snapshotSaved) {
    saveDawSnapshot();
    drag.snapshotSaved = true;
  }
  drag.moved = true;
  found.clip.timelineStart = snapDawTime(drag.originalStart + deltaX / dawPixelsPerSecond(), bypassSnap);
  const lane = document.elementFromPoint(clientX, clientY)?.closest?.(".daw-track-lane");
  const targetTrackId = lane?.dataset?.trackId;
  if (targetTrackId && targetTrackId !== found.track.id) {
    found.track.clips = found.track.clips.filter((clip) => clip.id !== found.clip.id);
    const targetTrack = dawTrackById(targetTrackId);
    targetTrack?.clips.push(found.clip);
    state.dawSelectedTrackId = targetTrackId;
  }
  renderDawProject();
  return true;
}

function stopDawAutoScroll() {
  state.dawAutoScrollPointer = null;
  if (state.dawAutoScrollRaf) cancelAnimationFrame(state.dawAutoScrollRaf);
  state.dawAutoScrollRaf = null;
  state.dawAutoScrollLastAt = 0;
}

function updateDawAutoScrollTarget(event) {
  if (!dawHorizontalDragActive()) return stopDawAutoScroll();
  state.dawAutoScrollPointer = {
    clientX: event.clientX,
    clientY: event.clientY,
    bypassSnap: Boolean(event.altKey)
  };
  if (state.dawAutoScrollRaf) return;
  const tick = (timestamp) => {
    state.dawAutoScrollRaf = null;
    const pointer = state.dawAutoScrollPointer;
    const scroll = $("dawProjectScroll");
    if (!pointer || !scroll || !dawHorizontalDragActive()) return stopDawAutoScroll();
    const rect = scroll.getBoundingClientRect();
    const leftEdge = rect.left + DAW_TRACK_HEADER_WIDTH + 42;
    const rightEdge = rect.right - 42;
    let direction = 0;
    if (pointer.clientX < leftEdge) direction = -1;
    else if (pointer.clientX > rightEdge) direction = 1;
    const elapsedMs = state.dawAutoScrollLastAt ? clamp(timestamp - state.dawAutoScrollLastAt, 0, 40) : 16;
    state.dawAutoScrollLastAt = timestamp;
    if (direction) {
      const before = scroll.scrollLeft;
      const delta = direction * 260 * elapsedMs / 1000;
      scroll.scrollLeft = clamp(before + delta, 0, Math.max(0, scroll.scrollWidth - scroll.clientWidth));
      if (Math.abs(scroll.scrollLeft - before) > 0.1) {
        updateDawPointerDrag(pointer.clientX, pointer.clientY, pointer.bypassSnap);
      }
    }
    state.dawAutoScrollRaf = requestAnimationFrame(tick);
  };
  state.dawAutoScrollRaf = requestAnimationFrame(tick);
}

function setupMiniDaw() {
  ensureDawTracks();
  syncDawRulerWithGrid();
  updateDawToolHint();
  const storedExportFormat = localStorage.getItem("qiyin-daw-export-format");
  const storedSampleRate = Number(localStorage.getItem("qiyin-daw-export-sample-rate"));
  if ($("dawExportFormat")) $("dawExportFormat").value = storedExportFormat === "mp3" ? "mp3" : "wav";
  if ($("dawExportSampleRate")) $("dawExportSampleRate").value = storedSampleRate === 48000 ? "48000" : "44100";
  renderDawProject();
  $("dawAddTrackBtn")?.addEventListener("click", addDawTrack);
  $("dawAddSelectionBtn")?.addEventListener("click", async () => {
    const selection = state.dawSelection;
    const selectedTrack = selection ? dawTrackById(selection.trackId) : null;
    const sourceClip = selectedTrack?.clips.find((clip) => (
      clip.timelineStart < selection.end && clip.timelineStart + clip.duration > selection.start
    ));
    const sourcePath = sourceClip?.sourcePath || state.editorAudioPath || state.audioPath;
    if (!sourcePath) {
      $("dawProjectStatus").textContent = "请先选择并载入音频";
      return;
    }
    try {
      if (sourceClip && selection) {
        const overlapStart = Math.max(selection.start, sourceClip.timelineStart);
        const overlapEnd = Math.min(selection.end, sourceClip.timelineStart + sourceClip.duration);
        const sourceStart = sourceClip.sourceStart + (overlapStart - sourceClip.timelineStart) * sourceClip.tempo;
        await addDawClip(sourcePath, sourceStart, sourceStart + (overlapEnd - overlapStart) * sourceClip.tempo);
      } else {
        const bounds = getClipBounds();
        await addDawClip(sourcePath, bounds.start, bounds.end);
      }
    } catch (error) {
      $("dawProjectStatus").textContent = `加入轨道失败：${error.message}`;
    }
  });
  $("dawImportAudioBtn")?.addEventListener("click", async () => {
    const filePath = await window.gaobai.pickAudio();
    if (!filePath) return;
    try {
      await addDawClip(filePath, 0, null, true);
    } catch (error) {
      $("dawProjectStatus").textContent = `导入失败：${error.message}`;
    }
  });
  $("dawUndoBtn")?.addEventListener("click", undoDawEdit);
  $("dawExportBtn")?.addEventListener("click", () => requestDawExport("export"));
  $("dawUploadBtn")?.addEventListener("click", () => requestDawExport("upload"));
  $("dawSeparateBtn")?.addEventListener("click", () => requestDawExport("separation"));
  $("dawExportSettingsBtn")?.addEventListener("click", () => openDawExportDialog(""));
  ["dawExportDialogClose", "dawExportDialogCancel", "dawExportDialogBackdrop"].forEach((id) => {
    $(id)?.addEventListener("click", closeDawExportDialog);
  });
  $("dawExportDialogForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const outputName = $("dawExportName")?.value.trim() || "";
    if (!outputName) {
      $("dawExportDialogError")?.classList.remove("hidden");
      $("dawExportName")?.focus();
      return;
    }
    localStorage.setItem("qiyin-daw-export-format", $("dawExportFormat")?.value === "mp3" ? "mp3" : "wav");
    localStorage.setItem("qiyin-daw-export-sample-rate", Number($("dawExportSampleRate")?.value) === 48000 ? "48000" : "44100");
    const action = state.dawExportDialogAction;
    closeDawExportDialog();
    if (action) renderDawSong(action);
    else showDawExportNotice("导出设置已保存");
  });
  $("dawExportSelectionBtn")?.addEventListener("click", () => {
    if (!state.dawSelection) {
      $("dawProjectStatus").textContent = "请先在轨道上选择一个区域";
      return;
    }
    setDawExportRange(state.dawSelection.start, state.dawSelection.end, true);
  });
  $("dawExportFullBtn")?.addEventListener("click", () => {
    state.dawExportRange = null;
    updateDawExportMarkers();
    $("dawProjectStatus").textContent = "已恢复导出整个工程";
  });
  $("dawClipMenuClose")?.addEventListener("click", closeDawClipMenu);
  $("dawClipApplyBtn")?.addEventListener("click", applyDawClipEffects);
  $("dawClipResetBtn")?.addEventListener("click", () => {
    $("dawClipPitchInput").value = "0";
    $("dawClipCentsInput").value = "0";
    $("dawClipTempoInput").value = "1";
  });
  $("dawPlayBtn")?.addEventListener("click", () => {
    if (state.dawPlaying) {
      state.dawPlayhead = state.dawStartPosition + (performance.now() - state.dawStartedAt) / 1000;
      stopDawPlayback();
      updateDawPlayhead();
      $("dawProjectStatus").textContent = "工程已暂停";
    } else {
      startDawPlayback().catch((error) => {
        stopDawPlayback();
        $("dawProjectStatus").textContent = `播放失败：${error.message}`;
      });
    }
  });
  $("dawZoomInput")?.addEventListener("input", (event) => {
    state.dawZoom = clamp(Number(event.target.value) || 1, DAW_ZOOM_MIN, DAW_ZOOM_MAX);
    renderDawProject();
  });
  $("dawRulerMode")?.addEventListener("change", (event) => {
    state.dawRulerMode = event.target.value === "bars" ? "bars" : "time";
    if (state.dawRulerMode === "time") state.editorGrid.unit = "time";
    else if (state.editorGrid.unit === "time") state.editorGrid.unit = "beat";
    if ($("editorGridUnit")) $("editorGridUnit").value = state.editorGrid.unit;
    localStorage.setItem("qiyin-daw-ruler", state.dawRulerMode);
    saveEditorPrefs();
    renderDawProject();
  });
  $("dawProjectScroll")?.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !(event.altKey && event.shiftKey)) return;
    event.preventDefault();
    if (event.ctrlKey) {
      const target = event.target instanceof Element ? event.target : null;
      const trackId = target?.closest?.(".daw-track-row")?.dataset?.trackId || state.dawSelectedTrackId;
      const track = dawTrackById(trackId);
      if (!track) return;
      track.height = clamp(
        track.height + (event.deltaY < 0 ? 8 : -8),
        DAW_TRACK_MIN_HEIGHT,
        DAW_TRACK_MAX_HEIGHT
      );
      renderDawProject();
      $("dawProjectStatus").textContent = `轨道高度：${Math.round(track.height)} px`;
      return;
    }
    const scroll = $("dawProjectScroll");
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    const viewportX = clamp(event.clientX - rect.left, DAW_TRACK_HEADER_WIDTH, rect.width);
    const anchorTime = Math.max(0, (scroll.scrollLeft + viewportX - DAW_TRACK_HEADER_WIDTH) / dawPixelsPerSecond());
    state.dawZoom = clamp(state.dawZoom + (event.deltaY < 0 ? 0.25 : -0.25), DAW_ZOOM_MIN, DAW_ZOOM_MAX);
    if ($("dawZoomInput")) $("dawZoomInput").value = String(state.dawZoom);
    renderDawProject();
    scroll.scrollLeft = Math.max(0, DAW_TRACK_HEADER_WIDTH + anchorTime * dawPixelsPerSecond() - viewportX);
  }, { passive: false });
  const ruler = $("dawProjectRuler");
  ruler?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const time = dawTimeFromLanePointer(event.clientX, ruler, event.altKey);
    state.dawPlayhead = time;
    state.dawPlayheadDrag = { lane: ruler, pointerId: event.pointerId };
    ruler.setPointerCapture?.(event.pointerId);
    updateDawPlayhead();
    updateDawSelectionOverlay();
  });
  $("dawProjectPlayhead")?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !ruler) return;
    event.preventDefault();
    event.stopPropagation();
    state.dawPlayheadDrag = { lane: ruler, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  });
  document.querySelectorAll("[data-export-marker]").forEach((marker) => {
    marker.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !ruler) return;
      event.preventDefault();
      event.stopPropagation();
      state.dawExportMarkerDrag = {
        edge: marker.dataset.exportMarker === "start" ? "start" : "end",
        lane: ruler,
        pointerId: event.pointerId
      };
      marker.setPointerCapture?.(event.pointerId);
    });
  });
  document.querySelectorAll("[data-selection-edge]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.dawSelection) return;
      event.preventDefault();
      event.stopPropagation();
      const selection = state.dawSelection;
      const lane = $("dawTrackList")?.querySelector(`.daw-track-lane[data-track-id="${selection.trackId}"]`);
      if (!lane) return;
      const edge = handle.dataset.selectionEdge === "start" ? "start" : "end";
      state.dawSelectionResize = {
        edge,
        trackId: selection.trackId,
        fixedTime: edge === "start" ? selection.end : selection.start,
        lane,
        pointerId: event.pointerId
      };
      handle.setPointerCapture?.(event.pointerId);
    });
  });

  document.addEventListener("pointermove", (event) => {
    if (state.dawTrackResize) {
      const drag = state.dawTrackResize;
      const track = dawTrackById(drag.trackId);
      if (!track) return;
      const delta = event.clientY - drag.startY;
      if (!drag.snapshotSaved && Math.abs(delta) >= 2) {
        saveDawSnapshot();
        drag.snapshotSaved = true;
      }
      track.height = clamp(drag.startHeight + delta, DAW_TRACK_MIN_HEIGHT, DAW_TRACK_MAX_HEIGHT);
      const row = $("dawTrackList")?.querySelector(`[data-track-id="${track.id}"]`);
      if (row) {
        row.style.height = `${track.height}px`;
        row.querySelector(".daw-track-header")?.style.setProperty("height", `${track.height}px`);
        row.querySelector(".daw-track-lane")?.style.setProperty("height", `${track.height}px`);
        row.querySelector(".daw-empty-lane")?.style.setProperty("height", `${track.height}px`);
        row.querySelectorAll(".daw-clip").forEach((clip) => { clip.style.height = `${Math.max(48, track.height - 4)}px`; });
      }
      updateDawSelectionOverlay();
      return;
    }
    updateDawAutoScrollTarget(event);
    updateDawPointerDrag(event.clientX, event.clientY, event.altKey);
  });
  document.addEventListener("pointerup", () => {
    stopDawAutoScroll();
    if (state.dawClipTrim) {
      const trim = state.dawClipTrim;
      state.dawClipTrim = null;
      renderDawProject();
      if (trim.moved) {
        const found = dawFindClip(trim.clipId);
        if (found && $("dawProjectStatus")) {
          $("dawProjectStatus").textContent = `片段${trim.edge === "start" ? "开头" : "结尾"}已调整：${formatTime(found.clip.sourceStart)} - ${formatTime(found.clip.sourceEnd)}`;
        }
      }
      return;
    }
    if (state.dawTrackResize) {
      const resized = state.dawTrackResize.snapshotSaved;
      state.dawTrackResize = null;
      renderDawProject();
      if (resized) $("dawProjectStatus").textContent = "轨道高度已调整";
    }
    if (state.dawSelectionDrag) {
      state.dawSelectionDrag = null;
      if (state.dawSelection) $("dawProjectStatus").textContent = `已选择 ${formatTime(state.dawSelection.start)} - ${formatTime(state.dawSelection.end)}`;
    }
    if (state.dawSelectionResize) {
      state.dawSelectionResize = null;
      if (state.dawSelection) $("dawProjectStatus").textContent = `选区已调整：${formatTime(state.dawSelection.start)} - ${formatTime(state.dawSelection.end)}`;
    }
    if (state.dawExportMarkerDrag) {
      state.dawExportMarkerDrag = null;
      const range = effectiveDawExportRange();
      $("dawProjectStatus").textContent = `导出范围已调整：${formatTime(range.start)} - ${formatTime(range.end)}`;
    }
    state.dawPlayheadDrag = null;
    if (!state.dawDrag) return;
    const moved = state.dawDrag.moved;
    state.dawDrag = null;
    renderDawProject();
    if (moved) $("dawProjectStatus").textContent = "片段位置已更新";
  });
  document.addEventListener("pointercancel", () => {
    stopDawAutoScroll();
    if (state.dawClipTrim) {
      state.dawClipTrim = null;
      renderDawProject();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const menu = $("dawClipMenu");
    if (!menu || menu.hidden || event.target.closest?.("#dawClipMenu")) return;
    closeDawClipMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("dawExportDialog")?.classList.contains("hidden")) {
      event.preventDefault();
      closeDawExportDialog();
      return;
    }
    if ((!state.dawSelectedClipId && !state.dawSelection) || !["Delete", "Backspace"].includes(event.key)) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (document.querySelector(".module-page.active")?.id !== "editorPage") return;
    event.preventDefault();
    deleteDawProjectSelection();
  });
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (document.querySelector(".module-page.active")?.id !== "editorPage") return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    $("dawPlayBtn")?.click();
  });
  window.addEventListener("resize", renderDawProject);
}

function setupTimelineDrag() {
  const timeline = $("clipTimeline");
  const selection = $("timelineSelection");
  const viewport = $("timelineViewport");
  if (!timeline || !selection) return;

  const beginDrag = (event, mode) => {
    if (!state.editorDuration) return;
    event.preventDefault();
    const bounds = getClipBounds();
    state.timelineDrag = {
      mode,
      startX: event.clientX,
      start: bounds.start,
      end: bounds.end,
      offset: timelineClientToSeconds(event.clientX) - bounds.start
    };
    selection.classList.add("dragging");
  };

  selection.addEventListener("pointerdown", (event) => {
    const handle = event.target?.dataset?.handle;
    beginDrag(event, handle || "move");
  });

  viewport?.addEventListener("pointerdown", (event) => {
    if (!state.editorDuration) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = timeline.getBoundingClientRect();
    const view = getWaveView();
    state.timelineViewDrag = {
      offsetRatio: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) - view.start / view.total
    };
    viewport.classList.add("dragging");
    viewport.setPointerCapture?.(event.pointerId);
  });

  timeline.addEventListener("pointerdown", (event) => {
    if (event.target.classList.contains("timeline-handle")) return;
    event.preventDefault();
    const time = timelineClientToSeconds(event.clientX);
    state.editorCursor = time;
    centerWaveViewAt(time);
    drawWaveform();
    updateEditorCursor(time);
  });

  window.addEventListener("pointermove", (event) => {
    const viewDrag = state.timelineViewDrag;
    if (viewDrag) {
      const rect = timeline.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      setWaveViewStart((ratio - viewDrag.offsetRatio) * Math.max(0.1, state.editorDuration || 30));
      drawWaveform();
      return;
    }
    const drag = state.timelineDrag;
    if (!drag) return;
    const max = Math.max(0.1, state.editorDuration || 30);
    const current = timelineClientToSeconds(event.clientX);
    if (drag.mode === "start") {
      setClipBoundsFromSeconds(Math.min(current, drag.end - 0.1), drag.end);
    } else if (drag.mode === "end") {
      setClipBoundsFromSeconds(drag.start, Math.max(current, drag.start + 0.1));
    } else {
      const duration = drag.end - drag.start;
      let nextStart = current - drag.offset;
      nextStart = clamp(nextStart, 0, Math.max(0, max - duration));
      setClipBoundsFromSeconds(nextStart, nextStart + duration);
    }
  });

  window.addEventListener("pointerup", () => {
    state.timelineDrag = null;
    state.timelineViewDrag = null;
    selection.classList.remove("dragging");
    viewport?.classList.remove("dragging");
  });

  const redrawGrid = () => { drawWaveform(); renderDawProject(); };
  $("editorBpmInput")?.addEventListener("change", (event) => {
    state.editorGrid.bpm = clamp(Number(event.target.value) || 120, 40, 260);
    event.target.value = state.editorGrid.bpm;
    saveEditorPrefs();
    redrawGrid();
  });
  $("editorGridUnit")?.addEventListener("change", (event) => {
    state.editorGrid.unit = event.target.value || "beat";
    syncDawRulerWithGrid();
    saveEditorPrefs();
    redrawGrid();
  });
  $("editorSnapToggle")?.addEventListener("change", (event) => {
    state.editorGrid.snap = Boolean(event.target.checked);
    saveEditorPrefs();
    redrawGrid();
  });
  [["editorCursorTool", "cursor"], ["editorSelectTool", "select"], ["editorCutTool", "cut"]].forEach(([id, tool]) => {
    $(id)?.addEventListener("click", () => {
      state.editorTool = tool;
      $("editorCursorTool")?.classList.toggle("active", tool === "cursor");
      $("editorSelectTool")?.classList.toggle("active", tool === "select");
      $("editorCutTool")?.classList.toggle("active", tool === "cut");
      updateDawSelectionOverlay();
      updateDawToolHint();
    });
  });
  $("editorDeleteSelectionBtn")?.addEventListener("click", () => {
    deleteDawProjectSelection();
  });
}

function getStemPath(kind) {
  return kind === "vocals" ? state.vocalsPath : state.instrumentalPath;
}

// 绘制 stem 波形
async function loadStemWaveform(kind) {
  const filePath = getStemPath(kind);
  if (!filePath) return;
  try {
    const bytes = await window.gaobai.readAudioFile(filePath);
    if (!bytes) return;
    const view = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(view);
    await audioContext.close();
    state.stemDuration[kind] = decoded.duration || 0;
    const channel = decoded.getChannelData(0);
    const buckets = 600;
    const step = Math.max(1, Math.floor(channel.length / buckets));
    state.stemWaveformPeaks[kind] = Array.from({ length: buckets }, (_, index) => {
      let max = 0;
      const offset = index * step;
      for (let i = 0; i < step && offset + i < channel.length; i += 1) {
        max = Math.max(max, Math.abs(channel[offset + i]));
      }
      return max;
    });
    drawStemWaveform(kind);
  } catch (_) { /* ignore */ }
}

function drawStemWaveform(kind) {
  const canvas = $(kind === "vocals" ? "vocalsWaveCanvas" : "instrumentalWaveCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const container = canvas.parentElement;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width > 0) {
    canvas.width = Math.round(rect.width * (window.devicePixelRatio || 1));
    canvas.height = Math.round(48 * (window.devicePixelRatio || 1));
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  }
  const width = rect.width || canvas.width;
  const height = 48;
  ctx.clearRect(0, 0, width, height);

  const peaks = state.stemWaveformPeaks[kind];
  if (!peaks || !peaks.length) return;

  const center = height / 2;
  const usableHeight = height * 0.68;
  const color = kind === "vocals" ? "#4c92ff" : "#26c987";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 1) {
    const peak = peaks[Math.floor((x / width) * peaks.length)] || 0;
    const bar = Math.max(1, peak * usableHeight);
    ctx.beginPath();
    ctx.moveTo(x, center - bar / 2);
    ctx.lineTo(x, center + bar / 2);
    ctx.stroke();
  }

  // DOM 播放指针由 updateStemPlayhead 处理
  updateStemPlayhead(kind);
}

// 更新 stem DOM 播放指针
function updateStemPlayhead(kind) {
  const playhead = $(kind === "vocals" ? "vocalsPlayhead" : "instrumentalPlayhead");
  if (!playhead) return;
  if (!state.stemAudio || state.stemAudioKind !== kind || !state.stemDuration[kind]) {
    playhead.style.display = "none";
    return;
  }
  const duration = state.stemDuration[kind] || 1;
  const pct = (state.stemAudio.currentTime / duration) * 100;
  if (pct >= 0 && pct <= 100) {
    playhead.style.display = "";
    playhead.style.left = pct + "%";
  } else {
    playhead.style.display = "none";
  }
}

async function playStem(kind) {
  const filePath = getStemPath(kind);
  if (!filePath) {
    log(kind === "vocals" ? "还没有可试听的人声文件。" : "还没有可试听的伴奏文件。");
    return;
  }
  if (state.stemAudio && state.stemAudioKind !== kind) {
    state.stemAudio.pause();
    updateStemPlayhead(state.stemAudioKind);
  }
  if (!state.stemAudio || state.stemAudioKind !== kind) {
    state.stemAudio = new Audio(await window.gaobai.fileUrl(filePath));
    state.stemAudioKind = kind;
    const volume = $(kind === "vocals" ? "vocalsVolume" : "instrumentalVolume");
    state.stemAudio.volume = Number(volume?.value || 0.75);

    // 使用 requestAnimationFrame 实现 60fps 丝滑走带
    let stemRAF = null;
    function stemPlayheadLoop() {
      updateStemPlayhead(kind);
      if (state.stemAudio && state.stemAudioKind === kind && !state.stemAudio.paused) {
        stemRAF = requestAnimationFrame(stemPlayheadLoop);
      }
    }
    state.stemAudio.addEventListener("play", () => {
      stemRAF = requestAnimationFrame(stemPlayheadLoop);
    });
    state.stemAudio.addEventListener("pause", () => {
      if (stemRAF) { cancelAnimationFrame(stemRAF); stemRAF = null; }
      updateStemPlayhead(kind);
    });
    state.stemAudio.addEventListener("ended", () => {
      if (stemRAF) { cancelAnimationFrame(stemRAF); stemRAF = null; }
      updateStemPlayhead(kind);
      const btn = $(kind === "vocals" ? "vocalsPlayBtn" : "instrumentalPlayBtn");
      if (btn) btn.textContent = "▶";
    });

    // 首次播放时加载波形
    if (!state.stemWaveformPeaks[kind].length) {
      await loadStemWaveform(kind);
    }
  }
  const btn = $(kind === "vocals" ? "vocalsPlayBtn" : "instrumentalPlayBtn");
  if (state.stemAudio.paused) {
    await state.stemAudio.play();
    if (btn) btn.textContent = "Ⅱ";
  } else {
    state.stemAudio.pause();
    if (btn) btn.textContent = "▶";
    updateStemPlayhead(kind);
  }
}

async function exportStem(kind) {
  const filePath = getStemPath(kind);
  if (!filePath) {
    log(kind === "vocals" ? "还没有可导出的人声文件。" : "还没有可导出的伴奏文件。");
    return;
  }
  const defaultName = basename(filePath);
  const result = await window.gaobai.saveCopy({ sourcePath: filePath, defaultName });
  if (result?.ok) {
    log(`已导出音频：${result.filePath}`);
  } else if (!result?.cancelled) {
    log(result?.message || "导出音频失败。");
  }
}

async function openStemLocation(kind) {
  const filePath = getStemPath(kind);
  if (filePath) {
    await window.gaobai.openPath(filePath);
    return;
  }
  if (state.separationOutputDir) {
    await window.gaobai.openPath(state.separationOutputDir);
    return;
  }
  log("还没有可打开的分离输出目录。");
}

document.addEventListener("DOMContentLoaded", () => {
  setBusy(false);
  setProgress(0);
  setSeparationProgress(0);
  drawWaveform();
  setupNavigation();
  setupWindowControls();
  setupHistoryFilters();
  setupSpeedOptions();
  setupUploadBatchControls();
  setupEmbeddedAccountLogin();
  setupAccountControls();
  loadEditorPrefs();
  setupTimelineDrag();
  setupMiniDaw();
  // 检查更新 / 公告移到 initLicense 内（启动时检查授权后调用）
  log("欢迎使用期音科技 · Suno 歌曲上传器。");
  refreshHistory();
  refreshSeparationModels();
  refreshSeparationDevices();
  // 启动时检查 Suno 登录状态
  checkLoginStatus();

  // 启动时检查官网账号权益状态
  initLicense();
  refreshAccountStatus();

  // 启动时恢复解密输出目录
  restoreUnlockerOutputDir();

  // 解锁器事件绑定(选择文件/目录按钮、drop 区、MMKV 等)
  unlockerInit();

  $("pickBtn").addEventListener("click", async () => {
    if (!requireLicense("选择上传音频")) return;
    const file = await window.gaobai.pickAudio();
    if (!file) return;
    setCurrentAudio(file);
  });

  $("clearAudioBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!state.audioPath || state.busy) return;
    const name = basename(state.audioPath);
    setCurrentAudio("");
    log(`已清空上传音频占位：${name}`);
  });

  $("removeAudioBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!state.audioPath || state.busy) return;
    const name = basename(state.audioPath);
    setCurrentAudio("");
    log(`已移除上传音频：${name}`);
  });

  // Drag & drop audio into upload workbench (also click to pick)
  const uploadDrop = $("uploadDropArea");
  if (uploadDrop) {
    uploadDrop.addEventListener("click", async () => {
      if (!requireLicense("选择上传音频")) return;
      const file = await window.gaobai.pickAudio();
      if (!file) return;
      setCurrentAudio(file);
    });
    uploadDrop.addEventListener("dragover", (e) => { e.preventDefault(); uploadDrop.classList.add("dragover"); });
    uploadDrop.addEventListener("dragleave", () => uploadDrop.classList.remove("dragover"));
    uploadDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadDrop.classList.remove("dragover");
      if (!requireLicense("拖入上传音频")) return;
      const files = Array.from(e.dataTransfer?.files || []);
      const audioFile = files.find(f => OPEN_AUDIO_PATTERN.test(f.name));
      if (audioFile) {
        const ap = window.getPathForFile(audioFile);
        if (ap) {
          setCurrentAudio(ap);
          log(`已拖入音频：${basename(ap)}`);
        } else {
          log("请拖入 mp3、wav、m4a、flac、ogg、ape、wma 等开放音频文件");
        }
      }
    });
  }

  // Drag & drop into editor / waveform area
  const editorDrop = $("editorDropArea");
  if (editorDrop) {
    editorDrop.addEventListener("dragover", (e) => { e.preventDefault(); editorDrop.classList.add("dragover"); });
    editorDrop.addEventListener("dragleave", () => editorDrop.classList.remove("dragover"));
    editorDrop.addEventListener("drop", async (e) => {
      e.preventDefault();
      editorDrop.classList.remove("dragover");
      if (!requireLicense("音频剪辑")) return;
      const files = Array.from(e.dataTransfer?.files || []);
      const audioFile = files.find(f => OPEN_AUDIO_PATTERN.test(f.name));
      if (!audioFile) {
        log("请拖入 mp3、wav、m4a、flac、ogg、ape、wma 等开放音频文件到剪辑区");
        return;
      }
      const ap = window.getPathForFile(audioFile);
      if (!ap) {
        log("请拖入 mp3、wav、m4a、flac、ogg、ape、wma 等开放音频文件到剪辑区");
        return;
      }
      try {
        await loadEditorAudio(ap);
        log(`剪辑区已载入：${basename(ap)}`);
      } catch (error) {
        log(`音频读取失败：${error.message}`);
      }
    });
  }

  $("statusPill")?.addEventListener("click", (event) => {
    event.preventDefault();
    if (state.licenseValid) return;
    openActivationModal();
  });

  $("openActivationBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openActivationModal();
  });

  $("loginBtn").addEventListener("click", async () => {
    setBusy(true);
    setStatus("正在登录 Suno…", "登录中");
    setUploadNotice("正在打开 Suno 登录窗口，请在浏览器中完成登录。", "warn");
    setProgress(8);
    log("正在打开 Suno 登录窗口。");
    const result = await window.gaobai.login();
    if (!result.ok) {
      const message = sanitizeLoginMessage(result.message || "无法启动登录流程。");
      setBusy(false);
      setStatus("登录失败", "登录失败", "error");
      setUploadNotice(message, "error");
      log(message);
      // 1.8s 后清掉任务标签
      setTimeout(clearTaskPill, 1800);
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    const result = await window.gaobai.logout();
    if (!result?.ok) {setUploadNotice(result?.message || "退出未完成，请重试。", "error");return;}
    $("loginBtn").style.display = "";
    $("logoutBtn").style.display = "none";
    setUploadNotice("已退出 Suno 登录。需要上传时请重新登录。", "success");
    log("已退出 Suno 登录。");
  });

  async function startSunoUpload(resumePolicy = "") {
    if (!requireLicense("上传 Suno")) return;
    if (!state.audioPath) {
      log("请先选择音频文件。");
      return;
    }
    setBusy(true);
    resetUploadEta();
    resetUploadMetrics();
    state.uploadAdjustmentAttempt = 1;
    state.uploadWorkDir = "";
    state.uploadSegmentsDir = "";
    updateUploadAudioButtons();
    setUploadEtaBadge("预计完成 --:--", "剩余计算中");
    setProgress(3);
    setStatus("准备上传", "上传中");
    const result = await window.gaobai.startUpload({
      ...window.sunoAccountBinding?.(),
      audioPath: state.audioPath,
      title: $("titleInput").value.trim(),
      speed: state.speed,
      resumePolicy
    });
    if (!result.ok) {
      if (result.code === "resume_decision_required" && result.candidate) {
        const candidate = result.candidate;
        setBusy(false);
        const completed = Number(candidate.completed) || 0;
        const total = Number(candidate.total) || 0;
        const message = candidate.canResume
          ? `检测到登录失效前的上传任务：已完成 ${completed} / ${total}。\n${candidate.reason || "可以继续旧任务。"}\n\n确定：继续旧任务\n取消：创建新的上传项目`
          : `检测到旧上传任务，但不建议继续。\n${candidate.reason || "建议创建新项目。"}\n\n确定：仍尝试继续\n取消：创建新的上传项目`;
        const shouldResume = window.confirm(message);
        return startSunoUpload(shouldResume ? "resume" : "new");
      }
      if (result.code === "suno_login_required") {
        log(result.message || "Suno 登录状态不可用，请重新登录。");
        restoreSunoLoginUi(result.message || "Suno 登录状态不可用，请重新登录后再上传。");
        return;
      }
      setBusy(false);
      setStatus("准备就绪");
      setUploadEtaBadge("启动失败", "未开始上传", "error");
      log(result.message || "无法启动上传任务。");
      const node = logHtml(`↳ <a href="#" data-action="open-editor-for-reupload">修改后重传（升降调 / 变速 / 裁剪后重传）</a>`, "warn");
      const link = node.querySelector('a[data-action="open-editor-for-reupload"]');
      if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openEditorForReupload(); });
    }
  }

  $("startBtn").addEventListener("click", () => startSunoUpload());

  $("stopBtn").addEventListener("click", async () => {
    await window.gaobai.stopJob();
    setBusy(false);
    setStatus("已停止", "已停止");
    log("已请求停止当前任务。");
  });

  $("openResultBtn").addEventListener("click", async () => {
    if (!state.lastUrl) {
      log("暂时没有可打开的结果链接。");
      return;
    }
    await window.gaobai.openUrl(state.lastUrl);
  });

  $("openSegmentsBtn")?.addEventListener("click", async () => {
    const target = state.uploadSegmentsDir || state.uploadWorkDir;
    if (!target) return;
    await window.gaobai.openPath(target);
  });

  $("clearSegmentsBtn")?.addEventListener("click", async () => {
    if (state.busy) return;
    const result = await window.gaobai.clearSegments(state.uploadWorkDir || "");
    if (result && result.ok) {
      state.uploadSegmentsDir = result.segmentsDir || state.uploadSegmentsDir;
      updateUploadAudioButtons();
      setStatus(`已清除切片：${result.deleted || 0} 个`, "清理完成", "success");
      setTimeout(clearTaskPill, 1500);
    } else {
      setStatus("切片清除失败", "清理失败", "error");
      log((result && result.message) || "切片清除失败。");
    }
  });

  $("processLyricsBtn")?.addEventListener("click", async () => {
    if (!requireLicense("歌词处理")) return;
    const mode = $("lyricsMode")?.value || "homophone";
    const text = $("lyricsInput").value;
    if (!text.trim()) { log("请先粘贴歌词。"); return; }
    $("lyricsOutput").value = "处理中...";
    try {
      const result = await window.gaobai.processLyrics({ mode, text });
      if (result?.ok) {
        $("lyricsOutput").value = result.text;
        log("歌词处理完成。");
      } else {
        log(result?.message || "歌词处理失败。");
      }
    } catch (error) {
      log(`歌词处理失败：${error.message || error}`);
    }
  });

  $("copyLyricsBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("lyricsOutput").value || "");
    log("歌词结果已复制。");
  });

  $("refreshHistoryBtn").addEventListener("click", refreshHistory);
  $("clearHistoryBtn").addEventListener("click", async () => {
    await window.gaobai.clearHistory();
    await refreshHistory();
    log("上传历史已清空。");
  });

  $("pickEditorBtn").addEventListener("click", async () => {
    if (!requireLicense("音频剪辑")) return;
    const file = await window.gaobai.pickAudio();
    if (!file) return;
    try {
      await loadEditorAudio(file);
    } catch (error) {
      $("clipStatus").textContent = "读取失败";
      log(`音频剪辑读取失败：${error.message}`);
    }
  });

  // 波形缩放控制
  function zoomWaveform(direction) {
    if (!state.waveformAllPeaks.length) return;
    const maxZoom = 16;
    const currentZoom = Math.max(1, state.waveformZoom || 1);
    if (direction === "in") {
      setWaveZoomAroundCursor(Math.min(maxZoom, currentZoom * 1.5));
    } else if (direction === "out") {
      const nextZoom = Math.max(1, currentZoom / 1.5);
      setWaveZoomAroundCursor(nextZoom <= 1.01 ? 1 : nextZoom);
    } else if (direction === "fit") {
      state.waveformZoom = 1;
      state.waveformScroll = 0;
    }
    drawWaveform();
  }
  $("waveZoomInBtn")?.addEventListener("click", () => zoomWaveform("in"));
  $("waveZoomOutBtn")?.addEventListener("click", () => zoomWaveform("out"));
  $("waveZoomFitBtn")?.addEventListener("click", () => zoomWaveform("fit"));

  // 波形区域滚轮缩放
  const waveShell = $("mainWaveShell");
  if (waveShell) {
    waveShell.addEventListener("wheel", (e) => {
      if (!state.waveformAllPeaks.length) return;
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomWaveform("in");
      } else {
        zoomWaveform("out");
      }
    }, { passive: false });
  }

  // 播放走带：使用 requestAnimationFrame 实现 60fps 丝滑走带
  const editorPlayer = $("editorPlayer");
  let editorRAF = null;

  function editorPlayheadLoop() {
    updateWavePlayhead();
    if (editorPlayer && !editorPlayer.paused) {
      editorRAF = requestAnimationFrame(editorPlayheadLoop);
    }
  }

  if (editorPlayer) {
    // timeupdate 仅更新文字标签（低频即可）
    editorPlayer.addEventListener("timeupdate", () => {
      if ($("playbackTimeLabel")) {
        $("playbackTimeLabel").textContent = formatTime(currentEditorTime());
      }
    });
    editorPlayer.addEventListener("play", () => {
      if (!state.virtualPlaying) setVirtualClock(editorPlayer.currentTime || 0, true, 1);
      if ($("editorPlayBtn")) $("editorPlayBtn").textContent = "Ⅱ";
      editorRAF = requestAnimationFrame(editorPlayheadLoop);
    });
    editorPlayer.addEventListener("pause", () => {
      if (state.realtimeStarting || state.realtimePlaying || state.realtimeSource || state.realtimeSoundTouch) {
        updateMainWavePlayhead();
        drawMiniWaveform();
        return;
      }
      if (!state.suppressEditorPauseHandler && !state.previewUsingRendered) {
        state.virtualPlaying = false;
        state.realtimePlaying = false;
      }
      if (editorRAF) { cancelAnimationFrame(editorRAF); editorRAF = null; }
      updateWavePlayhead();
      drawMiniWaveform();
      if (!state.virtualPlaying && $("editorPlayBtn")) $("editorPlayBtn").textContent = "▶";
    });
    editorPlayer.addEventListener("ended", () => {
      if (editorRAF) { cancelAnimationFrame(editorRAF); editorRAF = null; }
      updateWavePlayhead();
      drawMiniWaveform();
      if ($("editorPlayBtn")) $("editorPlayBtn").textContent = "▶";
    });
  }

  $("previewPlayer")?.addEventListener("ended", () => {
    const t = currentEditorTime();
    const params = editorRealtimeParams();
    if (state.virtualPlaying && params.active) {
      const bounds = realtimeWindowBounds(t);
      if (t < bounds.clipEnd - 0.05) {
        state.previewUsingRendered = false;
        requestRealtimePreviewWindow(true);
        return;
      }
    }
    pauseEditorPlayback();
  });

  // 更新 DOM 播放指针位置（叠加在 canvas 上方的 div）
  function updateWavePlayhead() {
    const playhead = $("wavePlayhead");
    const player = $("editorPlayer");
    const shell = $("mainWaveShell");
    if (!playhead || !player || !shell) return;
    if (!state.editorDuration) {
      playhead.style.display = "none";
      return;
    }
    const total = Math.max(0.1, state.editorDuration);
    const time = currentEditorTime();
    if (followEditorTimeInView(time)) drawWaveform();
    const ratio = time / total;

    // 考虑缩放
    const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
    const zoom = Math.max(1, state.waveformZoom);
    const visibleCount = Math.round(allPeaks.length / zoom);
    const maxStart = Math.max(0, allPeaks.length - visibleCount);
    const startIdx = Math.round(clamp(state.waveformScroll, 0, 1) * maxStart);
    const endIdx = Math.min(startIdx + visibleCount, allPeaks.length);
    const peakIdx = ratio * allPeaks.length;
    const px = ((peakIdx - startIdx) / (endIdx - startIdx)) * 100;

    if (px >= 0 && px <= 100) {
      playhead.style.display = "";
      playhead.style.left = px + "%";
    } else {
      playhead.style.display = "none";
    }
  }

  // 播放/暂停按钮
  $("editorPlayBtn")?.addEventListener("click", async () => {
    const player = $("editorPlayer");
    const preview = $("previewPlayer");
    const isPlaying = state.virtualPlaying || (player && !player.paused) || (preview && !preview.paused);
    if (state.processedPreviewBusy) {
      log("Cancelling preview render...");
      state.processedPreviewSeq += 1;
      clearTimeout(state.processedPreviewTimer);
      stopPreviewProgress("Preview render cancelled");
      state.processedPreviewBusy = false;
      setEditorPlayDisabled(false);
      try { await window.gaobai.cancelEditor?.(); } catch (_) {}
      return;
    }
    if (!isPlaying && !requireLicense("音频剪辑预览")) return;
    if (!player || !player.src) {
      const sourcePath = state.editorAudioPath || state.audioPath;
      if (!sourcePath) { log("Please choose an audio file first."); return; }
      try { await loadEditorAudio(sourcePath); } catch (err) { log("Load audio failed: " + err.message); return; }
    }
    if (!player.src) return;
    if (state.virtualPlaying || !player.paused || (preview && !preview.paused)) {
      pauseEditorPlayback();
      return;
    }
    const params = editorRealtimeParams();
    // 播放时优先从用户框选的起始位置开始：
    // - 如果当前播放头在选区内，从当前位置继续；
    // - 如果选区已设置且当前位置在选区外（在 start 之前或 end 之后），跳到 start 重新开始。
    // 这样用户拖出一个选区后点 ▶ 就直接听到选段，不用先手动拖回选区起点。
    const cur = currentEditorTime();
    const sel = getClipBounds();
    let startAt = cur;
    if (sel && Number.isFinite(sel.start) && Number.isFinite(sel.end) && sel.end > sel.start + 0.05) {
      // 选区是否覆盖整段（用户没主动选）— 通过和总时长对齐判断
      const total = Number(state.editorDuration) || 0;
      const isFullSelection = total > 0 && sel.start <= 0.05 && sel.end >= total - 0.05;
      if (!isFullSelection && (cur < sel.start - 0.02 || cur >= sel.end - 0.02)) {
        startAt = sel.start;
      }
    }
    if (params.active) {
      startRealtimePreviewFrom(startAt);
      return;
    }
    setVirtualClock(startAt, true, 1);
    player.currentTime = startAt;
    player.volume = Math.min(1, params.volume);
    await player.play();
    startRealtimePlayheadLoop();
  });

  const waveformCanvas = $("waveformCanvas");
  let waveformSeeking = false;
  let waveformWasPlaying = false; // 记录拖动前是否在播放
  let waveformPan = null;

  function waveCanvasClientToTime(clientX, bypassSnap = false) {
    const canvas = $("waveformCanvas");
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const total = Math.max(0.1, state.editorDuration);
    const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
    const zoom = Math.max(1, state.waveformZoom);
    const visibleCount = Math.round(allPeaks.length / zoom);
    const maxStart = Math.max(0, allPeaks.length - visibleCount);
    const startIdx = Math.round(clamp(state.waveformScroll, 0, 1) * maxStart);
    const clickedPeakIdx = startIdx + ratio * visibleCount;
    return snapEditorTime((clickedPeakIdx / allPeaks.length) * total, bypassSnap);
  }

  // 仅更新播放头DOM位置（不设置player.currentTime，极快）
  function setWavePlayheadToTime(time) {
    const playhead = $("wavePlayhead");
    if (!playhead || !state.editorDuration) return;
    const total = Math.max(0.1, state.editorDuration);
    const ratio = time / total;
    const allPeaks = state.waveformAllPeaks.length ? state.waveformAllPeaks : state.waveformPeaks;
    const zoom = Math.max(1, state.waveformZoom);
    const visibleCount = Math.round(allPeaks.length / zoom);
    const maxStart = Math.max(0, allPeaks.length - visibleCount);
    const startIdx = Math.round(clamp(state.waveformScroll, 0, 1) * maxStart);
    const endIdx = Math.min(startIdx + visibleCount, allPeaks.length);
    const peakIdx = ratio * allPeaks.length;
    const px = ((peakIdx - startIdx) / (endIdx - startIdx)) * 100;
    if (px >= 0 && px <= 100) {
      playhead.style.display = "";
      playhead.style.left = px + "%";
    } else {
      playhead.style.display = "none";
    }
    // 更新时间标签
    if ($("playbackTimeLabel")) {
      $("playbackTimeLabel").textContent = formatTime(time);
    }
  }

  let editorCursorDrag = null;
  let editorCursorAutoScrollRaf = null;
  const editorCursorHandle = $("editorCursor");
  const moveEditorCursorFromPointer = (event, commit = false) => {
    let time;
    if (editorCursorDrag) {
      const ratio = clamp((event.clientX - editorCursorDrag.rect.left) / Math.max(1, editorCursorDrag.rect.width), 0, 1);
      time = snapEditorTime(editorCursorDrag.viewStart + ratio * editorCursorDrag.viewDuration, event.altKey);
    } else {
      time = waveCanvasClientToTime(event.clientX, event.altKey);
    }
    state.editorCursor = time;
    updateEditorCursor(time);
    setWavePlayheadToTime(time);
    if (!commit) return;
    const player = $("editorPlayer");
    if (state.realtimePlaying || state.virtualPlaying) {
      startRealtimePreviewFrom(time);
    } else if (player) {
      player.currentTime = time;
    }
  };

  const stopEditorCursorAutoScroll = () => {
    if (editorCursorAutoScrollRaf) cancelAnimationFrame(editorCursorAutoScrollRaf);
    editorCursorAutoScrollRaf = null;
  };

  const runEditorCursorAutoScroll = (timestamp) => {
    const drag = editorCursorDrag;
    if (!drag) {
      editorCursorAutoScrollRaf = null;
      return;
    }
    const elapsed = Math.min(0.05, Math.max(0, (timestamp - (drag.lastFrame || timestamp)) / 1000));
    drag.lastFrame = timestamp;
    const edge = Math.min(44, drag.rect.width * 0.12);
    let direction = 0;
    if (drag.clientX <= drag.rect.left + edge) direction = -1;
    else if (drag.clientX >= drag.rect.right - edge) direction = 1;
    if (direction && elapsed > 0) {
      const previousStart = getWaveView().start;
      const constantSpeed = drag.viewDuration * 0.18;
      setWaveViewStart(previousStart + direction * constantSpeed * elapsed);
      const nextView = getWaveView();
      if (Math.abs(nextView.start - previousStart) > 0.0001) {
        drag.viewStart = nextView.start;
        drag.viewDuration = nextView.duration;
        moveEditorCursorFromPointer({ clientX: drag.clientX, altKey: drag.altKey });
        drawWaveform();
        setWavePlayheadToTime(state.editorCursor);
      }
    }
    editorCursorAutoScrollRaf = requestAnimationFrame(runEditorCursorAutoScroll);
  };

  editorCursorHandle?.addEventListener("pointerdown", (event) => {
    if (!state.editorDuration) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = waveformCanvas?.getBoundingClientRect();
    const view = getWaveView();
    editorCursorDrag = {
      pointerId: event.pointerId,
      rect: rect || { left: 0, right: 1, width: 1 },
      viewStart: view.start,
      viewDuration: view.duration,
      clientX: event.clientX,
      altKey: event.altKey,
      lastFrame: performance.now()
    };
    editorCursorHandle.setPointerCapture?.(event.pointerId);
    stopEditorCursorAutoScroll();
    editorCursorAutoScrollRaf = requestAnimationFrame(runEditorCursorAutoScroll);
  });
  editorCursorHandle?.addEventListener("pointermove", (event) => {
    if (!editorCursorDrag) return;
    editorCursorDrag.clientX = event.clientX;
    editorCursorDrag.altKey = event.altKey;
    moveEditorCursorFromPointer(event);
  });
  editorCursorHandle?.addEventListener("pointerup", (event) => {
    if (!editorCursorDrag) return;
    moveEditorCursorFromPointer(event, true);
    editorCursorDrag = null;
    stopEditorCursorAutoScroll();
  });
  editorCursorHandle?.addEventListener("pointercancel", () => { editorCursorDrag = null; stopEditorCursorAutoScroll(); });
  editorCursorHandle?.addEventListener("lostpointercapture", () => { editorCursorDrag = null; stopEditorCursorAutoScroll(); });

  if (waveformCanvas) {
    waveformCanvas.addEventListener("pointerdown", async (e) => {
      const player = $("editorPlayer");
      if (!player || !player.src) {
        const sourcePath = state.editorAudioPath || state.audioPath;
        if (!sourcePath) { log("请先选择音频。"); return; }
        try { await loadEditorAudio(sourcePath); } catch (err) { log("加载失败：" + err.message); return; }
      }
      if (!player.src) return;
      e.preventDefault();
      const time = waveCanvasClientToTime(e.clientX, e.altKey);
      if (state.editorTool === "select") {
        state.editorSelectionDrag = { start: time };
        waveformCanvas.setPointerCapture(e.pointerId);
        setClipBoundsFromSeconds(time, Math.min(state.editorDuration, time + 0.001));
        return;
      }
      if (state.editorTool === "cut") {
        updateEditorCursor(time);
        setWavePlayheadToTime(time);
        return;
      }
      waveformSeeking = true;
      waveformCanvas.setPointerCapture(e.pointerId);
      // 单击定位；拖过阈值后改为平移时间线，保留当前播放状态。
      waveformWasPlaying = state.realtimePlaying || !player.paused;
      waveformPan = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startViewStart: getWaveView().start,
        moved: false
      };
      updateEditorCursor(time);
      setWavePlayheadToTime(time);
    });
    waveformCanvas.addEventListener("pointermove", (e) => {
      const time = waveCanvasClientToTime(e.clientX, e.altKey);
      if (state.editorSelectionDrag) {
        setClipBoundsFromSeconds(Math.min(state.editorSelectionDrag.start, time), Math.max(state.editorSelectionDrag.start, time));
        updateEditorCursor(time);
        return;
      }
      if (!waveformSeeking) return;
      if (waveformPan) {
        const deltaX = e.clientX - waveformPan.startX;
        if (!waveformPan.moved && Math.abs(deltaX) >= 3) waveformPan.moved = true;
        if (waveformPan.moved) {
          const rect = waveformCanvas.getBoundingClientRect();
          const visibleDuration = getWaveView().duration;
          // Content follows the mouse: dragging right reveals earlier audio.
          setWaveViewStart(waveformPan.startViewStart - (deltaX / Math.max(1, rect.width)) * visibleDuration);
          drawWaveform();
          updateWavePlayhead();
          return;
        }
      }
      // 只更新DOM播放头位置，不设player.currentTime，保证丝滑
      setWavePlayheadToTime(time);
    });
    waveformCanvas.addEventListener("pointerup", (e) => {
      if (state.editorSelectionDrag) {
        state.editorSelectionDrag = null;
        drawWaveform();
        return;
      }
      if (!waveformSeeking) return;
      waveformSeeking = false;
      const panned = Boolean(waveformPan?.moved);
      waveformPan = null;
      if (panned) {
        updateWavePlayhead();
        return;
      }
      const player = $("editorPlayer");
      if (!player) return;
      const time = waveCanvasClientToTime(e.clientX, e.altKey);
      updateEditorCursor(time);
      player.currentTime = time;
      updateWavePlayhead();
      drawMiniWaveform();
      // 如果之前在播放，松开后从新位置继续播放；实时预览参数下继续走 WebAudio
      if (waveformWasPlaying) {
        const params = editorRealtimeParams();
        if (params.active) {
          startRealtimePreviewFrom(time);
        } else {
          setVirtualClock(time, true, 1);
          player.play().catch(() => {});
          startRealtimePlayheadLoop();
        }
      }
    });
    waveformCanvas.addEventListener("pointercancel", () => {
      waveformSeeking = false;
      waveformPan = null;
    });
    waveformCanvas.addEventListener("lostpointercapture", () => {
      waveformSeeking = false;
      waveformPan = null;
    });
    waveformCanvas.addEventListener("dblclick", (event) => {
      if (state.editorTool !== "cut") return;
      event.preventDefault();
      const time = waveCanvasClientToTime(event.clientX, event.altKey);
      if (splitEditorSegmentAt(time)) drawWaveform();
    });
  }

  // 缩放时波形拖拽滚动：由 canvas 的 pointermove 在缩放模式下处理
  // （已合并到 waveformCanvas 的 pointer 事件中，避免冲突）

  $("editorPlayer")?.addEventListener("pause", () => {
    if (state.realtimeStarting || state.realtimePlaying) {
      drawWaveform();
      return;
    }
    if (!state.suppressEditorPauseHandler && !state.previewUsingRendered) {
      stopRealtimePreview(true);
    }
    drawWaveform();
  });

  function editorRealtimeParams() {
    const semitones = state.pitchSemitones || 0;
    const cents = state.pitchCents || 0;
    const totalCents = semitones * 100 + cents;
    const tempo = state.tempoRatio || 1;
    const volume = clamp(Number($("volumeInput")?.value) || 1, 0, 3);
    const active = Math.abs(totalCents) >= 1 || Math.abs(tempo - 1) >= 0.001 || Math.abs(volume - 1) >= 0.001;
    return { totalCents, totalSemitones: totalCents / 100, tempo, volume, active };
  }

  function realtimeParamsKey() {
    const params = editorRealtimeParams();
    return [
      params.totalSemitones.toFixed(3),
      params.tempo.toFixed(3),
      params.volume.toFixed(3)
    ].join("|");
  }

  function realtimeWindowBounds(centerTime) {
    const bounds = getClipBounds();
    const total = state.editorDuration || 0;
    const clipStart = clamp(bounds.start || 0, 0, total);
    const clipEnd = clamp(bounds.end || total || 0, clipStart + 0.25, total || clipStart + 0.25);
    const center = clamp(centerTime || 0, clipStart, clipEnd);
    const start = Math.max(clipStart, center - 2);
    const end = Math.min(clipEnd, Math.max(center + 10, start + 3));
    return { start, end, clipStart, clipEnd };
  }

  function setPreviewVolume(target, duration = 120) {
    const preview = $("previewPlayer");
    if (!preview) return;
    if (state.previewFadeTimer) {
      clearInterval(state.previewFadeTimer);
      state.previewFadeTimer = null;
    }
    const start = Number(preview.volume) || 0;
    const begun = performance.now();
    state.previewFadeTimer = setInterval(() => {
      const ratio = clamp((performance.now() - begun) / duration, 0, 1);
      preview.volume = start + (target - start) * ratio;
      if (ratio >= 1) {
        clearInterval(state.previewFadeTimer);
        state.previewFadeTimer = null;
      }
    }, 16);
  }

  async function switchToRenderedPreview(result, paramsKey) {
    const player = $("editorPlayer");
    const preview = $("previewPlayer");
    if (!player || !preview || !result || !result.outputPath) return;
    if (paramsKey !== state.previewParamsKey) return;
    const params = editorRealtimeParams();
    const nowTime = currentEditorTime();
    const offset = clamp((nowTime - Number(result.start || 0)) / Math.max(0.001, params.tempo), 0, Math.max(0.05, Number(result.duration || 0) / Math.max(0.001, params.tempo)));
    const url = await window.gaobai.fileUrl(result.outputPath);
    stopRealtimeWebAudio();
    preview.pause();
    preview.src = `${url}${url.includes("?") ? "&" : "?"}rt=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    preview.currentTime = offset;
    preview.volume = 0;
    state.previewWindowStart = Number(result.start || 0);
    state.previewWindowEnd = Number(result.end || 0);
    state.previewUsingRendered = true;
    try { await preview.play(); } catch (_) {}
    setPreviewVolume(1, 120);
    setTimeout(() => {
      if (state.previewUsingRendered) {
        try { player.pause(); } catch (_) {}
      }
    }, 90);
    $("clipStatus").textContent = "实时试听中";
    if ($("effectSummary")) $("effectSummary").textContent = "已应用实时试听：" + (state.previewLoggedFallback ? "慢速回退" : "滚动缓冲");
  }

  async function renderRealtimePreviewWindow(seq, paramsKey, windowBounds) {
    const sourcePath = state.editorAudioPath || state.audioPath;
    if (!sourcePath || !window.gaobai.previewWindow) return;
    state.previewRenderBusy = true;
    try {
      const params = editorRealtimeParams();
      const result = await window.gaobai.previewWindow({
        sourcePath,
        start: windowBounds.start,
        end: windowBounds.end,
        fadeIn: 0,
        fadeOut: 0,
        volume: params.volume,
        pitch: state.pitchSemitones || 0,
        cents: state.pitchCents || 0,
        tempo: params.tempo,
      });
      if (seq !== state.previewRenderSeq || paramsKey !== state.previewParamsKey) return;
      if (!result || !result.ok) {
        $("clipStatus").textContent = "实时试听渲染失败";
        log((result && result.message) || "实时试听渲染失败。");
        return;
      }
      state.previewLoggedFallback = /librosa|回退/.test(String(result.log || result.stderr || ""));
      await switchToRenderedPreview(result, paramsKey);
      if (result.cached) {
        log(`实时试听使用缓存：${Number(result.start).toFixed(2)}s-${Number(result.end).toFixed(2)}s`);
      } else {
        log(`实时试听已渲染：${Number(result.start).toFixed(2)}s-${Number(result.end).toFixed(2)}s`);
      }
    } catch (err) {
      if (seq === state.previewRenderSeq) log("实时试听渲染异常：" + err.message);
    } finally {
      if (seq === state.previewRenderSeq) {
        state.previewRenderBusy = false;
        state.previewActiveRenderKey = "";
      }
    }
  }

  function requestRealtimePreviewWindow(immediate = false) {
    const player = $("editorPlayer");
    if (!player || !player.src) return false;
    const params = editorRealtimeParams();
    if (!params.active) return false;
    const paramsKey = realtimeParamsKey();
    state.previewParamsKey = paramsKey;
    const center = currentEditorTime();
    const windowBounds = realtimeWindowBounds(center);
    const renderKey = [
      paramsKey,
      windowBounds.start.toFixed(2),
      windowBounds.end.toFixed(2)
    ].join("|");
    if (!immediate && (state.previewPendingKey === renderKey || state.previewActiveRenderKey === renderKey)) {
      return true;
    }
    clearTimeout(state.previewRenderTimer);
    state.previewPendingKey = renderKey;
    const run = () => {
      const seq = ++state.previewRenderSeq;
      state.previewActiveRenderKey = renderKey;
      state.previewPendingKey = "";
      $("clipStatus").textContent = "实时试听渲染中";
      if ($("effectSummary")) $("effectSummary").textContent = "实时试听渲染中，走带继续...";
      renderRealtimePreviewWindow(seq, paramsKey, windowBounds);
    };
    if (immediate) run();
    else state.previewRenderTimer = setTimeout(run, 300);
    return true;
  }

  function maybeQueueNextRealtimeWindow(time) {
    if (!state.virtualPlaying) return;
    const params = editorRealtimeParams();
    if (!params.active) return;
    const bounds = realtimeWindowBounds(time);
    if (time >= bounds.clipEnd - 0.05) {
      pauseEditorPlayback();
      return;
    }
  }

  async function startRealtimePreviewFrom(time) {
    const player = $("editorPlayer");
    if (!player || !player.src) return false;
    const params = editorRealtimeParams();
    if (!params.active) return false;
    const startAt = clamp(time || currentEditorTime(), 0, state.editorDuration || player.duration || 0);
    setVirtualClock(startAt, true, params.tempo);
    state.realtimeStarting = true;
    state.realtimePlaying = true;
    state.previewUsingRendered = false;
    player.currentTime = startAt;
    state.suppressEditorPauseHandler = true;
    try { player.pause(); } catch (_) {}
    startRealtimeWebAudioFrom(startAt).then((ok) => {
      state.realtimeStarting = false;
      state.suppressEditorPauseHandler = false;
      if (!ok) {
        state.virtualPlaying = false;
        state.realtimePlaying = false;
        if ($("editorPlayBtn")) $("editorPlayBtn").textContent = "▶";
        $("clipStatus").textContent = "Realtime engine unavailable - no render started";
        log("Realtime preview engine unavailable. Use/export/upload still renders the selected range.");
      } else {
        applyRealtimeWebAudioParams(editorRealtimeParams());
      }
    }).catch((error) => {
      state.realtimeStarting = false;
      state.suppressEditorPauseHandler = false;
      state.virtualPlaying = false;
      state.realtimePlaying = false;
      if ($("editorPlayBtn")) $("editorPlayBtn").textContent = "▶";
      $("clipStatus").textContent = `Realtime engine failed: ${(error && error.message) || "unknown"}`;
      log("Realtime preview engine failed during playback startup: " + (error && (error.stack || error.message) || String(error)));
    });
    if ($("editorPlayBtn")) $("editorPlayBtn").textContent = "Ⅱ";
    startRealtimePlayheadLoop();
    $("clipStatus").textContent = "Realtime preview active";
    return true;
  }

  // 注意：不能用 WebAudio detune/playbackRate 做升降调实时预览。
  // detune 会同时改变音高和速度，不符合“只变调不变速”的需求。
  // 当前播放保持原音；点击“预览片段/导出/确认”时由后端 ffmpeg rubberband 正确处理。
  function applyRealtimePitchTempo() {
    const params = editorRealtimeParams();
    const player = $("editorPlayer");
    const preview = $("previewPlayer");
    const hasRealtimeGraph = Boolean(state.realtimeSource || state.realtimeSoundTouch);
    const wasPlaying = Boolean(state.virtualPlaying || state.realtimePlaying || state.realtimeStarting || hasRealtimeGraph || (player && !player.paused) || (preview && !preview.paused));
    const sourceTime = currentEditorTime();
    state.processedPreviewReadyKey = "";
    if (!params.active) {
      clearTimeout(state.processedPreviewTimer);
      setEditorPlayDisabled(false);
      if (wasPlaying) {
        stopRealtimePreview(true);
        if (player && player.src) {
          player.currentTime = clamp(sourceTime, 0, state.editorDuration || sourceTime);
          player.volume = 1;
          player.play().catch(() => {});
          setVirtualClock(sourceTime, true, 1);
          startRealtimePlayheadLoop();
        }
      } else {
        stopRealtimePreview(true);
      }
      restoreOriginalEditorPlayer().catch(() => {});
      updateEffectSummary();
      $("clipStatus").textContent = "Original audio preview";
      return;
    }
    updateEffectSummary();
    clearTimeout(state.processedPreviewTimer);
    stopPreviewProgress("");
    setEditorPlayDisabled(false);
    if (hasRealtimeGraph) {
      state.realtimePlaying = true;
      state.virtualPlaying = true;
      setVirtualClock(sourceTime, true, params.tempo);
      applyRealtimeWebAudioParams(params);
      $("clipStatus").textContent = "Realtime preview active";
      return;
    }
    if (state.realtimeStarting) {
      $("clipStatus").textContent = "Realtime preview updating...";
      return;
    }
    if (wasPlaying) {
      startRealtimePreviewFrom(sourceTime);
    } else {
      $("clipStatus").textContent = "Params ready - press play for realtime preview";
    }
  }

  ["clipStartRange", "clipEndRange"].forEach((id) => {
    $(id).addEventListener("input", () => syncClipInputs("range"));
  });
  const syncDawRangeInputs = () => {
    const selection = state.dawSelection;
    const start = clamp(parseTimeInput($("clipStartInput").value, selection?.start || 0), 0, dawProjectDuration());
    const end = clamp(parseTimeInput($("clipEndInput").value, selection?.end || Math.min(30, dawProjectDuration())), 0, dawProjectDuration());
    setDawSelection(state.dawSelectedTrackId || state.dawTracks[0]?.id, start, end, false);
    if (state.dawSelection) {
      $("clipStartInput").value = formatTime(state.dawSelection.start);
      $("clipEndInput").value = formatTime(state.dawSelection.end);
    }
  };
  ["clipStartInput", "clipEndInput"].forEach((id) => {
    $(id).addEventListener("change", syncDawRangeInputs);
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.currentTarget.blur();
        syncDawRangeInputs();
      }
    });
  });

  $("pitchInput").addEventListener("input", () => {
    state.pitchSemitones = Number($("pitchInput").value) || 0;
    saveEditorPrefs();
    log(`升降调设置为 ${state.pitchSemitones >= 0 ? "+" : ""}${state.pitchSemitones} 半音`);
    updateEffectSummary();
    applyRealtimePitchTempo();
  });

  if ($("centsInput")) {
    $("centsInput").addEventListener("input", () => {
      state.pitchCents = Number($("centsInput").value) || 0;
      saveEditorPrefs();
      log(`音分设置为 ${state.pitchCents >= 0 ? "+" : ""}${state.pitchCents} 音分`);
      updateEffectSummary();
      applyRealtimePitchTempo();
    });
  }

  $("tempoInput").addEventListener("input", () => {
    state.tempoRatio = Number($("tempoInput").value) || 1;
    setActiveTempoChip(state.tempoRatio);
    saveEditorPrefs();
    log(`变速设置为 ${state.tempoRatio.toFixed(2)}x`);
    updateEffectSummary();
    applyRealtimePitchTempo();
  });

  document.querySelectorAll(".tempo-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const value = Number(chip.dataset.tempo);
      if (Number.isFinite(value)) {
        state.tempoRatio = value;
        $("tempoInput").value = value;
        setActiveTempoChip(value);
        saveEditorPrefs();
        log(`变速设置为 ${value}x`);
        updateEffectSummary();
        applyRealtimePitchTempo();
      }
    });
  });

  updateEffectSummary();

  ["fadeInInput", "fadeOutInput"].forEach((id) => {
    $(id).addEventListener("input", () => {
      saveEditorPrefs();
      state.processedPreviewReadyKey = "";
      updateEffectSummary();
    });
  });

  $("volumeInput")?.addEventListener("input", () => {
    saveEditorPrefs();
    const player = $("editorPlayer");
    const preview = $("previewPlayer");
    const volume = clamp(Number($("volumeInput").value) || 1, 0, 2);
    if (player) player.volume = Math.min(1, volume);
    if (preview) preview.volume = Math.min(1, volume);
    updateEffectSummary();
    applyRealtimePitchTempo();
  });

  $("exportClipBtn").addEventListener("click", async () => {
    if (!requireLicense("音频剪辑导出")) return;
    if (!acquireEditorLock()) return;
    try {
    const sourcePath = state.editorAudioPath || state.audioPath;
    if (!sourcePath) {
      log("请先选择要剪辑的音频。");
      return;
    }
    if (!state.editorAudioPath) {
      try {
        await loadEditorAudio(sourcePath);
      } catch (error) {
        log(`音频剪辑读取失败：${error.message}`);
        return;
      }
    }
    $("clipStatus").textContent = "正在导出剪辑";
    const result = await window.gaobai.exportClip(buildEditorExportPayload(sourcePath));
    if (!result.ok) {
      $("clipStatus").textContent = "导出失败";
      log(result.message || "剪辑导出失败。");
      return;
    }
    state.editorOutputPath = result.outputPath;
    state.editorOutputDir = result.outputDir;
    $("clipStatus").textContent = "导出完成";
    log(`剪辑导出完成：${result.outputPath}`);
    } finally { releaseEditorLock(); }
  });

  $("useClipBtn").addEventListener("click", async () => {
    if (!requireLicense("音频剪辑")) return;
    if (!acquireEditorLock()) return;
    try {
    const sourcePath = state.editorAudioPath || state.audioPath;
    if (!sourcePath) {
      log("请先选择要剪辑的音频。");
      return;
    }
    if (!state.editorAudioPath) {
      try {
        await loadEditorAudio(sourcePath);
      } catch (error) {
        log(`音频读取失败：${error.message}`);
        return;
      }
    }

    // 保存撤回快照到栈（支持多次撤回）
    state.undoStack.push({
      audioPath: state.editorAudioPath,
      outputPath: state.editorOutputPath,
      outputDir: state.editorOutputDir,
      duration: state.editorDuration,
      waveformPeaks: state.waveformPeaks.slice(),
      waveformAllPeaks: state.waveformAllPeaks.slice(),
      clipStart: $("clipStartInput").value,
      clipEnd: $("clipEndInput").value,
      pitch: $("pitchInput").value,
      cents: $("centsInput") ? $("centsInput").value : 0,
      tempo: $("tempoInput").value,
      fadeIn: $("fadeInInput").value,
      fadeOut: $("fadeOutInput").value,
      volume: $("volumeInput").value,
      segments: state.editorSegments.map((segment) => ({ ...segment })),
      segmentMode: state.editorSegmentMode,
      dawTracks: JSON.parse(JSON.stringify(state.dawTracks)),
      dawSelectedTrackId: state.dawSelectedTrackId,
      dawSelectedClipId: state.dawSelectedClipId
    });
    state.editorUndoDomain = "clip";
    $("undoClipBtn").disabled = false;
    log(`已保存剪辑快照（可撤回 ${state.undoStack.length} 步）。`);

    // 「使用剪辑」语义：把当前选区 + 升降调/变速/淡入淡出/音量 一次性确认导出到本地，
    // 之后「上传到Suno」「剪辑后分离」直接用这一版，不再重复处理
    $("clipStatus").textContent = "正在确认剪辑";
    log("正在确认剪辑参数并导出到本地…");
    const result = await window.gaobai.exportClip(buildEditorExportPayload(sourcePath));
    if (!result.ok) {
      $("clipStatus").textContent = "确认失败";
      log(result.message || "剪辑确认失败。");
      return;
    }
    state.editorOutputPath = result.outputPath;
    state.editorOutputDir = result.outputDir;
    $("clipStatus").textContent = `已确认：${formatTime(result.duration || 0)}`;
    log(`剪辑确认完成，已默认导出到：${result.outputPath}`);

    // 同步到上传工作台
    setCurrentAudio(result.outputPath);

    // 左侧波形重新载入剪辑后的版本，此后选区 / 升降调 / 变速会被重置
    // 这样用户再点「上传到Suno」「剪辑后分离」时，处理参数都是默认值
    // exportClip 不会在导出版本上叠加二次处理
    try {
      await loadEditorAudio(result.outputPath, true);
      // Reset processing controls to defaults so subsequent actions don't re-process
      $("pitchInput").value = 0;
      $("tempoInput").value = 1;
      $("fadeInInput").value = 0;
      $("fadeOutInput").value = 0;
      $("volumeInput").value = 1;
      state.pitchSemitones = 0;
      state.tempoRatio = 1;
      setActiveTempoChip(1);
      // 这一版保留为已确认输出路径，让后续 上传/分离 跳过 exportClip
      state.editorOutputPath = result.outputPath;
      state.editorOutputDir = result.outputDir;
    } catch (error) {
      log(`波形预览刷新失败：${error.message}`);
    }
    log(`接下来可以直接点【上传到Suno】或【剪辑后分离】使用这一版。`);
    } finally { releaseEditorLock(); }
  });

  // 撤回剪辑 — 从栈中弹出上一个状态，支持多次撤回
  $("undoClipBtn")?.addEventListener("click", async () => {
    if (!state.undoStack.length) {
      log("没有可撤回的剪辑操作。");
      return;
    }
    const snap = state.undoStack.pop();
    const remaining = state.undoStack.length;
    log(`正在撤回剪辑（剩余可撤回 ${remaining} 步）…`);
    try {
      // 恢复音频路径和波形
      state.editorAudioPath = snap.audioPath;
      state.editorOutputPath = snap.outputPath;
      state.editorOutputDir = snap.outputDir;
      state.editorDuration = snap.duration;
      state.waveformPeaks = snap.waveformPeaks;
      state.waveformAllPeaks = snap.waveformAllPeaks;
      state.editorSegments = Array.isArray(snap.segments) ? snap.segments : [];
      state.editorSegmentMode = Boolean(snap.segmentMode);
      if (Array.isArray(snap.dawTracks)) {
        state.dawTracks = JSON.parse(JSON.stringify(snap.dawTracks));
        state.dawSelectedTrackId = snap.dawSelectedTrackId || state.dawTracks[0]?.id || "";
        state.dawSelectedClipId = snap.dawSelectedClipId || "";
        renderDawProject();
      }

      // 恢复音频播放器
      const url = await window.gaobai.fileUrl(snap.audioPath);
      $("editorPlayer").src = url;

      // 恢复选区
      $("clipStartInput").value = snap.clipStart;
      $("clipEndInput").value = snap.clipEnd;

      // 恢复参数
      $("pitchInput").value = snap.pitch;
      state.pitchSemitones = Number(snap.pitch) || 0;
      if ($("centsInput")) $("centsInput").value = snap.cents;
      state.pitchCents = Number(snap.cents) || 0;
      $("tempoInput").value = snap.tempo;
      state.tempoRatio = Number(snap.tempo) || 1;
      setActiveTempoChip(state.tempoRatio);
      $("fadeInInput").value = snap.fadeIn;
      $("fadeOutInput").value = snap.fadeOut;
      $("volumeInput").value = snap.volume;

      // 更新UI
      $("editorAudioName").textContent = basename(snap.audioPath);
      $("editorAudioPath").textContent = snap.audioPath;
      $("clipStatus").textContent = "已撤回剪辑";
      $("editorTotalDurationLabel").textContent = formatTime(snap.duration);
      syncClipInputs("number");
      drawWaveform();
      setCurrentAudio(snap.audioPath);

      log(remaining > 0 ? `已撤回，还可以继续撤回 ${remaining} 步。` : "已撤回到最初的状态。");
    } catch (error) {
      log(`撤回失败：${error.message}`);
    }
    // 栈空时禁用按钮
    $("undoClipBtn").disabled = state.undoStack.length === 0;
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
    if (document.querySelector(".module-page.active")?.id !== "editorPage") return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (state.editorUndoDomain === "daw" && state.dawUndoStack.length) {
      event.preventDefault();
      undoDawEdit();
      return;
    }
    const undoButton = $("undoClipBtn");
    if (!undoButton || undoButton.disabled || state.editorBusy) return;
    event.preventDefault();
    undoButton.click();
  });

  $("clipToUvrBtn").addEventListener("click", async () => {
    goToPanel("separationPage");
    if (!acquireEditorLock()) return;
    try {
    const sourcePath = state.editorAudioPath || state.audioPath;
    if (!sourcePath) {
      log("请先选择要剪辑的音频。");
      return;
    }
    if (!state.editorAudioPath) {
      try {
        await loadEditorAudio(sourcePath);
      } catch (error) {
        log(`音频读取失败：${error.message}`);
        return;
      }
    }
    const model = selectedSeparationModel();
    if (!model.installed) {
      $("separationStatus").textContent = "模型未下载";
      log("该分离模型尚未下载，请先点击下载模型。");
      return;
    }

    // 已确认的剪辑：editorAudioPath 就是已导出的剪辑文件，直接拿去分离
    let useForUvrPath = sourcePath;
    const isConfirmedClip = state.editorOutputPath
      && state.editorAudioPath === state.editorOutputPath;
    if (isConfirmedClip) {
      useForUvrPath = state.editorOutputPath;
      log("使用已确认的剪辑版本进行分离。");
    } else {
      $("clipStatus").textContent = "导出并准备分离";
      const result = await window.gaobai.exportClip(buildEditorExportPayload(sourcePath));
      if (!result.ok) {
        $("clipStatus").textContent = "导出失败";
        log(result.message || "剪辑导出失败，无法继续分离。");
        return;
      }
      state.editorOutputPath = result.outputPath;
      state.editorOutputDir = result.outputDir;
      useForUvrPath = result.outputPath;
      $("clipStatus").textContent = "已导出，启动伴奏/人声分离";
      log(`剪辑导出完成：${result.outputPath}，正在启动伴奏/人声分离。`);
    }

    state.separationAudioPath = useForUvrPath;
    state.vocalsPath = "";
    state.instrumentalPath = "";
    state.separationOutputDir = "";
    $("separationAudioName").textContent = basename(useForUvrPath);
    $("separationAudioPath").textContent = useForUvrPath;
    $("separationStatus").textContent = "准备分离";
    $("separationOutputDir").textContent = "正在创建输出目录";
    setSeparationProgress(4);
    const sepResult = await window.gaobai.startSeparation({ sourcePath: useForUvrPath, ...separationModelPayload() });
    if (!sepResult.ok) {
      $("separationStatus").textContent = "无法启动";
      log(sepResult.message || "无法启动分离任务。");
    }
    } finally { releaseEditorLock(); }
  });

  $("openClipDirBtn").addEventListener("click", async () => {
    if (!state.editorOutputDir && !state.workspacePaths.editorExportDir) await refreshWorkspacePathSettings();
    const target = state.editorOutputDir || state.workspacePaths.editorExportDir;
    if (!target) return log("还没有可打开的音频导出目录。");
    await window.gaobai.openPath(target);
  });

  $("clipToSunoBtn").addEventListener("click", async () => {
    if (!requireLicense("上传 Suno")) return;
    if (!acquireEditorLock()) return;
    try {
    if (state.busy) {
      log("已有任务正在运行，请等当前任务结束后再上传。");
      return;
    }
    const sourcePath = state.editorAudioPath || state.audioPath;
    if (!sourcePath) {
      log("请先选择要上传的音频。");
      return;
    }
    if (!state.editorAudioPath) {
      try {
        await loadEditorAudio(sourcePath);
      } catch (error) {
        log(`音频读取失败：${error.message}`);
        return;
      }
    }

    // 优先使用「已确认的剪辑」版本：如果当前 editorAudioPath 等于上一次确认导出的路径，
    // 说明用户已经点过【使用剪辑】，此版无需再做选区+处理
    const isConfirmedClip = state.editorOutputPath
      && state.editorAudioPath === state.editorOutputPath;

    // Detect whether any non-default processing is active
    const bounds = getClipBounds();
    const fullDuration = state.editorDuration || 0;
    const fadeIn = Number($("fadeInInput").value) || 0;
    const fadeOut = Number($("fadeOutInput").value) || 0;
    const volume = Number($("volumeInput").value);
    const pitch = Number($("pitchInput").value) || 0;
    const tempo = Number($("tempoInput").value) || 1;
    const isFullSelection = fullDuration > 0
      && Math.abs(bounds.start) < 0.05
      && Math.abs(bounds.end - fullDuration) < 0.05;
    const hasProcessing = !isConfirmedClip && (state.editorSegmentMode || !isFullSelection
      || fadeIn > 0.001 || fadeOut > 0.001
      || (Number.isFinite(volume) && Math.abs(volume - 1) > 0.001)
      || Math.abs(pitch) > 0.001
      || Math.abs(tempo - 1) > 0.001);

    const defaultTitle = (basename(sourcePath) || "上传").replace(/\.[^.]+$/, "");
    const userInput = window.prompt("请输入上传到 Suno 的歌曲标题", defaultTitle);
    if (userInput === null) {
      log("已取消上传到 Suno。");
      return;
    }
    const finalTitle = userInput.trim() || defaultTitle;

    let uploadPath = sourcePath;
    if (isConfirmedClip) {
      uploadPath = state.editorOutputPath;
      log("使用已确认的剪辑版本上传到 Suno。");
    } else if (hasProcessing) {
      $("clipStatus").textContent = "正在导出剪辑准备上传";
      log("正在导出剪辑后再上传到 Suno…");
      const result = await window.gaobai.exportClip(buildEditorExportPayload(sourcePath));
      if (!result.ok) {
        $("clipStatus").textContent = "导出失败";
        log(result.message || "剪辑导出失败，已取消上传。");
        return;
      }
      state.editorOutputPath = result.outputPath;
      state.editorOutputDir = result.outputDir;
      uploadPath = result.outputPath;
      $("clipStatus").textContent = "导出完成，开始上传";
      log(`剪辑导出完成：${result.outputPath}`);
    } else {
      log("当前选区为完整音频且无处理参数，直接上传源文件。");
    }

    setCurrentAudio(uploadPath);
    $("titleInput").value = finalTitle;
    log(`已加载到上传工作台，开始上传到 Suno：${finalTitle}`);
    // 走一键上传：startBtn 若仍为 disabled（busy 或 license 失效）会给出明确提示
    await sendToSunoAndUpload(uploadPath, {
      title: finalTitle,
      switchPanel: false, // 用户在剪辑页操作，不强制切走，保留剪辑上下文
      logTag: ""
    });
    } finally { releaseEditorLock(); }
  });

  $("pickSeparationBtn").addEventListener("click", async () => {
    const file = await window.gaobai.pickAudio();
    if (!file) return;
    state.separationAudioPath = file;
    $("separationAudioName").textContent = basename(file);
    $("separationAudioPath").textContent = file;
  });

  // 分离拖拽区域：点击选择 + 拖拽音频
  $("separationModelSelect")?.addEventListener("change", () => {
    state.selectedSeparationModel = $("separationModelSelect").value || "4_HP-Vocal-UVR.pth";
    updateSeparationModelUi();
  });

  document.querySelectorAll("[data-separation-device]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.separationDevice || "auto";
      if (!["auto", "cuda", "cpu"].includes(mode)) return;
      state.separationDeviceMode = mode;
      localStorage.setItem(SEPARATION_DEVICE_STORAGE_KEY, mode);
      renderSeparationDeviceUi();
    });
  });

  $("installSeparationGpuBtn")?.addEventListener("click", async () => {
    const button = $("installSeparationGpuBtn");
    button.disabled = true;
    button.textContent = "正在下载安装...";
    try {
      const result = await window.gaobai.installSeparationGpuRuntime();
      if (result?.ok) {
        log(`GPU加速组件安装完成：${result.gpuName || "NVIDIA CUDA"}`);
        await refreshSeparationDevices();
      } else if (!result?.cancelled) {
        log(result?.message || "GPU加速组件安装失败。" );
      }
    } catch (error) {
      log(`GPU加速组件安装失败：${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = "安装 GPU 组件";
    }
  });

  $("downloadSeparationModelBtn")?.addEventListener("click", async () => {
    const model = selectedSeparationModel();
    if (!model || model.installed || model.builtIn) return;
    $("downloadSeparationModelBtn").disabled = true;
    $("separationModelStatus").textContent = "准备下载模型...";
    setSeparationProgress(4);
    try {
      const result = await window.gaobai.downloadSeparationModel({ filename: model.filename });
      if (result?.ok) {
        await refreshSeparationModels();
      } else {
        log(result?.message || "模型下载失败。");
      }
    } catch (error) {
      log(`模型下载失败：${error.message || error}`);
    } finally {
      updateSeparationModelUi();
      setSeparationProgress(0);
    }
  });

  const separationDrop = $("separationDropArea");
  if (separationDrop) {
    separationDrop.addEventListener("click", async () => {
      const file = await window.gaobai.pickAudio();
      if (!file) return;
      state.separationAudioPath = file;
      $("separationAudioName").textContent = basename(file);
      $("separationAudioPath").textContent = file;
    });
    separationDrop.addEventListener("dragover", (e) => { e.preventDefault(); separationDrop.classList.add("dragover"); });
    separationDrop.addEventListener("dragleave", () => separationDrop.classList.remove("dragover"));
    separationDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      separationDrop.classList.remove("dragover");
      const files = Array.from(e.dataTransfer?.files || []);
      const audioFile = files.find(f => OPEN_AUDIO_PATTERN.test(f.name));
      if (audioFile) {
        const ap = window.getPathForFile(audioFile);
        if (ap) {
          state.separationAudioPath = ap;
          $("separationAudioName").textContent = basename(ap);
          $("separationAudioPath").textContent = ap;
          log(`分离区已载入：${basename(ap)}`);
        } else {
          log("请拖入 mp3、wav、m4a、flac、ogg、ape、wma 等开放音频文件到分离区");
        }
      } else {
        log("请拖入 mp3、wav、m4a、flac 等音频文件");
      }
    });
  }

  $("startSeparationBtn").addEventListener("click", async () => {
    const sourcePath = state.separationAudioPath || state.audioPath;
    if (!sourcePath) {
      log("请先选择需要分离的音频。");
      return;
    }
    const model = selectedSeparationModel();
    if (!model.installed) {
      $("separationStatus").textContent = "模型未下载";
      log("该分离模型尚未下载，请先点击下载模型。");
      return;
    }
    state.vocalsPath = "";
    state.instrumentalPath = "";
    state.separationOutputDir = "";
    $("separationStatus").textContent = "准备分离";
    $("separationOutputDir").textContent = "正在创建输出目录";
    setSeparationProgress(4);
    const result = await window.gaobai.startSeparation({ sourcePath, ...separationModelPayload() });
    if (!result.ok) {
      $("separationStatus").textContent = "无法启动";
      log(result.message || "无法启动分离任务。");
    }
  });

  $("cancelSeparationBtn").addEventListener("click", async () => {
    await window.gaobai.cancelSeparation();
  });

  $("useInstrumentalBtn").addEventListener("click", async () => {
    if (!requireLicense("上传 Suno")) return;
    if (!state.instrumentalPath) {
      log("还没有可使用的伴奏文件。");
      return;
    }
    await sendToSunoAndUpload(state.instrumentalPath, {
      title: basename(state.instrumentalPath).replace(/\.[^.]+$/, ""),
      logTag: "已把伴奏设置为当前上传音频，开始上传到 Suno。"
    });
  });

  $("useVocalsBtn").addEventListener("click", async () => {
    if (!requireLicense("上传 Suno")) return;
    if (!state.vocalsPath) {
      log("还没有可使用的人声文件。");
      return;
    }
    await sendToSunoAndUpload(state.vocalsPath, {
      title: basename(state.vocalsPath).replace(/\.[^.]+$/, ""),
      logTag: "已把人声设置为当前上传音频，开始上传到 Suno。"
    });
  });

  $("openSeparationDirBtn").addEventListener("click", async () => {
    if (!state.separationOutputDir) {
      log("还没有分离输出目录。");
      return;
    }
    await window.gaobai.openPath(state.separationOutputDir);
  });

  $("instrumentalPlayBtn")?.addEventListener("click", () => playStem("instrumental"));
  $("instrumentalListenBtn")?.addEventListener("click", () => playStem("instrumental"));
  $("instrumentalExportBtn")?.addEventListener("click", () => exportStem("instrumental"));
  $("instrumentalMoreBtn")?.addEventListener("click", () => openStemLocation("instrumental"));
  $("vocalsPlayBtn")?.addEventListener("click", () => playStem("vocals"));
  $("vocalsListenBtn")?.addEventListener("click", () => playStem("vocals"));
  $("vocalsExportBtn")?.addEventListener("click", () => exportStem("vocals"));
  $("vocalsMoreBtn")?.addEventListener("click", () => openStemLocation("vocals"));
  $("instrumentalVolume")?.addEventListener("input", () => {
    if (state.stemAudio && state.stemAudioKind === "instrumental") state.stemAudio.volume = Number($("instrumentalVolume").value || 0.75);
  });
  $("vocalsVolume")?.addEventListener("input", () => {
    if (state.stemAudio && state.stemAudioKind === "vocals") state.stemAudio.volume = Number($("vocalsVolume").value || 0.75);
  });

  // stem 波形点击/拖动定位播放位置
  ["instrumental", "vocals"].forEach((kind) => {
    const canvas = $(kind === "vocals" ? "vocalsWaveCanvas" : "instrumentalWaveCanvas");
    let stemSeeking = false;
    let stemWasPlaying = false;

    function stemCanvasClientToTime(clientX) {
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      const duration = state.stemDuration[kind] || 1;
      return clamp(ratio * duration, 0, duration);
    }

    // 仅更新stem播放头DOM位置（不设currentTime，极快）
    function setStemPlayheadToTime(time) {
      const playhead = $(kind === "vocals" ? "vocalsPlayhead" : "instrumentalPlayhead");
      if (!playhead) return;
      const duration = state.stemDuration[kind] || 1;
      const pct = (time / duration) * 100;
      if (pct >= 0 && pct <= 100) {
        playhead.style.display = "";
        playhead.style.left = pct + "%";
      } else {
        playhead.style.display = "none";
      }
    }

    if (canvas) {
      canvas.addEventListener("pointerdown", async (e) => {
        if (!state.stemAudio || state.stemAudioKind !== kind) {
          await playStem(kind);
          if (!state.stemAudio || state.stemAudioKind !== kind) return;
        }
        e.preventDefault();
        stemSeeking = true;
        canvas.setPointerCapture(e.pointerId);
        stemWasPlaying = state.stemAudio && !state.stemAudio.paused;
        if (state.stemAudio && !state.stemAudio.paused) state.stemAudio.pause();
        const time = stemCanvasClientToTime(e.clientX);
        setStemPlayheadToTime(time);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!stemSeeking || !state.stemAudio || state.stemAudioKind !== kind) return;
        const time = stemCanvasClientToTime(e.clientX);
        setStemPlayheadToTime(time);
      });
      canvas.addEventListener("pointerup", (e) => {
        if (!stemSeeking) return;
        stemSeeking = false;
        if (!state.stemAudio || state.stemAudioKind !== kind) return;
        const time = stemCanvasClientToTime(e.clientX);
        state.stemAudio.currentTime = time;
        updateStemPlayhead(kind);
        if (stemWasPlaying) {
          state.stemAudio.play();
        }
      });
    }
  });
});
/* eslint-disable */
/* ----- 音频解密模块（增量集成） ----- */
const unlockerState = {
  files: [],
  outputDir: "",
  busy: false,
  total: 0,
  lastOutputDir: "",
  lastOutputFiles: [],
  mmkvPath: "",
  compactLog: false,
  metrics: { total: 0, completed: 0, waiting: 0, success: 0, failure: 0, startedAt: 0, ended: false },
};

function unlockerBaseName(filePath) {
  if (!filePath) return "";
  return filePath.split(/[\\/]/).pop();
}

function unlockerLog(message, level) {
  if (unlockerState.compactLog && level !== "error" && level !== "warn") {
    return;
  }
  const panel = document.getElementById("unlockerLog");
  if (!panel) return;
  const row = document.createElement("div");
  row.className = "log-line log-" + (level || "info");
  const time = new Date().toLocaleTimeString();
  row.textContent = "[" + time + "] " + message;
  panel.appendChild(row);
  panel.scrollTop = panel.scrollHeight;
}

function unlockerResetMetrics(total = 0) {
  const safeTotal = Math.max(0, Number(total) || 0);
  unlockerState.compactLog = true;
  unlockerState.metrics = {
    total: safeTotal,
    completed: 0,
    waiting: safeTotal,
    success: 0,
    failure: 0,
    startedAt: Date.now(),
    ended: false,
  };
  unlockerRenderMetrics();
}

function unlockerUpdateMetrics(next = {}) {
  const metrics = { ...unlockerState.metrics, ...next };
  const total = Math.max(0, Number(metrics.total) || 0);
  const success = Math.max(0, Number(metrics.success) || 0);
  const failure = Math.max(0, Number(metrics.failure) || 0);
  const completed = Math.max(0, Math.min(total, Number(metrics.completed) || success + failure));
  metrics.total = total;
  metrics.success = success;
  metrics.failure = failure;
  metrics.completed = completed;
  metrics.waiting = Math.max(0, total - completed);
  unlockerState.metrics = metrics;
  unlockerRenderMetrics();
}

function unlockerRenderMetrics() {
  const panel = document.getElementById("unlockerLog");
  if (!panel) return;
  const m = unlockerState.metrics || {};
  const elapsed = m.startedAt ? Math.max(0, (Date.now() - m.startedAt) / 1000) : 0;
  panel.innerHTML = "";
  [
    `正在转换格式　完成:${m.completed || 0}　等待${m.waiting || 0}`,
    `完成格式转换　成功${m.success || 0}/失败${m.failure || 0}`,
    `转换格式已结束　总用时：${m.ended ? formatCompactDuration(elapsed) : "--"}`
  ].forEach((text, index) => {
    const row = document.createElement("div");
    row.className = "log-line converter-metric-line" + (index === 2 && m.ended ? " log-success" : "");
    row.textContent = text;
    panel.appendChild(row);
  });
}

function unlockerSetProgress(value) {
  const bar = document.getElementById("unlockerProgress");
  if (bar) bar.style.width = Math.max(0, Math.min(100, value)) + "%";
}

function unlockerRefreshFileList() {
  const list = document.getElementById("unlockerFileList");
  const summary = document.getElementById("unlockerFilesSummary");
  if (!list || !summary) return;
  list.innerHTML = "";
  if (unlockerState.files.length === 0) {
    summary.textContent = "尚未选择";
  } else {
    summary.textContent = "共 " + unlockerState.files.length + " 个文件";
  }
  unlockerState.files.forEach((file, idx) => {
    const row = document.createElement("div");
    row.className = "unlocker-file-row";
    const name = document.createElement("span");
    name.className = "unlocker-file-name";
    name.textContent = unlockerBaseName(file);
    name.title = file;
    const remove = document.createElement("button");
    remove.className = "unlocker-file-remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      unlockerState.files.splice(idx, 1);
      unlockerRefreshFileList();
    });
    row.appendChild(name);
    row.appendChild(remove);
    list.appendChild(row);
  });
}

function unlockerAddFiles(paths) {
  let added = 0;
  for (const raw of paths || []) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (!UNLOCKER_SUPPORTED_EXTS.some((ext) => lower.endsWith(ext))) continue;
    if (unlockerState.files.includes(raw)) continue;
    unlockerState.files.push(raw);
    added += 1;
  }
  if (added > 0) unlockerRefreshFileList();
  return added;
}

function unlockerSetBusy(busy) {
  unlockerState.busy = busy;
  const startBtn = document.getElementById("unlockerStartBtn");
  const cancelBtn = document.getElementById("unlockerCancelBtn");
  if (startBtn) startBtn.disabled = busy;
  if (cancelBtn) cancelBtn.disabled = !busy;
}

function unlockerSelectableOutputs() {
  const fromResult = (unlockerState.lastOutputFiles || []).filter((file) => OPEN_AUDIO_PATTERN.test(file));
  if (fromResult.length > 0) return fromResult;

  // 兜底：如果 result 事件没有正确带回 items，就从输出目录里扫描最近生成的开放音频。
  // 这样“进入剪辑 / 上传”按钮不会因为 lastOutputFiles 为空而无反应。
  const dir = unlockerState.lastOutputDir || unlockerState.outputDir;
  if (!dir) return [];
  const candidates = [];
  try {
    // 浏览器端不能直接读目录，所以只兜底使用当前文件列表推断同名输出文件。
    const targetFormat = document.getElementById("unlockerFormat")?.value || "original";
    const guessExts = targetFormat && targetFormat !== "original"
      ? [`.${targetFormat}`]
      : [".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus"];
    for (const src of unlockerState.files || []) {
      const base = unlockerBaseName(src).replace(/\.[^.]+$/, "");
      for (const ext of guessExts) {
        candidates.push(dir.replace(/[\\/]$/, "") + "\\" + base + ext);
      }
    }
  } catch (_) {}
  return candidates.filter((file) => OPEN_AUDIO_PATTERN.test(file));
}

function unlockerShowOutputPicker(files, actionName) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "99999";
    overlay.style.background = "rgba(5, 10, 20, 0.46)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const box = document.createElement("div");
    box.style.width = "min(560px, 92vw)";
    box.style.maxHeight = "80vh";
    box.style.overflow = "auto";
    box.style.background = "rgba(15, 23, 42, 0.88)";
    box.style.backdropFilter = "blur(18px) saturate(130%)";
    box.style.webkitBackdropFilter = "blur(18px) saturate(130%)";
    box.style.border = "1px solid rgba(226, 232, 240, .24)";
    box.style.borderRadius = "18px";
    box.style.boxShadow = "0 24px 80px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.10)";
    box.style.padding = "20px";
    box.style.color = "#e5e7eb";

    const title = document.createElement("h3");
    title.textContent = `请选择要${actionName}的音频`;
    title.style.margin = "0 0 8px";
    title.style.fontSize = "20px";
    box.appendChild(title);

    const tip = document.createElement("p");
    tip.textContent = `共 ${files.length} 个转换结果，点击其中一首继续。`;
    tip.style.margin = "0 0 16px";
    tip.style.color = "#94a3b8";
    tip.style.fontSize = "13px";
    box.appendChild(tip);

    const list = document.createElement("div");
    list.style.display = "grid";
    list.style.gap = "10px";
    files.forEach((file, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${index + 1}. ${unlockerBaseName(file)}`;
      btn.style.textAlign = "left";
      btn.style.width = "100%";
      btn.style.padding = "12px 14px";
      btn.style.borderRadius = "12px";
      btn.style.border = "1px solid rgba(148, 163, 184, .25)";
      btn.style.background = "rgba(30, 41, 59, .72)";
      btn.style.backdropFilter = "blur(10px)";
      btn.style.webkitBackdropFilter = "blur(10px)";
      btn.style.color = "#f8fafc";
      btn.style.cursor = "pointer";
      btn.style.fontSize = "14px";
      btn.addEventListener("click", () => {
        overlay.remove();
        resolve(file);
      });
      list.appendChild(btn);
    });
    box.appendChild(list);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "flex-end";
    row.style.marginTop = "16px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.style.padding = "10px 16px";
    cancel.style.borderRadius = "999px";
    cancel.style.border = "1px solid rgba(148, 163, 184, .35)";
    cancel.style.background = "transparent";
    cancel.style.color = "#cbd5e1";
    cancel.style.cursor = "pointer";
    cancel.addEventListener("click", () => { overlay.remove(); resolve(""); });
    row.appendChild(cancel);
    box.appendChild(row);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) { overlay.remove(); resolve(""); }
    });
    document.addEventListener("keydown", function onKey(event) {
      if (event.key === "Escape" && document.body.contains(overlay)) {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve("");
      }
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function unlockerPickOutputForAction(actionName) {
  unlockerLog(`正在选择要${actionName}的转换结果…`, "info");
  const files = unlockerSelectableOutputs();
  unlockerLog(`当前可用结果数量：${files.length}`, "info");
  if (files.length === 0) {
    unlockerLog("还没有可用的开放音频结果。请确认转换已成功，或点击“打开输出文件夹”手动查看。", "warn");
    return "";
  }
  if (files.length === 1) return files[0];
  const selected = await unlockerShowOutputPicker(files, actionName);
  if (!selected) unlockerLog("已取消选择。", "warn");
  return selected;
}

function unlockerInit() {
  if (!window.unlocker) return;
  if (!document.getElementById("unlockerStartBtn")) return;

  const qualityInput = document.getElementById("unlockerQuality");
  const qualityValue = document.getElementById("unlockerQualityValue");
  qualityInput.addEventListener("input", () => {
    qualityValue.textContent = qualityInput.value;
  });

  document.getElementById("unlockerPickFilesBtn").addEventListener("click", async () => {
    if (!requireLicense("音频格式转换/解锁")) return;
    const files = await window.unlocker.pickFiles();
    if (files && files.length) {
      const added = unlockerAddFiles(files);
      unlockerLog("已添加 " + added + " 个文件");
    }
  });

  // 选择目录：递归扫描目录里的音频文件
  const pickFolderBtn = document.getElementById("unlockerPickFolderBtn");
  if (pickFolderBtn) {
    pickFolderBtn.addEventListener("click", async () => {
      unlockerLog("[DEBUG] pickFolderBtn 点击事件触发");
      const licenseOk = requireLicense("音频格式转换/解锁");
      unlockerLog(`[DEBUG] license 状态: ${licenseOk}, window.unlocker=${!!window.unlocker}, pickFolder=${!!(window.unlocker && window.unlocker.pickFolder)}`);
      if (!licenseOk) return;
      try {
        const dir = await window.unlocker.pickFolder();
        unlockerLog(`[DEBUG] pickFolder 返回: ${dir || "(空)"}`);
        if (!dir) return;
        unlockerLog("正在扫描目录: " + dir);
        const files = await window.unlocker.scanFolder(dir);
        unlockerLog(`[DEBUG] scanFolder 返回 ${files ? files.length : "null"} 个`);
        if (files && files.length) {
          const added = unlockerAddFiles(files);
          unlockerLog(`目录扫描完成:找到 ${files.length} 个音频,添加 ${added} 个`);
        } else {
          unlockerLog("该目录下未识别到受支持的音频格式", "warn");
        }
      } catch (e) {
        unlockerLog("[DEBUG] pickFolder 异常: " + (e.message || e), "error");
      }
    });
  }

  document.getElementById("unlockerClearBtn").addEventListener("click", () => {
    unlockerState.files = [];
    unlockerRefreshFileList();
  });

  document.getElementById("unlockerPickOutputBtn").addEventListener("click", async () => {
    if (!requireLicense("音频格式转换/解锁")) return;
    const dir = await window.unlocker.pickOutputDir();
    if (dir) {
      unlockerState.outputDir = dir;
      document.getElementById("unlockerOutputDirLabel").textContent = dir;
    }
  });

  document.getElementById("unlockerOpenOutputBtn").addEventListener("click", async () => {
    if (!unlockerState.outputDir) {
      unlockerLog("尚未选择输出目录", "warn");
      return;
    }
    await window.gaobai.openPath(unlockerState.outputDir);
  });

  document.getElementById("unlockerUseClipBtn").addEventListener("click", async () => {
    if (!requireLicense("音频剪辑")) return;
    const selectedFile = await unlockerPickOutputForAction("进入剪辑");
    if (!selectedFile) return;
    state.editorAudioPath = selectedFile;
    loadEditorAudio(selectedFile).then(() => {
      goToPanel("editorPage");
      unlockerLog("已将处理结果载入音频剪辑器：" + unlockerBaseName(selectedFile));
    }).catch((err) => {
      unlockerLog("载入剪辑器失败：" + err.message, "error");
    });
  });

  document.getElementById("unlockerUseUploadBtn")?.addEventListener("click", async () => {
    if (!requireLicense("上传 Suno")) return;
    const selectedFile = await unlockerPickOutputForAction("上传");
    if (!selectedFile) return;
    unlockerLog("已将处理结果设置为上传音频：" + unlockerBaseName(selectedFile));
    await sendToSunoAndUpload(selectedFile, {
      title: unlockerBaseName(selectedFile).replace(/\.[^.]+$/, ""),
      logTag: `开始上传到 Suno：${unlockerBaseName(selectedFile)}`
    });
  });

  const drop = document.getElementById("unlockerDropArea");
  if (drop) {
    // 点击拖拽区域 → 弹出文件选择
    drop.addEventListener("click", async () => {
      if (!requireLicense("音频格式转换/解锁")) return;
      const files = await window.unlocker.pickFiles();
      if (files && files.length) {
        const added = unlockerAddFiles(files);
        unlockerLog("已添加 " + added + " 个文件");
      }
    });
    drop.style.cursor = "pointer";
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", async (event) => {
      event.preventDefault();
      drop.classList.remove("dragover");
      if (!requireLicense("音频格式转换/解锁")) return;
      // 同时取 files 和 items,items 用于识别目录
      const files = Array.from(event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : []);
      const items = Array.from(event.dataTransfer && event.dataTransfer.items ? event.dataTransfer.items : []);
      const filePaths = [];
      const dirPaths = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const p = window.getPathForFile(f) || (f.name && items[i] && items[i].webkitGetAsEntry && items[i].webkitGetAsEntry().isFile ? "" : "");
        if (p) filePaths.push(p);
      }
      // 目录识别:遍历 items,找 isDirectory 的 entry
      const entries = items.map((it) => {
        try { return it.webkitGetAsEntry && it.webkitGetAsEntry(); } catch (_) { return null; }
      });
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e && e.isDirectory) {
          // Electron 中,directory entry 没有 path,我们用同名 file 的 path(可能为空)
          // 退而求其次:用 items[i].getAsFile().path(Electron 31 通常会有)
          const dummyFile = items[i].getAsFile && items[i].getAsFile();
          const dp = dummyFile && window.getPathForFile(dummyFile);
          if (dp) dirPaths.push(dp);
        }
      }
      let added = 0;
      if (filePaths.length) {
        added += unlockerAddFiles(filePaths);
      }
      // 对每个目录调主进程 scanFolder
      for (const dir of dirPaths) {
        unlockerLog("正在扫描目录: " + dir);
        const scanned = await window.unlocker.scanFolder(dir);
        if (scanned && scanned.length) {
          added += unlockerAddFiles(scanned);
          unlockerLog(`目录扫描完成:找到 ${scanned.length} 个`);
        } else {
          unlockerLog("该目录下未识别到受支持的音频格式", "warn");
        }
      }
      if (added > 0) {
        unlockerLog("已通过拖拽添加 " + added + " 个文件");
      } else if (filePaths.length === 0 && dirPaths.length === 0) {
        // 没识别到路径,可能是浏览器内文件
        unlockerLog("拖拽未识别到加密音频文件,请尝试用「选择文件」或「选择目录」按钮", "warn");
      }
    });
  }

  // MMKV 路径选择 / 清除 (用于 QQ 音乐 v18/v19 .mgg/.mflac 解锁)
  if (document.getElementById("unlockerPickMmkvBtn")) {
    document.getElementById("unlockerPickMmkvBtn").addEventListener("click", async () => {
      if (!requireLicense("音频格式转换/解锁")) return;
      try {
        const path = await window.unlocker.pickMmkv();
        if (path) {
          unlockerState.mmkvPath = path;
          document.getElementById("unlockerMmkvPathLabel").textContent = path;
          unlockerLog("已设置 MMKV 数据库路径。");
        }
      } catch (e) {
        unlockerLog("选择 MMKV 路径失败: " + e, "error");
      }
    });
  }
  if (document.getElementById("unlockerClearMmkvBtn")) {
    document.getElementById("unlockerClearMmkvBtn").addEventListener("click", async () => {
      unlockerState.mmkvPath = "";
      document.getElementById("unlockerMmkvPathLabel").textContent = "未指定（可选）";
      unlockerLog("已清空 MMKV 数据库路径。");
    });
  }

  document.getElementById("unlockerStartBtn").addEventListener("click", async () => {
      if (!requireLicense("音频格式转换/解锁")) return;
	    if (unlockerState.busy) return;
	    if (unlockerState.files.length === 0) {
	      unlockerLog("请先选择待解密文件", "warn");
	      return;
	    }
	    if (!unlockerState.outputDir) {
	      unlockerLog("请先选择输出目录", "warn");
	      return;
	    }

	    const format = document.getElementById("unlockerFormat").value;
	    const quality = Number(document.getElementById("unlockerQuality").value || 2);

	    document.getElementById("unlockerStatus").textContent = "正在启动…";
	    document.getElementById("unlockerSummary").textContent = "准备中";
	    unlockerResetMetrics(unlockerState.files.length);
	    unlockerSetProgress(2);
	    unlockerSetBusy(true);

		    const protectedFiles = unlockerState.files.filter((file) => PROTECTED_DIAGNOSTIC_EXTS.has(unlockerExtension(file)));
		    if (protectedFiles.length > 0) {
		      unlockerLog(`已识别 ${protectedFiles.length} 个平台保护格式文件，将按对应平台解密流程处理。`, "info");
		      unlockerLog("QQ音乐 v20+ 的 .mgg/.mflac 需要保持 QQ音乐客户端正在运行，并至少播放过对应歌曲。", "info");
		    }

		    const mmkvKeyEl = document.getElementById("unlockerMmkvKey");
		    const result = await window.unlocker.umStart({
		      files: unlockerState.files,
		      outputDir: unlockerState.outputDir,
		      format: format,
		      quality: quality,
		      mmkvPath: unlockerState.mmkvPath || "",
		      mmkvKey: (mmkvKeyEl && mmkvKeyEl.value) ? mmkvKeyEl.value.trim() : "",
		    });
	    if (!result || !result.ok) {
	      unlockerState.compactLog = false;
	      unlockerLog(result && result.message ? result.message : "无法启动格式转换任务", "error");
	      unlockerSetBusy(false);
	      document.getElementById("unlockerStatus").textContent = "启动失败";
	    }
	  });

  document.getElementById("unlockerCancelBtn").addEventListener("click", async () => {
    await window.unlocker.cancel();
  });

  window.unlocker.onEvent((event) => {
    if (!event || !event.type) return;
    switch (event.type) {
      case "status": {
        const stage = event.stage || "";
        if (stage === "prepare") {
          unlockerState.total = Number(event.total || 0);
          if (unlockerState.total > 0) unlockerUpdateMetrics({ total: unlockerState.total });
          document.getElementById("unlockerStatus").textContent = "共 " + unlockerState.total + " 个文件";
          unlockerSetProgress(5);
        } else if (stage === "loading_mask") {
          document.getElementById("unlockerStatus").textContent = "加载 mask 中";
          unlockerSetProgress(10);
        } else if (stage === "processing") {
          const idx = Number(event.index || 0);
          const total = Number(event.total || unlockerState.total || 1);
          unlockerUpdateMetrics({ total, completed: Math.max(0, idx - 1) });
          const pct = Math.max(15, Math.min(95, Math.round((idx - 1) / total * 80) + 15));
          unlockerSetProgress(pct);
          document.getElementById("unlockerStatus").textContent = "处理中 [" + idx + "/" + total + "]";
          if (event.current) {
            document.getElementById("unlockerSummary").textContent = unlockerBaseName(event.current);
          }
        } else if (stage === "finished") {
          unlockerSetProgress(100);
          unlockerSetBusy(false);
          unlockerUpdateMetrics({
            total: Number(event.total || unlockerState.metrics.total || 0),
            completed: Number(event.total || unlockerState.metrics.total || 0),
            success: Number(event.success || 0),
            failure: Number(event.failure || 0),
            ended: true,
          });
          document.getElementById("unlockerStatus").textContent =
            "完成：成功 " + (event.success || 0) + " / 失败 " + (event.failure || 0);
          document.getElementById("unlockerSummary").textContent = event.message || "完成";
        } else if (stage === "empty") {
          document.getElementById("unlockerStatus").textContent = event.message || "无可处理文件";
          unlockerSetProgress(100);
          unlockerSetBusy(false);
        } else if (stage === "cancelled") {
          document.getElementById("unlockerStatus").textContent = "已取消";
        }
        if (event.message) unlockerLog(event.message);
        break;
      }
      case "log": {
        unlockerLog(event.message || "", event.level || "info");
        break;
      }
      case "result": {
        unlockerUpdateMetrics({
          total: Number(event.total || unlockerState.metrics.total || 0),
          completed: Number(event.total || unlockerState.metrics.total || 0),
          success: Number(event.success || 0),
          failure: Number(event.failure || 0),
          ended: true,
        });
        document.getElementById("unlockerSummary").textContent =
          "成功 " + (event.success || 0) + " / 失败 " + (event.failure || 0) + " / 共 " + (event.total || 0);
        if (event.output_dir) unlockerState.lastOutputDir = event.output_dir;
        const items = Array.isArray(event.items) ? event.items : [];
        unlockerState.lastOutputFiles = items
          .filter(item => item.success && item.output)
          .map(item => item.output);
        unlockerSetBusy(false);
        playTaskSound(Number(event.failure || 0) > 0 ? "failure" : "success");
        break;
      }
      case "done": {
        unlockerSetBusy(false);
        unlockerUpdateMetrics({ ended: true });
        document.getElementById("unlockerStatus").textContent = "转换格式已结束";
        break;
      }
      case "failed": {
        unlockerSetBusy(false);
        unlockerUpdateMetrics({ ended: true });
        playTaskSound("failure");
        if (event.message) {
          unlockerLog("解密任务失败：" + event.message, "error");
        } else if (event.code !== undefined && event.code !== null) {
          unlockerLog("解密任务失败（退出码 " + event.code + "）", "error");
        } else {
          unlockerLog("解密任务失败，请查看上方详细日志", "error");
        }
        break;
      }
      case "cancelled": {
        unlockerSetBusy(false);
        unlockerState.compactLog = false;
        unlockerLog("解密任务已取消", "warn");
        break;
      }
      default:
        break;
    }
  });

  unlockerRefreshFileList();
  unlockerSetBusy(false);
}

// ─── MMKV 智能定位 ───
function initMmkv() {
  if (!window.gaobai) return;

  // 1. 监听主进程的 onboarding/fail 触发
  if (window.gaobai.onMmkvOnboardingRequest) {
    window.gaobai.onMmkvOnboardingRequest((data) => {
      showMmkvOnboardingModal(data || {});
    });
  }
  if (window.gaobai.onMmkvFailRequest) {
    window.gaobai.onMmkvFailRequest((data) => {
      showMmkvFailModal(data || {});
    });
  }

  // 2. 设置页"自动搜索"按钮
  const searchBtn = document.getElementById("unlockerMmkvSearchBtn");
  if (searchBtn) {
    searchBtn.addEventListener("click", async () => {
      searchBtn.disabled = true;
      const oldText = searchBtn.textContent;
      searchBtn.textContent = "🔍 搜索中...";
      try {
        const r = await window.gaobai.mmkv.locate({ forceRescan: true });
        if (r && r.ok && r.candidates && r.candidates.length > 0) {
          // 直接弹首次启动引导(显示候选列表)
          showMmkvOnboardingModal({ preflightCandidates: r.candidates, detected: true, fromSettings: true });
        } else {
          unlockerLog("自动搜索未找到 MMKV 数据库,请手动指定。", "warn");
        }
      } catch (e) {
        unlockerLog("搜索失败: " + (e.message || e), "error");
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = oldText;
      }
    });
  }

  // 3. 设置页"取消链接"按钮
  const unlinkBtn = document.getElementById("unlockerMmkvUnlinkBtn");
  if (unlinkBtn) {
    unlinkBtn.addEventListener("click", async () => {
      try {
        const r = await window.gaobai.mmkv.unlink();
        if (r && r.ok) {
          unlockerLog("已取消 MMKV 链接。", "info");
          updateMmkvStatusBadge();
          // 清掉 unlockerState.mmkvPath
          if (typeof unlockerState !== "undefined") unlockerState.mmkvPath = "";
          const lab = document.getElementById("unlockerMmkvPathLabel");
          if (lab) lab.textContent = "未指定（可选）";
        }
      } catch (e) {
        unlockerLog("取消链接失败: " + (e.message || e), "error");
      }
    });
  }

  // 4. 初始化状态徽章
  updateMmkvStatusBadge();
}

async function updateMmkvStatusBadge() {
  const badge = document.getElementById("mmkvStatusBadge");
  if (!badge || !window.gaobai || !window.gaobai.mmkv) return;
  try {
    const s = await window.gaobai.mmkv.status();
    if (!s) return;
    if (s.linked && s.originalPath) {
      badge.textContent = "✅ 已链接到 " + s.originalPath;
      badge.className = "mmkv-status-badge ok";
    } else if (s.preflightResult && s.preflightResult.candidates && s.preflightResult.candidates.length > 0) {
      badge.textContent = "🔍 检测到 " + s.preflightResult.candidates.length + " 个候选（未启用）";
      badge.className = "mmkv-status-badge hint";
    } else {
      badge.textContent = "未链接";
      badge.className = "mmkv-status-badge warn";
    }
  } catch (_) {}
}

function showMmkvOnboardingModal(data) {
  const modal = document.getElementById("mmkvOnboardingModal");
  if (!modal) return;
  const list = document.getElementById("mmkvOnboardingList");
  const hint = document.getElementById("mmkvOnboardingHint");
  const confirmBtn = document.getElementById("mmkvOnboardingConfirm");
  let selectedIndex = -1;

  const cands = (data && data.preflightCandidates) || [];
  if (!cands.length) {
    if (hint) hint.textContent = "未找到候选 MMKV 数据库,请手动指定。";
    if (list) list.innerHTML = "";
    if (confirmBtn) confirmBtn.disabled = true;
  } else {
    if (hint) hint.textContent = "找到 " + cands.length + " 个候选 MMKV 数据库:";
    if (list) {
      list.innerHTML = "";
      cands.forEach((c, i) => {
        const row = document.createElement("label");
        row.className = "mmkv-candidate-row";
        const sizeMB = (c.size / 1024 / 1024).toFixed(1);
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "mmkvCand";
        radio.value = String(i);
        const pathSpan = document.createElement("span");
        pathSpan.className = "mmkv-cand-path";
        pathSpan.textContent = c.path;
        const metaSpan = document.createElement("span");
        metaSpan.className = "mmkv-cand-meta";
        metaSpan.textContent = "来源:" + (c.source || "未知") + " · 大小 " + sizeMB + " MB";
        row.appendChild(radio);
        row.appendChild(pathSpan);
        row.appendChild(metaSpan);
        list.appendChild(row);
      });
      list.querySelectorAll('input[name="mmkvCand"]').forEach((el) => {
        el.addEventListener("change", (e) => {
          selectedIndex = parseInt(e.target.value, 10);
          if (confirmBtn) confirmBtn.disabled = false;
        });
      });
    }
  }

  modal.classList.remove("hidden");

  const onConfirm = async () => {
    if (selectedIndex < 0) return;
    const chosen = cands[selectedIndex];
    if (!chosen) return;
if (confirmBtn) confirmBtn.disabled = true;
      try {
        const r = await window.gaobai.mmkv.link(chosen.path);
        if (r && r.ok) {
          unlockerLog("已启用 MMKV: " + r.linkPath, "info");
          // 完成设置 → 标记完成(下次启动不再弹)
          await window.gaobai.mmkv.setOnboardingState({ onboardingShown: true, onboardingChoice: "linked" });
          updateMmkvStatusBadge();
          modal.classList.add("hidden");
          if (typeof unlockerState !== "undefined") {
            unlockerState.mmkvPath = r.linkPath;
            const lab = document.getElementById("unlockerMmkvPathLabel");
            if (lab) lab.textContent = r.linkPath;
          }
        } else {
          unlockerLog("启用失败: " + ((r && r.error) || "未知错误"), "error");
        }
      } catch (e) {
        unlockerLog("启用失败: " + (e.message || e), "error");
      } finally {
        if (confirmBtn) confirmBtn.disabled = false;
      }
    };
    const onManual = async () => {
      modal.classList.add("hidden");
      const existingBtn = document.getElementById("unlockerPickMmkvBtn");
      if (existingBtn) existingBtn.click();
      // 仅 dismiss 24h,不永久标记完成(用户没真正链接)
      try {
        await window.gaobai.mmkv.setOnboardingState({ onboardingDismissedAt: Date.now(), onboardingChoice: "manual" });
      } catch (_) {}
    };
    const onSkip = async () => {
      modal.classList.add("hidden");
      // 仅 dismiss 24h,不永久标记完成
      try {
        await window.gaobai.mmkv.setOnboardingState({ onboardingDismissedAt: Date.now(), onboardingChoice: "skipped" });
      } catch (_) {}
      unlockerLog("已跳过 MMKV 自动配置,稍后可从设置页启用。", "info");
    };

  if (confirmBtn) confirmBtn.onclick = onConfirm;
  const manualBtn = document.getElementById("mmkvOnboardingManual");
  if (manualBtn) manualBtn.onclick = onManual;
  const skipBtn = document.getElementById("mmkvOnboardingSkip");
  if (skipBtn) skipBtn.onclick = onSkip;

  // 关闭按钮(overlay / ×)
  modal.querySelectorAll('[data-mmkv-close="onboarding"]').forEach((el) => {
    el.onclick = onSkip;
  });
}

function showMmkvFailModal(data) {
  const modal = document.getElementById("mmkvFailModal");
  if (!modal) return;
  const msgEl = document.getElementById("mmkvFailMessage");
  if (msgEl) msgEl.textContent = (data && data.message) || "";

  modal.classList.remove("hidden");

  const onSearch = async () => {
    modal.classList.add("hidden");
    const searchBtn = document.getElementById("unlockerMmkvSearchBtn");
    if (searchBtn) searchBtn.click();
  };
  const onManual = () => {
    modal.classList.add("hidden");
    const existingBtn = document.getElementById("unlockerPickMmkvBtn");
    if (existingBtn) existingBtn.click();
  };
  const onHelp = () => {
    // 临时打开内置教程页,后续可替换为 docs/superpowers/specs 里的 wiki
    window.open("https://example.com/help/qqmusic-mmkv", "_blank");
  };
  const onClose = async () => {
    modal.classList.add("hidden");
    // dismiss 失败引导框 24h(避免反复骚扰)
    try {
      await window.gaobai.mmkv.setOnboardingState({ failurePromptDismissedAt: Date.now() });
    } catch (_) {}
  };

  const sBtn = document.getElementById("mmkvFailSearch");
  if (sBtn) sBtn.onclick = onSearch;
  const mBtn = document.getElementById("mmkvFailManual");
  if (mBtn) mBtn.onclick = onManual;
  const hBtn = document.getElementById("mmkvFailHelp");
  if (hBtn) hBtn.onclick = onHelp;
  const cBtn = document.getElementById("mmkvFailClose");
  if (cBtn) cBtn.onclick = onClose;

  modal.querySelectorAll('[data-mmkv-close="fail"]').forEach((el) => {
    el.onclick = onClose;
  });
}

// 独立调用 initMmkv,确保即使 unlockerInit 因故未执行也能启动监听
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMmkv);
} else {
  initMmkv();
}
