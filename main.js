const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const {
  startCaptionServer,
  stopCaptionServer,
} = require("./caption-server");

const DEFAULT_PORT = Number(process.env.CAPTION_PORT) || 4153;
const SER_SERVICE_PORT = Number(process.env.SER_SERVICE_PORT) || 4163;
const OVERLAY_HEIGHT = 160;
const CONTROL_SIZE = { width: 420, height: 620 };
const RHYTHM_SAMPLE_SIZE = 20;
const INTERRUPTION_WINDOW_MS = 1400;
const SER_REQUEST_TIMEOUT_MS = 1500;
const EMOTION_MODEL_URL =
  "https://api-inference.huggingface.co/models/j-hartmann/emotion-english-distilroberta-base";
const EMOTION_REQUEST_TIMEOUT_MS = 10000;

let overlayWindow = null;
let controlWindow = null;
let overlayPinInterval = null;
let serServiceProcess = null;
let captionServerState = {
  running: false,
  port: DEFAULT_PORT,
};
let serServiceState = {
  running: false,
  port: SER_SERVICE_PORT,
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
const emotionResultCache = new Map();
let captionDispatchChain = Promise.resolve();
let lastCaptionTimestamp = 0;
let latestLiveRhythm = {
  samples: new Array(RHYTHM_SAMPLE_SIZE).fill(0),
  volume: 0,
  interruption: 0,
  active: false,
  timestamp: Date.now(),
  source: "derived",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRhythmSamples(samples = []) {
  const normalized = Array.isArray(samples)
    ? samples
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => clamp(value, 0, 1))
    : [];

  if (!normalized.length) {
    return [];
  }

  if (normalized.length <= RHYTHM_SAMPLE_SIZE) {
    return normalized;
  }

  const compacted = [];
  const stride = normalized.length / RHYTHM_SAMPLE_SIZE;
  for (let index = 0; index < RHYTHM_SAMPLE_SIZE; index += 1) {
    const sampleIndex = Math.min(normalized.length - 1, Math.floor(index * stride));
    compacted.push(normalized[sampleIndex]);
  }
  return compacted;
}

function normalizeWaveformSamples(samples = []) {
  const normalized = Array.isArray(samples)
    ? samples
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => clamp(value, -1, 1))
        .slice(-4096)
    : [];

  return normalized;
}

function normalizeProsody(prosody = {}) {
  if (!prosody || typeof prosody !== "object") {
    return {};
  }

  const pitchHz = Number(prosody.pitchHz);
  const pitchMean = Number(prosody.pitchMean);
  const pitchRange = Number(prosody.pitchRange);
  const voicedRatio = Number(prosody.voicedRatio);

  return {
    ...(Number.isFinite(pitchHz) ? { pitchHz: clamp(pitchHz, 50, 500) } : {}),
    ...(Number.isFinite(pitchMean) ? { pitchMean: clamp(pitchMean, 50, 500) } : {}),
    ...(Number.isFinite(pitchRange) ? { pitchRange: clamp(pitchRange, 0, 1) } : {}),
    ...(Number.isFinite(voicedRatio) ? { voicedRatio: clamp(voicedRatio, 0, 1) } : {}),
  };
}

function buildFallbackRhythmSamples(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [0.18, 0.15, 0.2, 0.17, 0.14, 0.16];
  }

  const emphasisBoost = /[!?]/.test(normalized) ? 0.18 : 0;
  const uppercaseBoost = /[A-Z]{3,}/.test(normalized) ? 0.16 : 0;
  const urgencyBoost = /(urgent|stop|now|wait|please|listen)/i.test(normalized) ? 0.14 : 0;
  const lengthBoost = clamp(normalized.length / 180, 0.05, 0.24);
  const base = clamp(0.2 + emphasisBoost + uppercaseBoost + urgencyBoost + lengthBoost, 0.16, 0.88);

  return Array.from({ length: RHYTHM_SAMPLE_SIZE }, (_value, index) => {
    const wave = Math.sin((index / Math.max(1, RHYTHM_SAMPLE_SIZE - 1)) * Math.PI * 2.2) * 0.12;
    const jitter = ((index % 4) - 1.5) * 0.025;
    return clamp(base + wave + jitter, 0.08, 0.96);
  });
}

function deriveRhythm(payload, text, timestamp) {
  const payloadRhythm = payload && typeof payload.rhythm === "object" ? payload.rhythm : {};
  const samples = normalizeRhythmSamples(payloadRhythm.samples);
  const waveform = normalizeWaveformSamples(payloadRhythm.waveform);
  const sampleRate = Number(payloadRhythm.sampleRate);
  const prosody = normalizeProsody(payloadRhythm.prosody);
  const rhythmSamples = samples.length ? samples : buildFallbackRhythmSamples(text);
  const averageVolume =
    rhythmSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, rhythmSamples.length);
  const explicitVolume = Number(payloadRhythm.volume);
  const volume = Number.isFinite(explicitVolume) ? clamp(explicitVolume, 0, 1) : clamp(averageVolume, 0, 1);
  const gap = lastCaptionTimestamp > 0 ? timestamp - lastCaptionTimestamp : Number.POSITIVE_INFINITY;
  const derivedInterruption = gap < INTERRUPTION_WINDOW_MS ? clamp(1 - gap / INTERRUPTION_WINDOW_MS, 0, 1) : 0;
  const explicitInterruption = Number(payloadRhythm.interruption);
  const interruption = Number.isFinite(explicitInterruption)
    ? clamp(explicitInterruption, 0, 1)
    : derivedInterruption;

  lastCaptionTimestamp = timestamp;

  return {
    samples: rhythmSamples,
    ...(waveform.length ? { waveform } : {}),
    ...(Number.isFinite(sampleRate) ? { sampleRate } : {}),
    volume,
    interruption,
    ...(Object.keys(prosody).length ? { prosody } : {}),
    source: samples.length ? payloadRhythm.source || "audio" : "derived",
  };
}

function normalizeLiveRhythm(payload = {}) {
  const samples = normalizeRhythmSamples(payload.samples);
  const prosody = normalizeProsody(payload.prosody);
  const explicitVolume = Number(payload.volume);
  const volume = Number.isFinite(explicitVolume)
    ? clamp(explicitVolume, 0, 1)
    : samples.length
      ? clamp(samples.reduce((sum, value) => sum + value, 0) / samples.length, 0, 1)
      : 0;
  const explicitInterruption = Number(payload.interruption);

  return {
    samples: samples.length ? samples : new Array(RHYTHM_SAMPLE_SIZE).fill(0),
    volume,
    interruption: Number.isFinite(explicitInterruption) ? clamp(explicitInterruption, 0, 1) : 0,
    ...(Object.keys(prosody).length ? { prosody } : {}),
    active: Boolean(payload.active || volume > 0.025),
    timestamp: Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now(),
    source: typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : "audio",
  };
}

function broadcastLiveRhythm(payload = {}) {
  latestLiveRhythm = normalizeLiveRhythm(payload);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("rhythm:live", latestLiveRhythm);
  }
}

function stripRuntimeRhythm(rhythm = {}) {
  const { waveform, sampleRate, ...rest } = rhythm || {};
  return rest;
}

function startSerService() {
  if (serServiceProcess) {
    return;
  }

  const serverPath = path.join(__dirname, "ser_backend", "server.py");
  const venvPython = path.join(__dirname, ".venv", "bin", "python");
  const pythonBinary = fs.existsSync(venvPython) ? venvPython : "python3";

  serServiceProcess = spawn(pythonBinary, [serverPath, "--port", String(SER_SERVICE_PORT)], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serServiceState = {
    running: true,
    port: SER_SERVICE_PORT,
  };

  if (serServiceProcess.stdout) {
    serServiceProcess.stdout.on("data", (chunk) => {
      process.stdout.write(`[ser] ${chunk}`);
    });
  }

  if (serServiceProcess.stderr) {
    serServiceProcess.stderr.on("data", (chunk) => {
      process.stderr.write(`[ser] ${chunk}`);
    });
  }

  serServiceProcess.on("exit", () => {
    serServiceProcess = null;
    serServiceState = {
      running: false,
      port: SER_SERVICE_PORT,
    };
  });
}

function stopSerService() {
  if (!serServiceProcess) {
    return;
  }

  serServiceProcess.kill();
  serServiceProcess = null;
  serServiceState = {
    running: false,
    port: SER_SERVICE_PORT,
  };
}

async function detectAudioEmotionViaSerService(rhythm = {}) {
  if (!serServiceState.running) {
    return null;
  }

  if (!Array.isArray(rhythm.waveform) || !rhythm.waveform.length) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${SER_SERVICE_PORT}/infer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rhythm: {
          waveform: rhythm.waveform,
          sampleRate: rhythm.sampleRate || 16000,
          volume: rhythm.volume || 0,
          interruption: rhythm.interruption || 0,
          prosody: rhythm.prosody || {},
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`SER service request failed with ${response.status}`);
    }

    const data = await response.json();
    return data && data.result ? data.result : null;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function emitEmotionDebug(payload) {
  const debugPayload = {
    ...payload,
    timestamp: Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now(),
  };
  const consolePayload = {
    textResult: debugPayload.textResult || null,
    audioResult: debugPayload.audioResult || null,
    fusedResult: debugPayload.fusedResult || null,
    fusionReason: debugPayload.fusionReason || null,
  };

  try {
    console.log(JSON.stringify(consolePayload));
  } catch (_error) {
    console.log(consolePayload);
  }

  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("emotion:debug", debugPayload);
  }
}

function openInGoogleChrome(url) {
  const fallback = () => shell.openExternal(url);

  try {
    if (process.platform === "darwin") {
      execFile("open", ["-a", "Google Chrome", url], (error) => {
        if (error) {
          fallback();
        }
      });
      return;
    }

    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", "chrome", url], (error) => {
        if (error) {
          fallback();
        }
      });
      return;
    }

    execFile("google-chrome", [url], (error) => {
      if (error) {
        execFile("chromium-browser", [url], (nestedError) => {
          if (nestedError) {
            fallback();
          }
        });
      }
    });
  } catch (_error) {
    fallback();
  }
}

function inferEmotionLabel(text) {
  const normalized = String(text || "").toLowerCase();

  if (/(great|happy|glad|love|thanks|wonderful|nice|good news|smile)/.test(normalized)) {
    return "joy";
  }

  if (/(sorry|sad|difficult|hard|unfortunately|upset|miss|hurt|tired|loss)/.test(normalized)) {
    return "sadness";
  }

  if (/(stop|angry|mad|urgent|problem|wrong|frustrat|serious|now)/.test(normalized)) {
    return "anger";
  }

  if (/(calm|steady|okay|breathe|slow|gentle|relax|safe|fine)/.test(normalized)) {
    return "neutral";
  }

  if (/(amazing|wow|excited|awesome|yes!|let's go|incredible|fantastic)/.test(normalized)) {
    return "surprise";
  }

  return "neutral";
}

function inferTextSignals(text) {
  const normalized = String(text || "").toLowerCase();

  return {
    positive: /(great|happy|glad|love|thanks|wonderful|nice|good news|smile|amazing|awesome)/.test(normalized),
    sad: /(sorry|sad|difficult|hard|unfortunately|upset|miss|hurt|tired|loss)/.test(normalized),
    urgent: /(stop|angry|mad|urgent|problem|wrong|frustrat|serious|now|immediately)/.test(normalized),
    calm: /(calm|steady|okay|breathe|slow|gentle|relax|safe|fine|no worries)/.test(normalized),
    celebratory: /(excited|wow|yes!|let's go|incredible|fantastic|celebrate)/.test(normalized),
  };
}

function mapModelEmotionToOverlayEmotion(label) {
  switch (label) {
    case "joy":
      return "happy";
    case "sadness":
      return "sad";
    case "anger":
    case "disgust":
      return "angry";
    case "fear":
      return "sad";
    case "surprise":
      return "excited";
    case "neutral":
    default:
      return "neutral";
  }
}

function normalizeInferenceResponse(payload) {
  if (Array.isArray(payload) && Array.isArray(payload[0])) {
    return payload[0];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

async function detectTextEmotion(text) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return {
      label: "neutral",
      emotion: "neutral",
      source: "fallback",
      score: null,
    };
  }

  const cacheKey = normalizedText.toLowerCase();
  if (emotionResultCache.has(cacheKey)) {
    return emotionResultCache.get(cacheKey);
  }

  const fallbackLabel = inferEmotionLabel(normalizedText);
  const fallbackResult = {
    label: fallbackLabel,
    emotion: mapModelEmotionToOverlayEmotion(fallbackLabel),
    source: "fallback",
    score: null,
  };

  if (typeof fetch !== "function") {
    emotionResultCache.set(cacheKey, fallbackResult);
    return fallbackResult;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMOTION_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(EMOTION_MODEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: normalizedText,
        options: {
          wait_for_model: true,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Emotion model request failed with ${response.status}`);
    }

    const data = await response.json();
    const scores = normalizeInferenceResponse(data)
      .filter((entry) => entry && typeof entry.label === "string" && Number.isFinite(entry.score))
      .sort((left, right) => right.score - left.score);

    const topMatch = scores[0];
    if (!topMatch) {
      emotionResultCache.set(cacheKey, fallbackResult);
      return fallbackResult;
    }

    const result = {
      label: topMatch.label,
      emotion: mapModelEmotionToOverlayEmotion(topMatch.label),
      source: "model",
      score: topMatch.score,
    };
    emotionResultCache.set(cacheKey, result);
    return result;
  } catch (error) {
    emotionResultCache.set(cacheKey, fallbackResult);
    return fallbackResult;
  } finally {
    clearTimeout(timeoutId);
  }
}

function detectAudioEmotion(text, rhythm = {}) {
  if (!rhythm || typeof rhythm !== "object") {
    return null;
  }

  const prosody = rhythm.prosody && typeof rhythm.prosody === "object" ? rhythm.prosody : {};
  const signals = inferTextSignals(text);
  const volume = clamp(Number(rhythm.volume) || 0, 0, 1);
  const interruption = clamp(Number(rhythm.interruption) || 0, 0, 1);
  const pitchMean = Number(prosody.pitchMean);
  const pitchRange = clamp(Number(prosody.pitchRange) || 0, 0, 1);
  const voicedRatio = clamp(Number(prosody.voicedRatio) || 0, 0, 1);
  const pitchMeanNorm = Number.isFinite(pitchMean) ? clamp((pitchMean - 100) / 180, 0, 1) : 0;
  const arousal = clamp(
    volume * 0.42 + interruption * 0.22 + pitchRange * 0.24 + pitchMeanNorm * 0.08 + voicedRatio * 0.04,
    0,
    1
  );

  if (arousal < 0.14 && pitchRange < 0.05 && !signals.sad && !signals.calm) {
    return null;
  }

  let emotion = "neutral";

  if (arousal >= 0.68) {
    if (signals.urgent || interruption >= 0.38) {
      emotion = "angry";
    } else if (signals.positive || signals.celebratory || pitchRange >= 0.2 || pitchMeanNorm >= 0.5) {
      emotion = "excited";
    } else {
      emotion = "excited";
    }
  } else if (arousal >= 0.42) {
    if (signals.urgent) {
      emotion = "angry";
    } else if (signals.positive) {
      emotion = "happy";
    } else if (signals.calm) {
      emotion = "calm";
    } else if (pitchRange < 0.09 && interruption < 0.16) {
      emotion = "calm";
    }
  } else {
    if (signals.sad || (volume < 0.18 && pitchRange < 0.08 && pitchMeanNorm < 0.42)) {
      emotion = "sad";
    } else if (signals.calm || (interruption < 0.12 && pitchRange < 0.1 && voicedRatio >= 0.35)) {
      emotion = "calm";
    }
  }

  return {
    label: emotion,
    emotion,
    source: "audio-heuristic",
    score: arousal,
    arousal,
  };
}

function fuseEmotionDetections(textResult, audioResult) {
  if (!audioResult) {
    return {
      result: textResult,
      reason: "audio unavailable or below threshold",
    };
  }

  if (!textResult) {
    return {
      result: audioResult,
      reason: "text unavailable",
    };
  }

  if (textResult.emotion === audioResult.emotion) {
    return {
      result: {
        ...textResult,
        source: `${textResult.source}+audio`,
        score: Math.max(Number(textResult.score) || 0, Number(audioResult.score) || 0),
      },
      reason: "text and audio agree",
    };
  }

  if (textResult.source === "fallback") {
    if (textResult.emotion === "neutral" && audioResult.emotion !== "neutral") {
      return {
        result: audioResult,
        reason: "audio overrides fallback neutral text",
      };
    }

    if (audioResult.score >= 0.72) {
      return {
        result: audioResult,
        reason: "strong audio overrides fallback text",
      };
    }
  }

  if (textResult.emotion === "happy" && audioResult.emotion === "excited" && audioResult.arousal >= 0.62) {
    return {
      result: audioResult,
      reason: "audio upgrades happy to excited",
    };
  }

  if (textResult.emotion === "neutral" && ["calm", "sad", "angry", "excited"].includes(audioResult.emotion)) {
    return {
      result: audioResult,
      reason: "audio overrides neutral text",
    };
  }

  if (audioResult.emotion === "angry" && audioResult.arousal >= 0.8) {
    return {
      result: audioResult,
      reason: "very strong angry audio override",
    };
  }

  return {
    result: textResult,
    reason: "text kept after fusion",
  };
}

async function detectEmotion(text, rhythm = {}) {
  const textResult = await detectTextEmotion(text);
  const serviceAudioResult = await detectAudioEmotionViaSerService(rhythm);
  const audioResult = serviceAudioResult || detectAudioEmotion(text, rhythm);
  const fused = fuseEmotionDetections(textResult, audioResult);

  return {
    result: fused.result,
    debug: {
      text,
      rhythm: stripRuntimeRhythm(rhythm),
      textResult,
      audioResult,
      fusedResult: fused.result,
      fusionReason: fused.reason,
    },
  };
}

async function normalizeCaption(payload = {}) {
  const text = String(payload.text || "").trim();
  if (!text) {
    return null;
  }

  const numericSeq = Number(payload.seq);
  const seq = Number.isFinite(numericSeq) ? numericSeq : nextInjectedSeq++;
  const timestamp = Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now();
  const rawRhythm = deriveRhythm(payload, text, timestamp);
  let debugPayload = null;
  const detected = payload.detectedEmotion
    ? {
        label: String(payload.detectedEmotion).trim().toLowerCase(),
        emotion: payload.emotion || mapModelEmotionToOverlayEmotion(String(payload.detectedEmotion).trim().toLowerCase()),
        source: payload.emotionSource || "provided",
        score: Number.isFinite(Number(payload.emotionScore)) ? Number(payload.emotionScore) : null,
      }
    : ((result) => {
        debugPayload = result.debug;
        return result.result;
      })(await detectEmotion(text, rawRhythm));

  if (debugPayload) {
    emitEmotionDebug({
      seq,
      timestamp,
      source: payload.source || "http",
      ...debugPayload,
    });
  }

  return {
    seq,
    lang: typeof payload.lang === "string" && payload.lang.trim() ? payload.lang.trim() : "en",
    text,
    timestamp,
    emotion: payload.emotion || detected.emotion,
    detectedEmotion: detected.label,
    emotionScore: detected.score,
    emotionSource: detected.source,
    rhythm: stripRuntimeRhythm(rawRhythm),
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

async function broadcastCaption(data) {
  captionDispatchChain = captionDispatchChain
    .then(async () => {
      const caption = await normalizeCaption(data);
      if (!caption) {
        return;
      }

      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("caption:new", caption);
      }
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send("caption:new", caption);
      }
    })
    .catch(() => {});

  return captionDispatchChain;
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
    overlayWindow.webContents.send("rhythm:live", latestLiveRhythm);
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

  ipcMain.on("rhythm:update", (_event, payload = {}) => {
    broadcastLiveRhythm(payload);
  });

  ipcMain.on("caption:clear", () => {
    lastCaptionTimestamp = 0;
    latestLiveRhythm = normalizeLiveRhythm({});
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("caption:clear");
      overlayWindow.webContents.send("rhythm:live", latestLiveRhythm);
    }
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send("caption:clear");
    }
  });

  ipcMain.on("speech:openCapture", () => {
    openInGoogleChrome(`http://127.0.0.1:${captionServerState.port}/speech-capture`);
  });

  ipcMain.handle("server:getPort", () => captionServerState.port);
  ipcMain.handle("server:getStatus", () => ({
    running: captionServerState.running,
    port: captionServerState.port,
    serRunning: serServiceState.running,
    serPort: serServiceState.port,
  }));
}

async function bootstrap() {
  startSerService();
  createOverlayWindow();
  createControlWindow();
  registerIpc();

  try {
    await startCaptionServer(DEFAULT_PORT, broadcastCaption, broadcastLiveRhythm);
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
  stopSerService();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
