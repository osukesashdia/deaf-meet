const path = require("path");
const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const {
  startCaptionServer,
  stopCaptionServer,
} = require("./caption-server");

const DEFAULT_PORT = Number(process.env.CAPTION_PORT) || 4153;
const OVERLAY_HEIGHT = 160;
const CONTROL_SIZE = { width: 420, height: 620 };

let overlayWindow = null;
let controlWindow = null;
let overlayPinInterval = null;
let captionServerState = {
  running: false,
  port: DEFAULT_PORT,
};

const overlaySettings = {
  theme: "dark",
  fontSize: 26,
  maxLines: 2,
  position: "bottom",
  overlayVisible: true,
  panelWidth: 1120,
  panelHeight: 240,
  panelOffsetX: 0,
  panelOffsetY: 0,
  editMode: false,
};

let nextInjectedSeq = 1;

function inferEmotion(text) {
  const normalized = String(text || "").toLowerCase();

  if (/(great|happy|glad|love|thanks|wonderful|nice|good news|smile)/.test(normalized)) {
    return "happy";
  }

  if (/(sorry|sad|difficult|hard|unfortunately|upset|miss|hurt|tired|loss)/.test(normalized)) {
    return "sad";
  }

  if (/(stop|angry|mad|urgent|problem|wrong|frustrat|serious|now)/.test(normalized)) {
    return "angry";
  }

  if (/(calm|steady|okay|breathe|slow|gentle|relax|safe|fine)/.test(normalized)) {
    return "calm";
  }

  if (/(amazing|wow|excited|awesome|yes!|let's go|incredible|fantastic)/.test(normalized)) {
    return "excited";
  }

  return "neutral";
}

function normalizeCaption(payload = {}) {
  const text = String(payload.text || "").trim();
  if (!text) {
    return null;
  }

  const seq = Number(payload.seq);

  return {
    seq: Number.isFinite(seq) ? seq : nextInjectedSeq++,
    lang: typeof payload.lang === "string" && payload.lang.trim() ? payload.lang.trim() : "en",
    text,
    timestamp: Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now(),
    emotion: payload.emotion || inferEmotion(text),
    source: payload.source || "http",
    ...(payload.simulated ? { simulated: true } : {}),
  };
}

function getOverlayBounds(position = overlaySettings.position) {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const overlayHeight = Math.max(180, Math.min(height, overlaySettings.panelHeight + 120));

  if (position === "top") {
    return { x, y, width, height: overlayHeight };
  }

  if (position === "middle") {
    return {
      x,
      y: y + Math.round((height - overlayHeight) / 2),
      width,
      height: overlayHeight,
    };
  }

  return {
    x,
    y: y + height - overlayHeight,
    width,
    height: overlayHeight,
  };
}

function sendSettingsUpdate() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("settings:update", {
      theme: overlaySettings.theme,
      fontSize: overlaySettings.fontSize,
      maxLines: overlaySettings.maxLines,
      position: overlaySettings.position,
      panelWidth: overlaySettings.panelWidth,
      panelHeight: overlaySettings.panelHeight,
      panelOffsetX: overlaySettings.panelOffsetX,
      panelOffsetY: overlaySettings.panelOffsetY,
      editMode: overlaySettings.editMode,
    });
  }
}

function syncOverlayInteractionMode() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  if (overlaySettings.editMode) {
    overlayWindow.setIgnoreMouseEvents(false);
    overlayWindow.setFocusable(true);
    overlayWindow.focus();
  } else {
    overlayWindow.setFocusable(false);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function applyOverlayPosition(position) {
  overlaySettings.position = position;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setBounds(getOverlayBounds(position));
  }
  sendSettingsUpdate();
}

function broadcastCaption(data) {
  const caption = normalizeCaption(data);
  if (!caption) {
    return;
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("caption:new", caption);
  }
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("caption:new", caption);
  }
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    ...getOverlayBounds(),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, "renderer", "overlay.html"));

  overlayWindow.webContents.on("did-finish-load", () => {
    sendSettingsUpdate();
  });

  overlayPinInterval = setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
    }
  }, 2000);
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: CONTROL_SIZE.width,
    height: CONTROL_SIZE.height,
    minWidth: CONTROL_SIZE.width,
    minHeight: CONTROL_SIZE.height,
    frame: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  controlWindow.loadFile(path.join(__dirname, "renderer", "control.html"));
  controlWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      controlWindow.hide();
    }
  });
}

function registerIpc() {
  ipcMain.on("overlay:toggle", () => {
    overlaySettings.overlayVisible = !overlaySettings.overlayVisible;
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    if (overlaySettings.overlayVisible) {
      overlayWindow.showInactive();
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
    } else {
      overlayWindow.hide();
    }
  });

  ipcMain.on("overlay:reposition", (_event, position) => {
    if (["top", "middle", "bottom"].includes(position)) {
      applyOverlayPosition(position);
    }
  });

  ipcMain.on("overlay:settings", (_event, nextSettings = {}) => {
    if (typeof nextSettings.theme === "string") {
      overlaySettings.theme = nextSettings.theme;
    }

    if (Number.isFinite(Number(nextSettings.fontSize))) {
      overlaySettings.fontSize = Math.max(14, Math.min(40, Number(nextSettings.fontSize)));
    }

    if (Number.isFinite(Number(nextSettings.maxLines))) {
      overlaySettings.maxLines = Math.max(1, Math.min(3, Number(nextSettings.maxLines)));
    }

    if (Number.isFinite(Number(nextSettings.panelWidth))) {
      overlaySettings.panelWidth = Math.max(420, Math.min(1400, Number(nextSettings.panelWidth)));
    }

    if (Number.isFinite(Number(nextSettings.panelHeight))) {
      overlaySettings.panelHeight = Math.max(120, Math.min(520, Number(nextSettings.panelHeight)));
    }

    if (Number.isFinite(Number(nextSettings.panelOffsetX))) {
      overlaySettings.panelOffsetX = Math.max(-600, Math.min(600, Number(nextSettings.panelOffsetX)));
    }

    if (Number.isFinite(Number(nextSettings.panelOffsetY))) {
      overlaySettings.panelOffsetY = Math.max(-220, Math.min(220, Number(nextSettings.panelOffsetY)));
    }

    if (typeof nextSettings.editMode === "boolean") {
      overlaySettings.editMode = nextSettings.editMode;
      syncOverlayInteractionMode();
    }

    if (Number.isFinite(Number(nextSettings.panelWidth)) || Number.isFinite(Number(nextSettings.panelHeight))) {
      applyOverlayPosition(overlaySettings.position);
      return;
    }

    if (typeof nextSettings.position === "string") {
      applyOverlayPosition(nextSettings.position);
      return;
    }

    sendSettingsUpdate();
  });

  ipcMain.on("caption:inject", (_event, payload = {}) => {
    broadcastCaption({
      ...payload,
      source: payload.source || "speech",
    });
  });

  ipcMain.on("caption:clear", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("caption:clear");
    }
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send("caption:clear");
    }
  });

  ipcMain.on("speech:openCapture", () => {
    shell.openExternal(`http://127.0.0.1:${captionServerState.port}/speech-capture`);
  });

  ipcMain.handle("server:getPort", () => captionServerState.port);
  ipcMain.handle("server:getStatus", () => ({
    running: captionServerState.running,
    port: captionServerState.port,
  }));
}

async function bootstrap() {
  createOverlayWindow();
  createControlWindow();
  registerIpc();

  try {
    await startCaptionServer(DEFAULT_PORT, broadcastCaption);
    captionServerState = {
      running: true,
      port: DEFAULT_PORT,
    };
  } catch (error) {
    captionServerState = {
      running: false,
      port: DEFAULT_PORT,
    };
  }
}

app.whenReady().then(bootstrap);

app.on("activate", () => {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (overlayPinInterval) {
    clearInterval(overlayPinInterval);
  }
  stopCaptionServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
