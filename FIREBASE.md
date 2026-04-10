# Firebase Setup

This guide sets up the realtime web prototype in `web/` so one person can open it on this Mac and another can join from an iPhone.

## What We Are Using

- Firebase Authentication
  - `Anonymous` sign-in for quick testing
- Cloud Firestore
  - realtime room, message, and presence syncing
- Netlify
  - static hosting for the `web/` folder

## 1. Create A Firebase Project

1. Go to the Firebase console:
   - https://console.firebase.google.com/
2. Click `Create a project`
3. Enter a project name
4. Continue with the default setup unless you want Google Analytics enabled
5. Finish project creation

## 2. Add A Web App

1. Open your Firebase project
2. Click the Web icon `</>`
3. Register a web app
4. Give it a name like `deaf-meet-web`
5. Copy the Firebase config values shown by Firebase

You will paste those values into:

- [web/firebase-config.js](/Users/RS/Desktop/deaf-meet/web/firebase-config.js)

Example shape:

```js
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
};
```

## 3. Enable Anonymous Authentication

1. In Firebase console, open `Authentication`
2. Click `Get started` if needed
3. Open the `Sign-in method` tab
4. Enable `Anonymous`
5. Save

This prototype uses anonymous auth so both devices can join quickly without building a full login flow.

## 4. Create Firestore Database

1. In Firebase console, open `Firestore Database`
2. Click `Create database`
3. Choose a region close to you
4. Start in production mode if you want to use rules right away
5. Finish setup

## 5. Add Firestore Security Rules

Open `Firestore Database` -> `Rules` and paste:

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

Then click `Publish`.

These rules are intentionally simple for prototype testing. They allow any authenticated user in the app to read and write room data.

## 6. Fill In Local Firebase Config

Edit:

- [web/firebase-config.js](/Users/RS/Desktop/deaf-meet/web/firebase-config.js)

Replace the empty strings with your Firebase web app config values.

You can use:

- [web/firebase-config.example.js](/Users/RS/Desktop/deaf-meet/web/firebase-config.example.js)

as a reference.

## 7. Optional Local Test

You can test the static site locally before deploying.

If you want a quick local server:

```bash
npx serve web
```

Then open the local URL in your browser.

If `npx serve web` needs to download packages and your environment blocks network access, you can skip local hosting and go straight to Netlify.

## 8. Deploy To Netlify

This repo already includes:

- [netlify.toml](/Users/RS/Desktop/deaf-meet/netlify.toml)

which publishes the `web/` folder.

Steps:

1. Push this repo to GitHub
2. Open Netlify
3. Import the GitHub repo
4. Let Netlify use the existing `netlify.toml`
5. Deploy

## 9. Test On Mac And iPhone

1. Open the deployed site on this Mac
2. Enter your name
3. Click `New` to generate a room code
4. Click `Join`
5. Click `Copy Link`
6. Open that link on the iPhone
7. Enter a second name on the iPhone
8. Join the same room
9. Send messages from each device

Expected result:

- both devices see the same messages
- both devices show participant presence
- updates appear in real time

## 10. Firestore Data Shape

The current prototype uses this structure:

```text
rooms/{roomId}
rooms/{roomId}/messages/{messageId}
rooms/{roomId}/presence/{userId}
```

## Troubleshooting

### `Missing local config`

Cause:
- `web/firebase-config.js` is still empty

Fix:
- paste your Firebase web config into that file

### `Auth failed`

Cause:
- anonymous auth is not enabled

Fix:
- enable `Anonymous` in Firebase Authentication

### `Permission denied` from Firestore

Cause:
- Firestore rules do not allow authenticated writes

Fix:
- publish the rules from this guide

### iPhone cannot join the same room

Cause:
- wrong room link
- old deployment
- Firebase config mismatch

Fix:
- copy the room link again from the Mac
- confirm Netlify deployed the latest version
- confirm both devices use the same deployed site

## Next Good Steps

- add room expiration/cleanup
- add transcript-style message grouping
- replace anonymous auth with email, Google, or magic link auth
- add stronger Firestore rules per room membership
