# deaf-meet

Transparent speech-to-text overlay built with Electron for Deaf and Hard-of-Hearing users. The app listens to microphone speech, turns it into captions, applies emotion-aware color coding, and shows the result in a transparent always-on-top UI.

## What It Does

- Captures speech locally from the microphone
- Converts speech to text in real time
- Applies emotion-color encoding to each caption
- Displays captions in a transparent click-through overlay
- Includes a control panel for listening controls, theme, font size, and testing
- Keeps a small local HTTP caption endpoint for manual injection and demos

## Project Structure

```text
deaf-meet/
├── package.json
├── main.js
├── preload.js
├── caption-server.js
└── renderer/
    ├── overlay.html
    └── control.html
```

## Requirements

- Node.js 18+
- npm
- A desktop environment that can run Electron
- Microphone permission for live speech recognition

## Install

```bash
npm install
```

## Run

```bash
npm start
```

If your shell has `ELECTRON_RUN_AS_NODE=1` set, Electron will behave like plain Node and fail to open the app. In that case use:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

## Workflow

```text
Microphone speech
       |
       v
Speech recognition
       |
       v
Emotion encoding
       |
       v
Transparent overlay
```

## Using The App

1. Start the app
2. Allow microphone access if prompted
3. Click `Start Listening`
4. Speak normally
5. Watch the transparent overlay update with color-coded captions

The control window also shows:

- microphone state
- interim transcript preview
- live feed of recent captions
- detected emotion label

## Emotion Colors

- `happy` -> green
- `sad` -> blue
- `angry` -> red
- `calm` -> teal
- `excited` -> purple
- `neutral` -> theme default

The current emotion detection is heuristic and text-based. It is meant as a first prototype and can later be replaced with a stronger audio/language emotion model.

## Local Testing

You can test the overlay without using the microphone.

### From the app

- Type text in the `Test` card
- Click `Send Test Caption`

### With curl

Check server status:

```bash
curl http://127.0.0.1:4153/status
```

Inject a caption:

```bash
curl -X POST http://127.0.0.1:4153/caption -d 'text=Hello+world'
```

Inject a simulated sample:

```bash
curl -X POST http://127.0.0.1:4153/simulate -d 'text=This+is+urgent'
```

Read recent caption history:

```bash
curl http://127.0.0.1:4153/history
```

## HTTP Endpoints

### `POST /caption`

Inject a caption into the app using URL-encoded or JSON input.

Example:

```text
text=Hello+everyone
```

### `POST /simulate`

Inject a test caption.

### `GET /status`

Returns the local server state.

### `GET /history`

Returns recent stored captions.

## Netlify + Firebase Realtime Test

A separate static prototype lives in `web/`. It is designed for a quick two-device test:

1. Open the site on this Mac
2. Open the same room link on an iPhone
3. Join both devices with names
4. Send messages and confirm they appear on both sides in real time

### Firebase setup

1. Create a Firebase project
2. Enable `Authentication` -> `Anonymous`
3. Create a `Firestore Database`
4. Fill in `web/firebase-config.js` with your Firebase web app config

Starter Firestore rules for the prototype:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, write: if request.auth != null;
      match /{document=**} {
        allow read, write: if request.auth != null;
      }
    }
  }
}
```

### Netlify deploy

This repo now includes `netlify.toml`, which publishes the `web` folder directly.

1. Push the repo to GitHub
2. Import the repo into Netlify
3. Let Netlify detect `netlify.toml`
4. Deploy

After deploy, create a room on the Mac, copy the invite link, and open it on the iPhone.

## Notes

- The overlay window is transparent and click-through
- The control window is draggable from the top bar
- The local server binds to `127.0.0.1` only
- Caption history is stored in memory and capped at 200 entries
- The default local port is `4153`
- You can override the port with `CAPTION_PORT`

Example:

```bash
CAPTION_PORT=5001 npm start
```

## Current Scope

- Primary display only
- Emotion inference is heuristic for now
- Browser speech recognition availability depends on the Electron runtime
- No persistent settings storage yet
- No packaging or installer workflow yet
