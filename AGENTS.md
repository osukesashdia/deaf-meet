# Emotion-Coded Speech Overlay — Implementation Spec

## Research Direction

**Title:**  
Evaluating the impact of visual sound rhythms and emotion-coded captions in online meetings for Deaf and Hard-of-Hearing users.

**Summary:**  
This project explores an accessibility tool for Deaf and Hard-of-Hearing (DHH) users that addresses both the Emotion Gap and Vigilance Fatigue. Instead of showing flat captions only, the interface converts live speech into text, applies emotion-aware color encoding, and presents the result in a transparent overlay. The intent is to help users understand tone more quickly while reducing the effort required to continuously monitor speech in online conversations.

**Research question:**  
What is the effect of combining emotion-coded text and visual sound rhythms on cognitive load and emotional understanding for DHH users in online meetings compared with traditional text captions?

**Hypotheses:**  
- H1: Emotion-coded speech-to-text improves the speed or accuracy of recognizing speaker tone compared with plain captions.
- H2: Visual rhythm indicators for loudness, interruption, and speaking intensity reduce vigilance fatigue compared with plain captions alone.

## Product Goal

Build a local Electron app that:

1. Listens to microphone speech
2. Converts speech to text in real time
3. Applies emotion encoding logic to each caption
4. Displays the result in a transparent always-on-top overlay

Zoom integration is not required for this version. The primary workflow is local speech-to-text plus emotion-colored caption rendering.

## How It Works

```
Microphone speech
       │
       ▼
Speech recognition in control window
       │
       ▼
Caption + emotion tagging
       │  Electron IPC
       ▼
Transparent overlay window
```

## File Structure

```
speech-emotion-overlay/
├── package.json
├── main.js
├── preload.js
├── caption-server.js
└── renderer/
    ├── overlay.html
    └── control.html
```

## main.js

Creates two windows and manages the shared caption pipeline.

### Overlay window

Transparent, always-on-top, frameless, full-width x 160px:

```js
{ transparent: true, frame: false, alwaysOnTop: true,
  skipTaskbar: true, focusable: false }
```

Required behavior:

```js
overlayWindow.setIgnoreMouseEvents(true, { forward: true })
overlayWindow.setAlwaysOnTop(true, 'screen-saver')
overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
setInterval(() => overlayWindow.setAlwaysOnTop(true, 'screen-saver'), 2000)
```

### Control window

Management UI for speech recognition and display settings:

```js
{ width: 420, height: 620, frame: false }
```

On close:

```js
controlWindow.on('close', e => { e.preventDefault(); controlWindow.hide() })
```

### Main responsibilities

- Start the local caption server on app ready
- Accept injected captions from the renderer
- Infer an emotion label for each caption
- Broadcast processed captions to both windows
- Keep overlay settings in memory

### IPC channels

| Channel | Direction | Action |
|---|---|---|
| `overlay:toggle` | renderer -> main | Show or hide overlay |
| `overlay:reposition` | renderer -> main | Move overlay to `top`, `middle`, or `bottom` |
| `overlay:settings` | renderer -> main | Update theme, font size, max lines |
| `caption:inject` | renderer -> main | Inject a locally recognized caption |
| `caption:new` | main -> renderer | Broadcast processed caption |
| `settings:update` | main -> renderer | Forward overlay settings |
| `server:getPort` | renderer -> main | Return local server port |
| `server:getStatus` | renderer -> main | Return `{ running, port }` |

### Caption payload

The canonical caption object should be:

```js
{
  seq: number,
  lang: string,
  text: string,
  timestamp: number,
  emotion: 'happy' | 'sad' | 'angry' | 'calm' | 'excited' | 'neutral',
  source?: 'speech' | 'simulate' | 'http',
  simulated?: boolean
}
```

## preload.js

Expose `window.captionBridge` with:

```js
{
  onCaption(callback),
  onSettingsUpdate(callback),
  toggleOverlay(),
  reposition(position),
  updateSettings(settings),
  injectCaption(payload),
  getPort(),
  getStatus(),
  removeAllListeners(channel),
}
```

`webPreferences` must use:

```js
contextIsolation: true,
nodeIntegration: false
```

## caption-server.js

Keep a lightweight local HTTP server for testing or external caption injection.

Exports:

```js
startCaptionServer(port, onCaption)
stopCaptionServer()
getHistory()
getStatus()
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/caption` | Inject external caption text |
| POST | `/simulate` | Inject a test caption |
| GET | `/status` | Health check JSON |
| GET | `/history` | Return recent stored captions |

### Rules

- Bind to `127.0.0.1` only
- Ignore empty `text`
- Cap history at 200 entries
- Return HTTP 200 after valid caption injection

## renderer/overlay.html

Transparent page that shows emotion-coded captions.

### Required behavior

- `html, body { background: transparent !important; overflow: hidden; }`
- Animated glass-style caption pills
- Fade all visible lines after 6000ms
- Remove lines after 14000ms
- Keep only `MAX_LINES` visible

### Emotion coloring

Each caption must use the `emotion` field to change text color:

| Emotion | Color direction |
|---|---|
| `happy` | green |
| `sad` | blue |
| `angry` | red |
| `calm` | teal |
| `excited` | purple |
| `neutral` | default theme color |

### Demo mode

If `window.captionBridge` is missing, auto-cycle sample captions and sample emotions.

## renderer/control.html

Control UI should focus on local speech recognition.

### Cards

1. **Speech Input**
   - Start listening button
   - Stop listening button
   - Microphone status
   - Browser speech recognition support warning if unavailable

2. **Display Settings**
   - Theme select
   - Max lines select
   - Font size slider
   - Position controls
   - Overlay show or hide button

3. **Test**
   - Manual text input
   - Send test caption button
   - Optional local endpoint display for external injection

4. **Live Feed**
   - Show newest captions first
   - Include `HH:MM:SS` timestamp
   - Show detected emotion label
   - Cap at 30 items

### Speech-to-text behavior

- Use browser speech recognition from the renderer if available
- Prefer continuous listening
- Restart automatically after normal recognition end while listening is enabled
- Send final recognized phrases through `captionBridge.injectCaption(...)`
- Show interim listening status in the control window
- Do not inject empty transcripts

## Emotion Encoding Logic

For v1, emotion detection can be heuristic. It should infer from keywords and emphasis:

- positive words -> `happy`
- apology, loss, difficulty words -> `sad`
- urgent or conflict words -> `angry`
- reassurance or steady words -> `calm`
- hype or celebratory words -> `excited`
- otherwise -> `neutral`

The long-term direction is to replace this heuristic layer with an actual emotion classifier based on audio and language features.

## Quick Test

```bash
npm install
npm start
```

Then:

- Allow microphone access
- Click `Start Listening`
- Speak into the microphone
- Confirm captions appear in the transparent overlay with changing emotion colors

Optional HTTP injection:

```bash
curl -X POST http://127.0.0.1:4153/simulate -d 'text=Hello+world'
curl -X POST http://127.0.0.1:4153/caption -d 'text=This+is+urgent'
curl http://127.0.0.1:4153/status
```
