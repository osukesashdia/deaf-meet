const http = require("http");
const { URL } = require("url");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const HISTORY_LIMIT = 200;
const SPEECH_CAPTURE_PATH = path.join(__dirname, "renderer", "speech-capture.html");

let server = null;
let captionHistory = [];
let currentPort = null;
let captionHandler = null;
let rhythmHandler = null;
let nextSimulatedSeq = 1;

function addToHistory(entry) {
  captionHistory.push(entry);
  if (captionHistory.length > HISTORY_LIMIT) {
    captionHistory.shift();
  }
}

function getHistory() {
  return captionHistory.slice();
}

function getStatus() {
  return {
    running: Boolean(server),
    port: currentPort,
    historyCount: captionHistory.length,
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function parseBody(request, body) {
  const contentType = request.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    if (!body.trim()) {
      return {};
    }
    return JSON.parse(body);
  }

  return querystring.parse(body);
}

function normalizeRhythm(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const samples = Array.isArray(value.samples)
    ? value.samples
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry))
    : [];
  const volume = Number(value.volume);
  const interruption = Number(value.interruption);
  const prosody = value.prosody && typeof value.prosody === "object" ? value.prosody : {};
  const pitchHz = Number(prosody.pitchHz);
  const pitchMean = Number(prosody.pitchMean);
  const pitchRange = Number(prosody.pitchRange);
  const voicedRatio = Number(prosody.voicedRatio);

  return {
    ...(samples.length ? { samples } : {}),
    ...(Number.isFinite(volume) ? { volume } : {}),
    ...(Number.isFinite(interruption) ? { interruption } : {}),
    ...(
      Number.isFinite(pitchHz) ||
      Number.isFinite(pitchMean) ||
      Number.isFinite(pitchRange) ||
      Number.isFinite(voicedRatio)
        ? {
            prosody: {
              ...(Number.isFinite(pitchHz) ? { pitchHz } : {}),
              ...(Number.isFinite(pitchMean) ? { pitchMean } : {}),
              ...(Number.isFinite(pitchRange) ? { pitchRange } : {}),
              ...(Number.isFinite(voicedRatio) ? { voicedRatio } : {}),
            },
          }
        : {}
    ),
    ...(typeof value.source === "string" && value.source.trim() ? { source: value.source.trim() } : {}),
  };
}

function createCaptionData({ seq, lang, text, simulated = false, rhythm }) {
  const normalizedRhythm = normalizeRhythm(rhythm);
  return {
    seq: Number.isFinite(Number(seq)) ? Number(seq) : nextSimulatedSeq++,
    lang: typeof lang === "string" && lang.trim() ? lang.trim() : "en",
    text: text.trim(),
    timestamp: Date.now(),
    ...(normalizedRhythm && Object.keys(normalizedRhythm).length ? { rhythm: normalizedRhythm } : {}),
    ...(simulated ? { simulated: true } : {}),
  };
}

async function handleCaption(request, response, parsedUrl) {
  const rawBody = await readRequestBody(request);
  const body = parseBody(request, rawBody);
  const text = typeof body.text === "string" ? body.text : "";

  if (!text.trim()) {
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }

  const caption = createCaptionData({
    seq: body.seq,
    lang: body.lang,
    text,
    rhythm: body.rhythm,
  });

  addToHistory(caption);
  if (typeof captionHandler === "function") {
    captionHandler(caption);
  }

  sendJson(response, 200, { ok: true });
}

async function handleSimulate(request, response) {
  const rawBody = await readRequestBody(request);
  const body = parseBody(request, rawBody);
  const text = typeof body.text === "string" ? body.text : "";

  if (!text.trim()) {
    sendJson(response, 400, {
      ok: false,
      error: "Simulation text is required",
    });
    return;
  }

  const caption = createCaptionData({
    seq: body.seq,
    lang: body.lang,
    text,
    simulated: true,
    rhythm: body.rhythm,
  });

  addToHistory(caption);
  if (typeof captionHandler === "function") {
    captionHandler(caption);
  }

  sendJson(response, 200, { ok: true, caption });
}

async function handleRhythm(request, response) {
  const rawBody = await readRequestBody(request);
  const body = parseBody(request, rawBody);
  const rhythm = normalizeRhythm(body.rhythm || body);

  if (!rhythm || !Object.keys(rhythm).length) {
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }

  if (typeof rhythmHandler === "function") {
    rhythmHandler({
      ...rhythm,
      active: body.active === true || body.active === "true" || Number(rhythm.volume) > 0.025,
      timestamp: Date.now(),
    });
  }

  sendJson(response, 200, { ok: true });
}

async function routeRequest(request, response) {
  const parsedUrl = new URL(request.url, `http://${HOST}:${currentPort || 0}`);

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && parsedUrl.pathname === "/status") {
      sendJson(response, 200, getStatus());
      return;
    }

    if (request.method === "GET" && parsedUrl.pathname === "/speech-capture") {
      sendHtml(response, 200, fs.readFileSync(SPEECH_CAPTURE_PATH, "utf8"));
      return;
    }

    if (request.method === "GET" && parsedUrl.pathname === "/history") {
      sendJson(response, 200, getHistory());
      return;
    }

    if (request.method === "POST" && parsedUrl.pathname === "/caption") {
      await handleCaption(request, response, parsedUrl);
      return;
    }

    if (request.method === "POST" && parsedUrl.pathname === "/simulate") {
      await handleSimulate(request, response);
      return;
    }

    if (request.method === "POST" && parsedUrl.pathname === "/rhythm") {
      await handleRhythm(request, response);
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message || "Internal server error",
    });
  }
}

function startCaptionServer(port, onCaption, onRhythm) {
  if (server) {
    return Promise.resolve({ running: true, port: currentPort });
  }

  captionHandler = onCaption;
  rhythmHandler = onRhythm;
  currentPort = port;

  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      routeRequest(request, response);
    });

    server.on("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        console.error(
          `Caption server could not start: port ${port} is already in use. Set CAPTION_PORT to another port and restart.`
        );
      }
      server = null;
      reject(error);
    });

    server.listen(port, HOST, () => {
      resolve({ running: true, port });
    });
  });
}

function stopCaptionServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(() => {
      server = null;
      currentPort = null;
      resolve();
    });
  });
}

module.exports = {
  startCaptionServer,
  stopCaptionServer,
  getHistory,
  getStatus,
};
