#!/usr/bin/env python3
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pipeline import AudioSERPipeline, clamp


pipeline = AudioSERPipeline()


def normalize_waveform(values, limit=4096):
    normalized = []
    if isinstance(values, list):
        for value in values[-limit:]:
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                continue
            normalized.append(clamp(numeric, -1.0, 1.0))
    return normalized


def normalize_prosody(prosody):
    if not isinstance(prosody, dict):
        return {}
    normalized = {}
    for key in ("pitchHz", "pitchMean", "pitchRange", "voicedRatio"):
        value = prosody.get(key)
        try:
            normalized[key] = float(value)
        except (TypeError, ValueError):
            continue
    return normalized


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "pipeline": "wav2vec2->handcrafted->feature-selection->classifiers->majority-vote",
                    "status": pipeline.describe(),
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self.path != "/infer":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception as error:
            self._send_json(400, {"ok": False, "error": str(error)})
            return

        rhythm = payload.get("rhythm") if isinstance(payload.get("rhythm"), dict) else payload
        waveform = normalize_waveform(rhythm.get("waveform"))
        sample_rate = int(rhythm.get("sampleRate") or 16000)
        volume = float(rhythm.get("volume") or 0.0)
        interruption = float(rhythm.get("interruption") or 0.0)
        prosody = normalize_prosody(rhythm.get("prosody"))

        if not waveform and volume <= 0:
            self._send_json(200, {"ok": True, "result": None})
            return

        result = pipeline.infer(waveform, sample_rate, prosody, volume, interruption)
        self._send_json(200, {"ok": True, "result": result})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4163)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"SER backend listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
