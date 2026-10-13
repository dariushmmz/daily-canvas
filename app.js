(function () {
  "use strict";

  /* ================= constants and DOM ================= */
  const STORAGE_KEY = "daily-planner-v1";
  const CORRUPT_PREFIX = "daily-planner-v1-corrupt-";
  const APP_VERSION = 2;
  const STYLE_KEYS = ["h1", "h2", "h3", "body"];
  const STYLE_SET = new Set(STYLE_KEYS);
  const PEN_WIDTHS = [0, 1.5, 3, 5, 8, 12];
  const MAX_STROKE_POINTS = 20000;
  const MAX_COORD = 10000000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const $ = function (selector) { return document.querySelector(selector); };
  const root = document.documentElement;
  const canvas = $("#canvas");
  const world = $("#world");
  const blocksLayer = $("#blocks-layer");
  const strokesLayer = $("#strokes");
  const topbar = $("#top");
  const toolbar = $("#toolbar");
  const canvasTools = $("#canvas-tools");
  const statusEl = $("#status");
  const undoButton = $("#undo-canvas");
  const eraserButton = $("#eraser-toggle");
  const eraserCursor = $("#eraser-cursor");
  const mitBox = $("#mit");
  const mitText = $("#mit-text");
  const mitDone = $("#mit-done");
  const list = $("#tasks");
  const addInput = $("#add");
  const progress = $("#progress");
  const dateInput = $("#date");
  const dataPanel = $("#data-panel");
  const storageUsage = $("#storage-usage");
  const storageNotice = $("#storage-notice");
  const importFile = $("#import-file");
  const confirmDialog = $("#confirm-dialog");
  const plainEditable = (function () {
    const element = document.createElement("div");
    element.contentEditable = "plaintext-only";
    return element.contentEditable === "plaintext-only";
  }());

  const S = { date: null, ready: false, blocks: new Set(), strokes: [], tasks: [] };
  let state;
  let storageAvailable = testStorage();
  let storageProblem = storageAvailable ? "" : "Browser storage is unavailable. Changes will last only until this page closes.";
  let corruptNotice = false;
  let pendingExternalState = null;
  let externalRepaintNeeded = false;
  let flashTimer = 0;
  let statusMessage = "";
  let editing = null;
  let taskDraft = null;
  let mitDraft = null;
  let mitTimer = 0;
  let spaceHeld = false;
  let camera = { x: 0, y: 0 };
  let viewTimer = 0;
  let penLevel = 3;
  let eraserEnabled = false;
  let activeStroke = null;
  let eraseGesture = null;
  let panGesture = null;
  let suppressDoubleClickUntil = 0;
  let lastPt = { x: innerWidth * 0.12, y: innerHeight * 0.4 };
  let toastUndo = null;
  let toastTimer = 0;
  const histories = new Map();

  /* ================= state, storage, and sanitization ================= */
  // This adapter is the only direct localStorage access in app.js.
  function storageAccess(operation, key, value) {
    if (operation === "get") return window.localStorage.getItem(key);
    if (operation === "set") return window.localStorage.setItem(key, value);
    if (operation === "remove") return window.localStorage.removeItem(key);
    throw new Error("Unknown storage operation");
  }

  function testStorage() {
    const probe = "__daily_planner_probe__";
    try {
      storageAccess("set", probe, "1");
      storageAccess("remove", probe);
      return true;
    } catch (_) {
      return false;
    }
  }

  function emptyState() {
    return {
      version: APP_VERSION,
      meta: { updatedAt: new Date(0).toISOString(), theme: "system", penLevel: 3, views: {} },
      days: {}
    };
  }

  function loadState() {
    if (!storageAvailable) return emptyState();
    let raw;
    try {
      raw = storageAccess("get", STORAGE_KEY);
      if (!raw) return emptyState();
      return sanitizeState(JSON.parse(raw));
    } catch (_) {
      if (typeof raw === "string" && raw) {
        try {
          storageAccess("set", CORRUPT_PREFIX + Date.now(), raw);
          corruptNotice = true;
          storageProblem = "Corrupted planner data was backed up under a dated recovery key. A safe empty planner was loaded.";
        } catch (_) {
          storageProblem = "Planner data was corrupted and could not be backed up. A safe empty planner was loaded for this session.";
        }
      }
      return emptyState();
    }
  }

  // saveState has exactly one caller: commit().
  function saveState() {
    if (!storageAvailable) return;
    try {
      storageAccess("set", STORAGE_KEY, JSON.stringify(state));
      if (!corruptNotice) storageProblem = "";
    } catch (error) {
      storageAvailable = false;
      storageProblem = error && error.name === "QuotaExceededError"
        ? "Browser storage is full. Recent changes are only in memory; export a backup now."
        : "Browser storage is unavailable. Recent changes are only in memory.";
    }
  }

  function commit(mutateFn) {
    let adopted = false;
    if (pendingExternalState) {
      state = pendingExternalState;
      pendingExternalState = null;
      adopted = true;
      externalRepaintNeeded = true;
    }
    mutateFn(state);
    if (!isObject(state.meta)) state.meta = {};
    state.meta.updatedAt = new Date().toISOString();
    saveState();
    refreshStatus();
    renderStorageStatus();
    if ((adopted || externalRepaintNeeded) && !hasUncommittedWork()) {
      externalRepaintNeeded = false;
      const date = S.date;
      setTimeout(function () { if (date && S.date === date && !hasUncommittedWork()) paintDay(date, false); }, 0);
    }
  }

  function adoptPendingIfIdle() {
    if (hasUncommittedWork()) return;
    if (pendingExternalState) {
      state = pendingExternalState;
      pendingExternalState = null;
      externalRepaintNeeded = false;
      applyTheme();
      paintDay(S.date || today(), false);
      announce("Changes from another tab were loaded");
    } else if (externalRepaintNeeded) {
      externalRepaintNeeded = false;
      paintDay(S.date || today(), false);
    }
  }

  function sanitizeState(input) {
    const source = isObject(input) ? input : {};
    const version = finiteNumber(source.version, APP_VERSION);
    const metaSource = isObject(source.meta) ? source.meta : {};
    const theme = ["light", "dark", "system"].includes(metaSource.theme) ? metaSource.theme : "system";
    const updatedAt = typeof metaSource.updatedAt === "string" && !Number.isNaN(Date.parse(metaSource.updatedAt))
      ? metaSource.updatedAt : new Date(0).toISOString();
    const views = {};
    if (isObject(metaSource.views)) {
      Object.keys(metaSource.views).forEach(function (date) {
        const view = metaSource.views[date];
        if (isValidISO(date) && isObject(view)) {
          views[date] = { ...view, x: coordinate(view.x, 0), y: coordinate(view.y, 0) };
        }
      });
    }
    const result = {
      ...source,
      version: version > APP_VERSION ? version : APP_VERSION,
      meta: {
        ...metaSource,
        updatedAt: updatedAt,
        theme: theme,
        penLevel: clamp(Math.round(finiteNumber(metaSource.penLevel, 3)), 1, 5),
        views: views
      },
      days: {}
    };
    const seenIds = new Set();
    if (isObject(source.days)) {
      Object.keys(source.days).forEach(function (date) {
        if (!isValidISO(date) || !isObject(source.days[date])) return;
        result.days[date] = sanitizeDay(source.days[date], seenIds);
      });
    }
    return result;
  }

  function sanitizeDay(value, seenIds) {
    const source = isObject(value) ? value : {};
    const rawMit = isObject(source.mit) ? source.mit : {};
    const day = {
      ...source,
      mit: { ...rawMit, text: cleanText(rawMit.text, 500, false), done: coerceBoolean(rawMit.done) },
      tasks: [], blocks: [], strokes: []
    };
    if (Array.isArray(source.tasks)) {
      source.tasks.forEach(function (item) {
        if (!isObject(item)) return;
        const text = cleanText(item.text, 500, false);
        if (!text) return;
        day.tasks.push({ ...item, id: safeId(item.id, seenIds), text: text, done: coerceBoolean(item.done) });
      });
    }
    if (Array.isArray(source.blocks)) {
      source.blocks.forEach(function (item) {
        if (!isObject(item)) return;
        const text = cleanText(item.text, 2000, true);
        if (!text) return;
        const worldSpace = item.space === 2;
        day.blocks.push({
          ...item,
          id: safeId(item.id, seenIds),
          x: worldSpace ? coordinate(item.x, 0) : clamp(finiteNumber(item.x, 0.5), 0, 1),
          y: worldSpace ? coordinate(item.y, 0) : clamp(finiteNumber(item.y, 0.5), 0, 1),
          text: text,
          style: STYLE_SET.has(item.style) ? item.style : "body",
          space: worldSpace ? 2 : 1
        });
      });
    }
    if (Array.isArray(source.strokes)) {
      source.strokes.forEach(function (item) {
        if (!isObject(item) || !Array.isArray(item.points)) return;
        const points = [];
        for (const point of item.points.slice(0, MAX_STROKE_POINTS)) {
          if (!Array.isArray(point) || point.length !== 2) continue;
          const x = Number(point[0]);
          const y = Number(point[1]);
          if (Number.isFinite(x) && Number.isFinite(y)) points.push([coordinate(x, 0), coordinate(y, 0)]);
        }
        if (!points.length) return;
        day.strokes.push({
          ...item,
          id: safeId(item.id, seenIds),
          points: points,
          width: clamp(finiteNumber(item.width, 5), 1, 32)
        });
      });
    }
    return day;
  }

  function migrateLegacyCoordinates(rootState) {
    let changed = false;
    Object.keys(rootState.days || {}).forEach(function (date) {
      rootState.days[date].blocks.forEach(function (block) {
        if (block.space !== 2) {
          block.x = Math.round(block.x * innerWidth * 10) / 10;
          block.y = Math.round(block.y * innerHeight * 10) / 10;
          block.space = 2;
          changed = true;
        }
      });
    });
    return changed;
  }

  function hasLegacyCoordinates(rootState) {
    return Object.keys(rootState.days || {}).some(function (date) {
      return rootState.days[date].blocks.some(function (block) { return block.space !== 2; });
    });
  }

  function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function finiteNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
  function coordinate(value, fallback) { return clamp(finiteNumber(value, fallback), -MAX_COORD, MAX_COORD); }
  function coerceBoolean(value) { return value === true || value === 1 || value === "true"; }
  function cleanText(value, limit, multiline) {
    if (value === null || value === undefined) return "";
    let text = String(value).replace(/\r\n?/g, "\n").trim();
    if (!multiline) text = text.replace(/\s*\n\s*/g, " ");
    return text.slice(0, limit);
  }
  function safeId(value, seen) {
    let id = typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, 120) : "";
    if (!id || seen.has(id)) id = makeId();
    while (seen.has(id)) id = makeId();
    seen.add(id);
    return id;
  }
  function makeId() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 11);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  const pad = function (number) { return String(number).padStart(2, "0"); };
  const toISO = function (date) { return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()); };
  const fromISO = function (value) { const parts = value.split("-").map(Number); return new Date(parts[0], parts[1] - 1, parts[2]); };
  const isValidISO = function (value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && toISO(fromISO(value)) === value; };
  const shift = function (value, amount) { const date = fromISO(value); date.setDate(date.getDate() + amount); return toISO(date); };
  const today = function () { return toISO(new Date()); };

  function ensureDay(rootState, date) {
    if (!isObject(rootState.days)) rootState.days = {};
    if (!isObject(rootState.days[date])) rootState.days[date] = { mit: { text: "", done: false }, tasks: [], blocks: [], strokes: [] };
    const day = rootState.days[date];
    if (!isObject(day.mit)) day.mit = { text: "", done: false };
    if (!Array.isArray(day.tasks)) day.tasks = [];
    if (!Array.isArray(day.blocks)) day.blocks = [];
    if (!Array.isArray(day.strokes)) day.strokes = [];
    return day;
  }

  function getDay(date) {
    return state.days[date] || { mit: { text: "", done: false }, tasks: [], blocks: [], strokes: [] };
  }

  function findById(items, id) { return items.find(function (item) { return item.id === id; }); }
  function indexById(items, id) { return items.findIndex(function (item) { return item.id === id; }); }

  state = loadState();
  if (hasLegacyCoordinates(state) || corruptNotice) commit(function (rootState) { migrateLegacyCoordinates(rootState); });

  /* ================= status, theme, and data safety UI ================= */
  function refreshStatus() {
    if (statusMessage) statusEl.textContent = statusMessage;
    else if (storageProblem) statusEl.textContent = "Not saved";
    else statusEl.textContent = "Saved";
  }

  function flash(message, milliseconds) {
    clearTimeout(flashTimer);
    statusMessage = message;
    refreshStatus();
    flashTimer = setTimeout(function () { statusMessage = ""; refreshStatus(); }, milliseconds || 2500);
  }

  function announce(message) {
    const live = $("#live-region");
    live.textContent = "";
    requestAnimationFrame(function () { live.textContent = message; });
  }

  function renderStorageStatus() {
    const json = JSON.stringify(state);
    let bytes;
    try { bytes = new Blob([json]).size; } catch (_) { bytes = json.length * 2; }
    storageUsage.textContent = formatBytes(bytes) + " stored";
    storageUsage.title = bytes + " bytes in the planner state";
    storageNotice.hidden = !storageProblem;
    storageNotice.textContent = storageProblem;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function applyTheme() {
    const preference = ["light", "dark", "system"].includes(state.meta.theme) ? state.meta.theme : "system";
    const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  }

  $("#theme").addEventListener("click", function () {
    const dark = root.dataset.theme === "dark";
    commit(function (rootState) { rootState.meta.theme = dark ? "light" : "dark"; });
    applyTheme();
  });

  const colorQuery = matchMedia("(prefers-color-scheme: dark)");
  const systemThemeChanged = function () { if (state.meta.theme === "system") applyTheme(); };
  if (colorQuery.addEventListener) colorQuery.addEventListener("change", systemThemeChanged);
  else colorQuery.addListener(systemThemeChanged);

  new ResizeObserver(function () { root.style.setProperty("--top-h", topbar.offsetHeight + "px"); }).observe(topbar);

  function offerToastUndo(message, action) {
    clearTimeout(toastTimer);
    toastUndo = action;
    $("#undo-message").textContent = message;
    $("#undo-toast").hidden = false;
    toastTimer = setTimeout(dismissToast, 9000);
  }
  function dismissToast() {
    clearTimeout(toastTimer);
    toastUndo = null;
    $("#undo-toast").hidden = true;
  }
  $("#toast-undo").addEventListener("click", function () {
    if (!toastUndo) return;
    const action = toastUndo;
    dismissToast();
    action();
    announce("Action undone");
  });
  $("#toast-dismiss").addEventListener("click", dismissToast);

  function showConfirm(title, message, label) {
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-accept").textContent = label || "Continue";
    return new Promise(function (resolve) {
      const close = function () {
        confirmDialog.removeEventListener("close", close);
        resolve(confirmDialog.returnValue === "confirm");
      };
      confirmDialog.addEventListener("close", close);
      confirmDialog.showModal();
      requestAnimationFrame(function () { $("#confirm-cancel").focus(); });
    });
  }

  confirmDialog.addEventListener("keydown", function (event) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(confirmDialog.querySelectorAll("button:not([disabled])"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  $("#data-menu-toggle").addEventListener("click", function () {
    dataPanel.hidden = !dataPanel.hidden;
    this.setAttribute("aria-expanded", String(!dataPanel.hidden));
    if (!dataPanel.hidden) $("#export").focus();
  });
  $("#data-panel-close").addEventListener("click", function () {
    dataPanel.hidden = true;
    $("#data-menu-toggle").setAttribute("aria-expanded", "false");
    $("#data-menu-toggle").focus();
  });

  function exportBackup() {
    flushAll();
    const blob = new Blob([JSON.stringify(state, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "daily-planner-backup-" + today() + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    flash("Backup exported");
  }
  $("#export").addEventListener("click", exportBackup);
  $("#import").addEventListener("click", function () { importFile.value = ""; importFile.click(); });
  importFile.addEventListener("change", function () {
    const file = importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = function () { flash("Could not read that backup", 5000); };
    reader.onload = async function () {
      let imported;
      try {
        imported = sanitizeState(JSON.parse(String(reader.result)));
        migrateLegacyCoordinates(imported);
      } catch (_) {
        flash("That file is not valid planner JSON", 5000);
        return;
      }
      const accepted = await showConfirm("Replace planner data?", "The backup will replace every current day. You can undo immediately afterward.", "Import backup");
      if (!accepted) return;
      flushAll();
      const previous = clone(state);
      commit(function () { state = imported; });
      histories.clear();
      applyTheme();
      paintDay(S.date || today(), true);
      offerToastUndo("Backup imported", function () {
        commit(function () { state = previous; });
        histories.clear();
        applyTheme();
        paintDay(S.date || today(), true);
      });
    };
    reader.readAsText(file);
  });

  $("#delete-all").addEventListener("click", async function () {
    const accepted = await showConfirm("Delete all planner data?", "Every day, task, text block, drawing, and saved canvas view will be removed. You can undo immediately afterward.", "Delete all");
    if (!accepted) return;
    flushAll();
    const previous = clone(state);
    commit(function (rootState) { rootState.days = {}; rootState.meta.views = {}; });
    histories.clear();
    paintDay(S.date || today(), true);
    offerToastUndo("All planner data deleted", function () {
      commit(function () { state = previous; });
      applyTheme();
      paintDay(S.date || today(), true);
    });
  });

  /* ================= canvas camera and tools ================= */
  function setPenLevel(level, persist) {
    penLevel = clamp(Number(level) || 3, 1, 5);
    canvasTools.querySelectorAll("[data-pen]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.pen) === penLevel));
    });
    if (persist) commit(function (rootState) { rootState.meta.penLevel = penLevel; });
  }
  function setEraser(enabled) {
    eraserEnabled = Boolean(enabled);
    eraserButton.setAttribute("aria-pressed", String(eraserEnabled));
    canvas.classList.toggle("eraser-active", eraserEnabled);
    if (!eraserEnabled) eraserCursor.classList.remove("show");
  }
  canvasTools.addEventListener("click", function (event) {
    const button = event.target.closest("[data-pen]");
    if (button) { setPenLevel(button.dataset.pen, true); setEraser(false); }
  });
  eraserButton.addEventListener("click", function () { setEraser(!eraserEnabled); });

  function historyFor(date) {
    if (!histories.has(date)) histories.set(date, []);
    return histories.get(date);
  }
  function updateUndo() { undoButton.disabled = !S.date || !historyFor(S.date).length; }
  function recordCanvasAction(date, undo) {
    const history = historyFor(date);
    history.push(undo);
    if (history.length > 100) history.shift();
    if (date === S.date) updateUndo();
  }
  function undoCanvasAction() {
    if (!S.date) return;
    const undo = historyFor(S.date).pop();
    if (!undo) return;
    undo();
    updateUndo();
  }
  undoButton.addEventListener("click", undoCanvasAction);

  function applyCamera(save) {
    world.style.transform = "translate(" + camera.x + "px, " + camera.y + "px)";
    canvas.style.backgroundPosition = (camera.x + 14) + "px " + (camera.y + 14) + "px";
    if (save && S.date) {
      clearTimeout(viewTimer);
      const date = S.date;
      const position = { x: camera.x, y: camera.y };
      viewTimer = setTimeout(function () {
        viewTimer = 0;
        commit(function (rootState) {
          if (!isObject(rootState.meta.views)) rootState.meta.views = {};
          rootState.meta.views[date] = position;
        });
      }, 150);
    }
  }
  function restoreCamera(date) {
    const saved = isObject(state.meta.views) && isObject(state.meta.views[date]) ? state.meta.views[date] : null;
    camera = saved ? { x: coordinate(saved.x, 0), y: coordinate(saved.y, 0) } : { x: 0, y: 0 };
    applyCamera(false);
  }
  function flushCamera() {
    if (!viewTimer || !S.date) return;
    clearTimeout(viewTimer);
    viewTimer = 0;
    const date = S.date;
    const position = { x: camera.x, y: camera.y };
    commit(function (rootState) {
      if (!isObject(rootState.meta.views)) rootState.meta.views = {};
      rootState.meta.views[date] = position;
    });
  }
  const toWorld = function (x, y) { return { x: x - camera.x, y: y - camera.y }; };
  $("#reset-view").addEventListener("click", function () { camera = { x: 0, y: 0 }; applyCamera(true); });
  canvas.addEventListener("wheel", function (event) {
    event.preventDefault();
    endEdit();
    camera.x -= event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    camera.y -= event.shiftKey && !event.deltaX ? 0 : event.deltaY;
    applyCamera(true);
  }, { passive: false });

  /* ================= text blocks ================= */
  function place(block) {
    block.el.style.left = block.x + "px";
    block.el.style.top = block.y + "px";
  }

  function addBlock(data) {
    const block = {
      id: data.id || makeId(), date: S.date, x: coordinate(data.x, 0), y: coordinate(data.y, 0),
      text: data.text || "", style: STYLE_SET.has(data.style) ? data.style : "body",
      saved: data.saved !== false, originalIndex: finiteNumber(data.originalIndex, S.blocks.size), dirty: false
    };
    const element = block.el = document.createElement("div");
    element.className = "block";
    element.tabIndex = 0;
    element.dataset.style = block.style;
    element.dataset.id = block.id;
    element.textContent = block.text;
    place(block);
    blocksLayer.appendChild(element);
    S.blocks.add(block);
    element.addEventListener("pointerdown", function (event) { onBlockDown(event, block); });
    element.addEventListener("dblclick", function (event) {
      if (event.button === 0) { event.preventDefault(); event.stopPropagation(); startEdit(block); }
    });
    element.addEventListener("keydown", function (event) { onBlockKey(event, block); });
    element.addEventListener("blur", function () { if (editing === block) endEdit(); });
    element.addEventListener("input", function () {
      if (editing === block) { block.dirty = true; showToolbar(block); }
    });
    element.addEventListener("paste", function (event) {
      if (plainEditable) return;
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    return block;
  }

  function stateBlockSnapshot(date, id) {
    const blocks = getDay(date).blocks || [];
    const index = indexById(blocks, id);
    return index < 0 ? null : { item: clone(blocks[index]), index: index };
  }

  function upsertBlock(rootState, block, patch) {
    const blocks = ensureDay(rootState, block.date).blocks;
    const index = indexById(blocks, block.id);
    const values = { id: block.id, x: block.x, y: block.y, text: block.text, style: block.style, space: 2, ...patch };
    if (index >= 0) blocks[index] = { ...blocks[index], ...values };
    else blocks.splice(clamp(block.originalIndex, 0, blocks.length), 0, values);
  }

  function removeBlock(block, options) {
    const record = !options || options.record !== false;
    if (editing === block) {
      editing = null;
      block.el.contentEditable = "false";
      block.el.classList.remove("editing");
      hideToolbar();
    }
    const snapshot = block.saved ? stateBlockSnapshot(block.date, block.id) : null;
    block.el.remove();
    S.blocks.delete(block);
    if (block.saved) {
      commit(function (rootState) {
        const blocks = ensureDay(rootState, block.date).blocks;
        const index = indexById(blocks, block.id);
        if (index >= 0) blocks.splice(index, 1);
      });
      block.saved = false;
    }
    if (record && snapshot) {
      recordCanvasAction(block.date, function () {
        commit(function (rootState) {
          const blocks = ensureDay(rootState, block.date).blocks;
          if (indexById(blocks, snapshot.item.id) < 0) blocks.splice(clamp(snapshot.index, 0, blocks.length), 0, clone(snapshot.item));
        });
        if (block.date === S.date) paintCanvas();
      });
    }
  }

  function startEdit(block) {
    if (editing === block) return;
    if (editing) endEdit();
    editing = block;
    block.dirty = !block.saved;
    block.el.contentEditable = plainEditable ? "plaintext-only" : "true";
    block.el.classList.add("editing");
    block.el.focus();
    const range = document.createRange();
    range.selectNodeContents(block.el);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    showToolbar(block);
  }

  function endEdit() {
    const block = editing;
    if (!block) return;
    editing = null;
    setTimeout(adoptPendingIfIdle, 0);
    block.el.contentEditable = "false";
    block.el.classList.remove("editing");
    hideToolbar();
    const text = block.el.innerText.replace(/\u00a0/g, " ").trim().slice(0, 2000);
    if (!text) { removeBlock(block, { record: block.saved }); return; }
    block.el.textContent = text;
    if (!block.saved) {
      block.text = text;
      block.saved = true;
      commit(function (rootState) { upsertBlock(rootState, block, { text: text }); });
      recordCanvasAction(block.date, function () {
        commit(function (rootState) {
          const blocks = ensureDay(rootState, block.date).blocks;
          const index = indexById(blocks, block.id);
          if (index >= 0) blocks.splice(index, 1);
        });
        if (block.date === S.date) paintCanvas();
      });
    } else if (text !== block.text) {
      const before = block.text;
      block.text = text;
      commit(function (rootState) { upsertBlock(rootState, block, { text: text }); });
      recordCanvasAction(block.date, function () {
        commit(function (rootState) {
          const blocks = ensureDay(rootState, block.date).blocks;
          const target = findById(blocks, block.id);
          if (target) target.text = before;
        });
        if (block.date === S.date) paintCanvas();
      });
    }
    block.dirty = false;
  }

  function setStyle(block, style) {
    if (!STYLE_SET.has(style) || style === block.style) return;
    const before = block.style;
    const shouldRecord = block.saved;
    block.style = style;
    block.el.dataset.style = style;
    if (block.saved) commit(function (rootState) { upsertBlock(rootState, block, { style: style }); });
    if (shouldRecord) recordCanvasAction(block.date, function () {
      commit(function (rootState) {
        const target = findById(ensureDay(rootState, block.date).blocks, block.id);
        if (target) target.style = before;
      });
      if (block.date === S.date) paintCanvas();
    });
    if (editing === block) showToolbar(block);
  }

  function onBlockKey(event, block) {
    if (editing === block) {
      if (event.key === "Escape") { event.preventDefault(); endEdit(); block.el.focus(); }
      else if (event.altKey && /^Digit[1-4]$/.test(event.code)) { event.preventDefault(); setStyle(block, STYLE_KEYS[Number(event.code.slice(5)) - 1]); }
    } else if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); startEdit(block); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeBlock(block); }
  }

  function onBlockDown(event, block) {
    if (editing === block || event.button !== 0 || spaceHeld) return;
    event.stopPropagation();
    const rect = block.el.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;
    const before = { x: block.x, y: block.y };
    let moved = false;
    block.el.setPointerCapture(event.pointerId);
    const move = function (moveEvent) {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
      moved = true;
      block.el.classList.add("dragging");
      block.x = coordinate(moveEvent.clientX - camera.x - offsetX, block.x);
      block.y = coordinate(moveEvent.clientY - camera.y - offsetY, block.y);
      place(block);
    };
    const up = function (upEvent) {
      block.el.removeEventListener("pointermove", move);
      block.el.removeEventListener("pointerup", up);
      block.el.removeEventListener("pointercancel", up);
      block.el.classList.remove("dragging");
      if (moved) {
        commit(function (rootState) { upsertBlock(rootState, block, { x: block.x, y: block.y }); });
        recordCanvasAction(block.date, function () {
          commit(function (rootState) {
            const target = findById(ensureDay(rootState, block.date).blocks, block.id);
            if (target) { target.x = before.x; target.y = before.y; }
          });
          if (block.date === S.date) paintCanvas();
        });
      } else if (upEvent && upEvent.type === "pointerup") block.el.focus();
    };
    block.el.addEventListener("pointermove", move);
    block.el.addEventListener("pointerup", up);
    block.el.addEventListener("pointercancel", up);
  }

  function createAt(x, y) {
    if (!S.ready) return;
    const point = toWorld(x, y);
    startEdit(addBlock({ id: makeId(), x: point.x, y: point.y, text: "", style: "body", saved: false, originalIndex: S.blocks.size }));
  }

  function showToolbar(block) {
    toolbar.classList.add("show");
    toolbar.querySelectorAll("[data-style]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.style === block.style));
    });
    const rect = block.el.getBoundingClientRect();
    const height = toolbar.offsetHeight;
    const width = toolbar.offsetWidth;
    let y = rect.top - height - 8;
    if (y < topbar.offsetHeight + 4) y = rect.bottom + 8;
    toolbar.style.top = clamp(y, 0, innerHeight - height - 4) + "px";
    toolbar.style.left = clamp(rect.left, 4, innerWidth - width - 4) + "px";
  }
  function hideToolbar() { toolbar.classList.remove("show"); }
  ["mousedown", "pointerdown"].forEach(function (type) {
    toolbar.addEventListener(type, function (event) { event.preventDefault(); });
  });
  toolbar.addEventListener("click", function (event) {
    const button = event.target.closest("button");
    if (!button || !editing) return;
    if (button.dataset.style) setStyle(editing, button.dataset.style);
    else if (button.dataset.action === "delete") {
      const block = editing;
      endEdit();
      if (S.blocks.has(block)) removeBlock(block);
    }
  });

  /* ================= freehand drawing, erasing, and panning ================= */
  function roundedPoint(x, y) {
    const point = toWorld(x, y);
    return [Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10];
  }
  function pathData(points) {
    if (!points.length) return "";
    if (points.length === 1) return "M " + points[0][0] + " " + points[0][1] + " l .01 0";
    let path = "M " + points[0][0] + " " + points[0][1];
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index];
      const next = points[index + 1];
      path += " Q " + point[0] + " " + point[1] + " " + ((point[0] + next[0]) / 2) + " " + ((point[1] + next[1]) / 2);
    }
    const last = points[points.length - 1];
    return path + " L " + last[0] + " " + last[1];
  }
  function renderStroke(stroke) {
    const path = pathData(stroke.points);
    stroke.path.setAttribute("d", path);
    stroke.hit.setAttribute("d", path);
  }
  function addStroke(data) {
    const stroke = {
      id: data.id || makeId(), date: S.date, points: data.points.map(function (point) { return [point[0], point[1]]; }),
      width: clamp(finiteNumber(data.width, 5), 1, 32), saved: data.saved !== false,
      originalIndex: finiteNumber(data.originalIndex, S.strokes.length)
    };
    stroke.el = document.createElementNS(SVG_NS, "g");
    stroke.el.setAttribute("class", "stroke-group");
    stroke.path = document.createElementNS(SVG_NS, "path");
    stroke.path.setAttribute("class", "stroke");
    stroke.path.setAttribute("stroke-width", stroke.width);
    stroke.hit = document.createElementNS(SVG_NS, "path");
    stroke.hit.setAttribute("class", "stroke-hit");
    stroke.hit.setAttribute("stroke-width", Math.max(14, stroke.width + 10));
    stroke.hit._stroke = stroke;
    stroke.hit.addEventListener("pointerdown", function (event) { onStrokeDown(event, stroke); });
    stroke.el.append(stroke.path, stroke.hit);
    renderStroke(stroke);
    strokesLayer.appendChild(stroke.el);
    S.strokes.push(stroke);
    return stroke;
  }
  function strokeSnapshot(stroke) {
    const strokes = getDay(stroke.date).strokes || [];
    const index = indexById(strokes, stroke.id);
    return index < 0 ? null : { item: clone(strokes[index]), index: index };
  }
  function upsertStroke(rootState, stroke) {
    const strokes = ensureDay(rootState, stroke.date).strokes;
    const index = indexById(strokes, stroke.id);
    const values = { id: stroke.id, points: stroke.points.map(function (point) { return [point[0], point[1]]; }), width: stroke.width };
    if (index >= 0) strokes[index] = { ...strokes[index], ...values };
    else strokes.splice(clamp(stroke.originalIndex, 0, strokes.length), 0, values);
  }
  function removeStrokeVisual(stroke) {
    stroke.el.remove();
    S.strokes = S.strokes.filter(function (item) { return item !== stroke; });
  }
  function appendStrokePoints(event) {
    if (!activeStroke || event.pointerId !== activeStroke.pointerId) return;
    const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    for (const sample of events) {
      if (activeStroke.points.length >= MAX_STROKE_POINTS) break;
      const point = roundedPoint(sample.clientX, sample.clientY);
      const previous = activeStroke.points[activeStroke.points.length - 1];
      if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= 0.7) activeStroke.points.push(point);
    }
    renderStroke(activeStroke);
  }
  function finishStroke(event) {
    if (!activeStroke || (event && event.pointerId !== activeStroke.pointerId)) return;
    if (event) appendStrokePoints(event);
    const stroke = activeStroke;
    activeStroke = null;
    canvas.classList.remove("drawing");
    if (!stroke.points.length) { removeStrokeVisual(stroke); return; }
    stroke.saved = true;
    commit(function (rootState) { upsertStroke(rootState, stroke); });
    recordCanvasAction(stroke.date, function () {
      commit(function (rootState) {
        const strokes = ensureDay(rootState, stroke.date).strokes;
        const index = indexById(strokes, stroke.id);
        if (index >= 0) strokes.splice(index, 1);
      });
      if (stroke.date === S.date) paintCanvas();
    });
  }
  function eraseAt(x, y) {
    if (!eraseGesture) return;
    eraserCursor.style.left = x + "px";
    eraserCursor.style.top = y + "px";
    const offsets = [[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8], [-6, -6], [6, -6], [-6, 6], [6, 6]];
    offsets.forEach(function (offset) {
      document.elementsFromPoint(x + offset[0], y + offset[1]).forEach(function (element) {
        const stroke = element._stroke;
        if (!stroke || eraseGesture.removed.has(stroke)) return;
        const snapshot = strokeSnapshot(stroke);
        if (!snapshot) return;
        eraseGesture.removed.set(stroke, snapshot);
        removeStrokeVisual(stroke);
      });
    });
  }
  function finishErase(event) {
    if (!eraseGesture || (event && event.pointerId !== eraseGesture.pointerId)) return;
    const gesture = eraseGesture;
    eraseGesture = null;
    setTimeout(adoptPendingIfIdle, 0);
    eraserCursor.classList.remove("show");
    if (!gesture.removed.size) return;
    const removed = Array.from(gesture.removed.values()).sort(function (a, b) { return a.index - b.index; });
    const ids = new Set(removed.map(function (entry) { return entry.item.id; }));
    commit(function (rootState) {
      const strokes = ensureDay(rootState, gesture.date).strokes;
      ensureDay(rootState, gesture.date).strokes = strokes.filter(function (stroke) { return !ids.has(stroke.id); });
    });
    recordCanvasAction(gesture.date, function () {
      commit(function (rootState) {
        const strokes = ensureDay(rootState, gesture.date).strokes;
        removed.forEach(function (entry) {
          if (indexById(strokes, entry.item.id) < 0) strokes.splice(clamp(entry.index, 0, strokes.length), 0, clone(entry.item));
        });
      });
      if (gesture.date === S.date) paintCanvas();
    });
  }
  function onStrokeDown(event, stroke) {
    if (event.button !== 0 || spaceHeld) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const before = stroke.points.map(function (point) { return [point[0], point[1]]; });
    let moved = false;
    let dx = 0;
    let dy = 0;
    target.setPointerCapture(event.pointerId);
    const move = function (moveEvent) {
      dx = moveEvent.clientX - startX;
      dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      stroke.el.classList.add("dragging");
      stroke.el.setAttribute("transform", "translate(" + dx + " " + dy + ")");
    };
    const up = function () {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      stroke.el.classList.remove("dragging");
      stroke.el.removeAttribute("transform");
      if (!moved) return;
      stroke.points = before.map(function (point) {
        return [Math.round((point[0] + dx) * 10) / 10, Math.round((point[1] + dy) * 10) / 10];
      });
      renderStroke(stroke);
      commit(function (rootState) { upsertStroke(rootState, stroke); });
      recordCanvasAction(stroke.date, function () {
        commit(function (rootState) {
          const targetStroke = findById(ensureDay(rootState, stroke.date).strokes, stroke.id);
          if (targetStroke) targetStroke.points = before.map(function (point) { return [point[0], point[1]]; });
        });
        if (stroke.date === S.date) paintCanvas();
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }
  function finishPan(event) {
    if (!panGesture || (event && event.pointerId !== panGesture.pointerId)) return;
    const moved = panGesture.moved;
    panGesture = null;
    setTimeout(adoptPendingIfIdle, 0);
    canvas.classList.remove("panning");
    if (moved) { suppressDoubleClickUntil = performance.now() + 250; applyCamera(true); }
  }

  canvas.addEventListener("pointerdown", function (event) {
    if (event.button === 2 && S.ready) {
      event.preventDefault();
      endEdit();
      canvas.setPointerCapture(event.pointerId);
      if (eraserEnabled) {
        eraseGesture = { pointerId: event.pointerId, date: S.date, removed: new Map() };
        eraserCursor.classList.add("show");
        eraseAt(event.clientX, event.clientY);
      } else {
        canvas.classList.add("drawing");
        activeStroke = addStroke({ id: makeId(), points: [roundedPoint(event.clientX, event.clientY)], width: PEN_WIDTHS[penLevel], saved: false, originalIndex: S.strokes.length });
        activeStroke.pointerId = event.pointerId;
      }
      return;
    }
    const blank = event.target === canvas;
    const wantsPan = event.button === 1 || (event.button === 0 && (blank || spaceHeld));
    if (wantsPan) {
      if (event.button === 1 || spaceHeld) event.preventDefault();
      if (blank) endEdit();
      panGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y, moved: false };
      canvas.setPointerCapture(event.pointerId);
    }
  });
  canvas.addEventListener("pointermove", function (event) {
    lastPt = { x: event.clientX, y: event.clientY };
    if (eraseGesture && event.pointerId === eraseGesture.pointerId) eraseAt(event.clientX, event.clientY);
    else if (panGesture && event.pointerId === panGesture.pointerId) {
      if (!panGesture.moved && Math.hypot(event.clientX - panGesture.x, event.clientY - panGesture.y) < 4) return;
      if (!panGesture.moved) { panGesture.moved = true; canvas.classList.add("panning"); }
      camera.x = coordinate(panGesture.cameraX + event.clientX - panGesture.x, camera.x);
      camera.y = coordinate(panGesture.cameraY + event.clientY - panGesture.y, camera.y);
      applyCamera(false);
    } else appendStrokePoints(event);
  });
  canvas.addEventListener("pointerup", function (event) { finishPan(event); finishStroke(event); finishErase(event); });
  canvas.addEventListener("pointercancel", function (event) { finishPan(event); finishStroke(event); finishErase(event); });
  canvas.addEventListener("dblclick", function (event) {
    if (event.button !== 0 || event.target !== canvas || performance.now() < suppressDoubleClickUntil) return;
    event.preventDefault();
    createAt(event.clientX, event.clientY);
  });
  canvas.addEventListener("contextmenu", function (event) { event.preventDefault(); });

  /* ================= MIT and tasks ================= */
  function growMit() {
    mitText.style.height = "auto";
    mitText.style.height = mitText.scrollHeight + "px";
  }
  function flushMit() {
    if (!mitDraft) return;
    clearTimeout(mitTimer);
    mitTimer = 0;
    const draft = mitDraft;
    mitDraft = null;
    commit(function (rootState) { ensureDay(rootState, draft.date).mit.text = draft.text; });
  }
  mitText.addEventListener("input", function () {
    growMit();
    mitDraft = { date: S.date, text: mitText.value.slice(0, 500) };
    clearTimeout(mitTimer);
    mitTimer = setTimeout(flushMit, 600);
  });
  mitText.addEventListener("blur", flushMit);
  mitText.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); mitText.blur(); }
  });
  mitDone.addEventListener("change", function () {
    flushMit();
    const checked = mitDone.checked;
    mitBox.classList.toggle("done", checked);
    commit(function (rootState) { ensureDay(rootState, S.date).mit.done = checked; });
  });

  function updateProgress() {
    const count = S.tasks.length;
    progress.textContent = count ? S.tasks.filter(function (task) { return task.done; }).length + "/" + count + " done" : "No tasks yet";
  }
  function renderTasks() {
    list.replaceChildren.apply(list, S.tasks.map(taskElement));
    updateProgress();
  }
  function taskElement(task) {
    const date = S.date;
    const item = document.createElement("li");
    item.className = "task" + (task.done ? " done" : "");
    item.dataset.id = task.id;
    item.innerHTML = '<span class="handle" title="Drag to reorder" aria-hidden="true">⠿</span><input type="checkbox" aria-label="Mark done"><input class="t-text" aria-label="Task"><button type="button" class="x" aria-label="Delete task" title="Delete">×</button>';
    const inputs = item.querySelectorAll("input");
    const checkbox = inputs[0];
    const text = inputs[1];
    checkbox.checked = task.done;
    text.value = task.text;
    checkbox.addEventListener("change", function () {
      task.done = checkbox.checked;
      item.classList.toggle("done", task.done);
      updateProgress();
      commit(function (rootState) {
        const tasks = ensureDay(rootState, date).tasks;
        let target = findById(tasks, task.id);
        if (!target) { target = clone(task); tasks.push(target); }
        target.done = task.done;
      });
    });
    text.addEventListener("input", function () {
      taskDraft = { id: task.id, date: date, text: text.value.slice(0, 500), originalIndex: S.tasks.indexOf(task), dirty: text.value !== task.text };
    });
    text.addEventListener("keydown", function (event) {
      if (event.key === "Enter") text.blur();
      else if (event.key === "Escape") { taskDraft = null; text.value = task.text; text.blur(); }
    });
    text.addEventListener("change", function () {
      const value = cleanText(text.value, 500, false);
      taskDraft = null;
      if (!value) { deleteTask(task, date); return; }
      task.text = text.value = value;
      commit(function (rootState) {
        const tasks = ensureDay(rootState, date).tasks;
        const index = indexById(tasks, task.id);
        if (index >= 0) tasks[index].text = value;
        else tasks.splice(clamp(S.tasks.indexOf(task), 0, tasks.length), 0, clone(task));
      });
    });
    text.addEventListener("blur", function () { setTimeout(adoptPendingIfIdle, 0); });
    item.querySelector(".x").addEventListener("click", function () { deleteTask(task, date); });
    const handle = item.querySelector(".handle");
    handle.addEventListener("mousedown", function () { item.draggable = true; });
    handle.addEventListener("mouseup", function () { item.draggable = false; });
    item.addEventListener("dragstart", function (event) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      item.classList.add("drag");
    });
    item.addEventListener("dragend", function () {
      item.draggable = false;
      item.classList.remove("drag");
      const ids = Array.from(list.children).map(function (node) { return node.dataset.id; });
      S.tasks.sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
      commit(function (rootState) {
        const tasks = ensureDay(rootState, date).tasks;
        const order = new Map(ids.map(function (id, index) { return [id, index]; }));
        tasks.sort(function (a, b) {
          const aOrder = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
          const bOrder = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
          return aOrder - bOrder;
        });
      });
    });
    return item;
  }
  function deleteTask(task, date) {
    const tasks = getDay(date).tasks || [];
    const index = indexById(tasks, task.id);
    const snapshot = index >= 0 ? clone(tasks[index]) : clone(task);
    const originalIndex = index >= 0 ? index : S.tasks.indexOf(task);
    taskDraft = null;
    S.tasks = S.tasks.filter(function (entry) { return entry.id !== task.id; });
    renderTasks();
    commit(function (rootState) {
      const target = ensureDay(rootState, date).tasks;
      const liveIndex = indexById(target, task.id);
      if (liveIndex >= 0) target.splice(liveIndex, 1);
    });
    offerToastUndo("Task deleted", function () {
      commit(function (rootState) {
        const target = ensureDay(rootState, date).tasks;
        if (indexById(target, snapshot.id) < 0) target.splice(clamp(originalIndex, 0, target.length), 0, snapshot);
      });
      if (date === S.date) {
        S.tasks = clone(getDay(date).tasks);
        renderTasks();
      }
    });
  }
  list.addEventListener("dragover", function (event) {
    const dragging = list.querySelector(".drag");
    if (!dragging) return;
    event.preventDefault();
    const next = Array.from(list.querySelectorAll(".task:not(.drag)")).find(function (item) {
      const rect = item.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    list.insertBefore(dragging, next || null);
  });
  addInput.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.isComposing) return;
    const text = cleanText(addInput.value, 500, false);
    if (!text) return;
    addInput.value = "";
    const date = S.date;
    const task = { id: makeId(), text: text, done: false };
    commit(function (rootState) { ensureDay(rootState, date).tasks.push(clone(task)); });
    if (date === S.date) { S.tasks.push(task); renderTasks(); }
  });
  $("#carry").addEventListener("click", function () {
    const date = S.date;
    let added = 0;
    commit(function (rootState) {
      const target = ensureDay(rootState, date).tasks;
      const existing = new Set(target.map(function (task) { return task.text; }));
      const previous = ensureDay(rootState, shift(date, -1)).tasks;
      previous.forEach(function (task) {
        if (!task.done && !existing.has(task.text)) {
          target.push({ id: makeId(), text: task.text, done: false });
          existing.add(task.text);
          added += 1;
        }
      });
    });
    S.tasks = clone(getDay(date).tasks);
    renderTasks();
    flash(added ? "Carried over " + added + " task" + (added > 1 ? "s" : "") : "Nothing to carry over");
  });

  const todo = $("#todo");
  const collapseButton = $("#collapse");
  collapseButton.addEventListener("click", function () {
    const collapsed = todo.classList.toggle("collapsed");
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    collapseButton.textContent = collapsed ? "+" : "–";
  });
  if (matchMedia("(max-width:760px)").matches) collapseButton.click();

  /* ================= rendering and navigation ================= */
  function paintCanvas() {
    if (editing) {
      editing = null;
      hideToolbar();
    }
    blocksLayer.replaceChildren();
    strokesLayer.replaceChildren();
    S.blocks.clear();
    S.strokes = [];
    const day = getDay(S.date);
    (day.strokes || []).forEach(function (stroke, index) { addStroke({ ...clone(stroke), saved: true, originalIndex: index }); });
    (day.blocks || []).forEach(function (block, index) { addBlock({ ...clone(block), saved: true, originalIndex: index }); });
  }
  function paintDay(date, resetHistory) {
    S.date = date;
    S.ready = false;
    document.body.classList.add("loading");
    if (resetHistory) histories.set(date, []);
    updateUndo();
    restoreCamera(date);
    dateInput.value = date;
    $("#today").disabled = date === today();
    const day = getDay(date);
    mitText.value = day.mit.text;
    mitDone.checked = day.mit.done;
    mitBox.classList.toggle("done", day.mit.done);
    growMit();
    S.tasks = clone(day.tasks || []);
    renderTasks();
    paintCanvas();
    S.ready = true;
    document.body.classList.remove("loading");
    setPenLevel(state.meta.penLevel, false);
    renderStorageStatus();
    refreshStatus();
  }
  function loadDay(date) {
    if (!isValidISO(date)) return;
    flushAll();
    history.replaceState(null, "", "#" + date);
    paintDay(date, true);
  }
  $("#prev").addEventListener("click", function () { loadDay(shift(S.date, -1)); });
  $("#next").addEventListener("click", function () { loadDay(shift(S.date, 1)); });
  $("#today").addEventListener("click", function () { loadDay(today()); });
  dateInput.addEventListener("change", function () {
    if (isValidISO(dateInput.value)) loadDay(dateInput.value);
    else dateInput.value = S.date;
  });

  /* ================= keyboard, lifecycle, and cross-tab adoption ================= */
  function isTyping() {
    const active = document.activeElement;
    return Boolean(active && (["INPUT", "TEXTAREA"].includes(active.tagName) || active.isContentEditable));
  }
  function hasUncommittedWork() {
    return Boolean(editing || taskDraft || mitDraft || activeStroke || eraseGesture || panGesture);
  }
  window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
      if (isTyping()) return;
      if (toastUndo) {
        event.preventDefault();
        $("#toast-undo").click();
        return;
      }
      event.preventDefault();
      undoCanvasAction();
      return;
    }
    if (event.code === "Space" && !isTyping()) {
      spaceHeld = true;
      canvas.classList.add("space-pan");
      event.preventDefault();
      return;
    }
    if (event.key.toLowerCase() === "e" && !isTyping() && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setEraser(!eraserEnabled);
      return;
    }
    if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey && (document.activeElement === document.body || document.activeElement === canvas)) {
      event.preventDefault();
      createAt(lastPt.x, lastPt.y);
    }
  });
  window.addEventListener("keyup", function (event) {
    if (event.code === "Space") { spaceHeld = false; canvas.classList.remove("space-pan"); }
  });
  window.addEventListener("blur", function () {
    spaceHeld = false;
    canvas.classList.remove("space-pan");
    finishPan();
    finishStroke();
    finishErase();
  });
  window.addEventListener("beforeunload", function (event) {
    if (!hasUncommittedWork()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  function flushAll() {
    endEdit();
    if (taskDraft) {
      const input = list.querySelector('.task[data-id="' + cssEscape(taskDraft.id) + '"] .t-text');
      if (input) input.blur();
    }
    finishStroke();
    finishErase();
    finishPan();
    flushMit();
    flushCamera();
  }
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", function () { if (document.hidden) flushAll(); });
  window.addEventListener("resize", function () { if (editing) showToolbar(editing); });

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY) return;
    let incoming;
    try {
      incoming = event.newValue ? sanitizeState(JSON.parse(event.newValue)) : emptyState();
      migrateLegacyCoordinates(incoming);
    } catch (_) { return; }
    const comparison = pendingExternalState || state;
    if ((Date.parse(incoming.meta.updatedAt) || 0) < (Date.parse(comparison.meta.updatedAt) || 0)) return;
    if (hasUncommittedWork()) {
      pendingExternalState = incoming;
      flash("Other-tab changes waiting for this edit", 3500);
    } else {
      state = incoming;
      applyTheme();
      paintDay(S.date || today(), false);
      announce("Changes from another tab were loaded");
    }
  });

  /* ================= start ================= */
  applyTheme();
  setPenLevel(state.meta.penLevel, false);
  renderStorageStatus();
  refreshStatus();
  const hashDate = decodeURIComponent(location.hash.slice(1));
  paintDay(isValidISO(hashDate) ? hashDate : today(), true);
}());
