# deaf-meet

`deaf-meet` is a local Electron caption overlay for Deaf and Hard-of-Hearing users. It turns speech into captions, adds emotion-aware color coding, and shows the result in a transparent always-on-top overlay. It also includes a separate live rhythm graph for voice activity.

## Features

- Transparent click-through caption overlay
- Local speech-to-text controls
- Emotion-colored captions
- Live sound rhythm graph above the text area
- Local HTTP server for testing and external caption injection
- Browser Capture option for more reliable speech recognition

## Requirements

- Node.js 18+
- npm
- Microphone access
- Google Chrome for Browser Capture

## Install

```bash
npm install
```

## Run

```bash
npm start
```

If `ELECTRON_RUN_AS_NODE=1` is set in your shell, use:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

## Quick Start

1. Run `npm start`.
2. Allow microphone access if prompted.
3. In the control window, choose one of these options:
4. Click `Start Listening` to use speech recognition inside the app.
5. Or click `Open Browser Capture` to use Google Chrome.
6. Speak normally and watch the live rhythm graph move above the captions.
7. Final captions will appear in the overlay with emotion colors.

## Browser Capture

Use Browser Capture when in-app speech recognition is unreliable.

- The app opens the capture page in Google Chrome.
- Keep the Chrome tab open while using the overlay.
- Allow microphone permission in Chrome.
- The live graph should start moving as soon as voice is detected, even before final text appears.

## Emotion Colors

- `happy` -> green
- `sad` -> blue
- `angry` -> red
- `calm` -> teal
- `excited` -> purple
- `neutral` -> white or theme default

## Local Endpoints

The local server binds to `127.0.0.1` and uses port `4153` by default.

- `POST /caption` inject a caption
- `POST /simulate` inject a test caption
- `POST /rhythm` stream live rhythm data
- `GET /status` check server status
- `GET /history` view recent captions
- `GET /speech-capture` open the browser capture page

## Testing

Manual app test:

- Type text in the `Test` section
- Click `Send Test Caption`

Terminal test:

```bash
curl http://127.0.0.1:4153/status
curl -X POST http://127.0.0.1:4153/caption -d 'text=Hello+world'
curl -X POST http://127.0.0.1:4153/simulate -d 'text=This+is+urgent'
curl http://127.0.0.1:4153/history
```

## Notes

- The overlay is transparent and ignores mouse input unless edit mode is enabled.
- Captions and history are stored in memory only.
- Emotion detection uses hosted inference when available, with a local heuristic fallback.
- The app currently targets a single display.
- You can change the port with `CAPTION_PORT`.

Example:

```bash
CAPTION_PORT=5001 npm start
```
