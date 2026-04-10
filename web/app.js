import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const configWarning = document.getElementById("config-warning");
const appShell = document.getElementById("app-shell");
const displayNameInput = document.getElementById("display-name");
const roomIdInput = document.getElementById("room-id");
const newRoomButton = document.getElementById("new-room");
const joinRoomButton = document.getElementById("join-room");
const copyLinkButton = document.getElementById("copy-link");
const sessionStatus = document.getElementById("session-status");
const roomChip = document.getElementById("room-chip");
const syncState = document.getElementById("sync-state");
const presenceList = document.getElementById("presence-list");
const messages = document.getElementById("messages");
const messageInput = document.getElementById("message-input");
const sendMessageButton = document.getElementById("send-message");
const clearDraftButton = document.getElementById("clear-draft");

const state = {
  app: null,
  db: null,
  auth: null,
  user: null,
  roomId: "",
  displayName: "",
  unsubscribers: [],
};
let presenceInterval = null;

function sanitizeRoomId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 32);
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function formatTime(value) {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : null;
  if (!date) {
    return "pending";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function setStatus(title, detail, isWarning = false) {
  sessionStatus.innerHTML = `<strong>${title}</strong><span class="${isWarning ? "warning" : ""}">${detail}</span>`;
}

function clearSubscriptions() {
  state.unsubscribers.forEach((unsubscribe) => unsubscribe());
  state.unsubscribers = [];
}

function showConfigWarning() {
  configWarning.classList.remove("hidden");
  appShell.classList.add("hidden");
}

function showApp() {
  configWarning.classList.add("hidden");
  appShell.classList.remove("hidden");
}

function renderMessages(items = []) {
  if (!items.length) {
    messages.innerHTML = '<div class="empty">Messages will appear here after both devices join the same room.</div>';
    return;
  }

  messages.innerHTML = items
    .map((item) => {
      const mine = item.uid === state.user?.uid ? "mine" : "";
      const author = escapeHtml(item.displayName || "Anonymous");
      const text = escapeHtml(item.text || "");
      return `
        <article class="message ${mine}">
          <div class="message-meta">
            <span>${author}</span>
            <time>${formatTime(item.createdAt)}</time>
          </div>
          <div>${text}</div>
        </article>
      `;
    })
    .join("");
}

function renderPresence(items = []) {
  if (!items.length) {
    presenceList.innerHTML = '<div class="empty">No connected participants yet.</div>';
    return;
  }

  presenceList.innerHTML = items
    .map((item) => {
      const name = escapeHtml(item.displayName || "Anonymous");
      return `
        <div class="presence-item">
          <span>${name}</span>
          <span>${formatTime(item.lastSeen)}</span>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensurePresence() {
  if (!state.roomId || !state.user) {
    return;
  }

  const presenceRef = doc(state.db, "rooms", state.roomId, "presence", state.user.uid);
  await setDoc(
    presenceRef,
    {
      uid: state.user.uid,
      displayName: state.displayName,
      lastSeen: serverTimestamp(),
      userAgent: navigator.userAgent,
    },
    { merge: true }
  );
}

function startPresenceHeartbeat() {
  window.clearInterval(presenceInterval);
  presenceInterval = window.setInterval(() => {
    ensurePresence().catch(() => {});
  }, 30000);
}

function bindRoom(roomId) {
  clearSubscriptions();
  state.roomId = roomId;
  roomIdInput.value = roomId;

  const roomUrl = new URL(window.location.href);
  roomUrl.searchParams.set("room", roomId);
  window.history.replaceState({}, "", roomUrl.toString());

  roomChip.innerHTML = `<strong>Room ${escapeHtml(roomId)}</strong>${escapeHtml(roomUrl.toString())}`;
  syncState.textContent = "Connecting realtime listeners...";

  const messagesQuery = query(
    collection(state.db, "rooms", roomId, "messages"),
    orderBy("createdAt", "asc"),
    limit(50)
  );

  const presenceQuery = query(
    collection(state.db, "rooms", roomId, "presence"),
    orderBy("lastSeen", "desc"),
    limit(10)
  );

  state.unsubscribers.push(
    onSnapshot(
      messagesQuery,
      (snapshot) => {
        renderMessages(snapshot.docs.map((entry) => entry.data()));
        syncState.textContent = `Realtime sync live. ${snapshot.size} message${snapshot.size === 1 ? "" : "s"} loaded.`;
      },
      (error) => {
        syncState.textContent = `Message sync error: ${error.message}`;
      }
    )
  );

  state.unsubscribers.push(
    onSnapshot(
      presenceQuery,
      (snapshot) => {
        renderPresence(snapshot.docs.map((entry) => entry.data()));
      },
      (error) => {
        setStatus("Presence error", error.message, true);
      }
    )
  );

  ensurePresence().catch((error) => {
    setStatus("Presence error", error.message, true);
  });
}

async function joinRoom() {
  const displayName = String(displayNameInput.value || "").trim().slice(0, 40);
  const roomId = sanitizeRoomId(roomIdInput.value);

  if (!state.user) {
    setStatus("Signing in", "Waiting for Firebase anonymous auth to finish.");
    return;
  }

  if (!displayName) {
    setStatus("Missing name", "Enter your name before joining the room.", true);
    return;
  }

  if (!roomId) {
    setStatus("Missing room code", "Create or enter a room code first.", true);
    return;
  }

  state.displayName = displayName;
  localStorage.setItem("deafMeetName", displayName);
  localStorage.setItem("deafMeetRoom", roomId);

  await setDoc(
    doc(state.db, "rooms", roomId),
    {
      updatedAt: serverTimestamp(),
      lastJoinedBy: displayName,
    },
    { merge: true }
  );

  await ensurePresence();
  bindRoom(roomId);
  startPresenceHeartbeat();
  setStatus("Joined room", `${displayName} is now connected to room ${roomId}.`);
}

async function sendMessage() {
  const text = String(messageInput.value || "").trim();

  if (!text) {
    return;
  }

  if (!state.roomId || !state.user) {
    setStatus("Join a room first", "Messages can only sync after you join a room.", true);
    return;
  }

  sendMessageButton.disabled = true;

  try {
    await addDoc(collection(state.db, "rooms", state.roomId, "messages"), {
      uid: state.user.uid,
      displayName: state.displayName || "Anonymous",
      text,
      createdAt: serverTimestamp(),
    });
    await setDoc(
      doc(state.db, "rooms", state.roomId),
      {
        updatedAt: serverTimestamp(),
        lastMessage: text.slice(0, 180),
      },
      { merge: true }
    );
    await ensurePresence();
    messageInput.value = "";
  } catch (error) {
    setStatus("Send failed", error.message, true);
  } finally {
    sendMessageButton.disabled = false;
  }
}

async function bootstrap() {
  if (!firebaseConfig || !firebaseConfig.apiKey) {
    showConfigWarning();
    return;
  }

  showApp();

  state.app = initializeApp(firebaseConfig);
  state.db = getFirestore(state.app);
  state.auth = getAuth(state.app);

  displayNameInput.value = localStorage.getItem("deafMeetName") || "";
  roomIdInput.value = sanitizeRoomId(
    new URLSearchParams(window.location.search).get("room") || localStorage.getItem("deafMeetRoom") || ""
  );

  setStatus("Connecting", "Starting Firebase anonymous auth...");

  onAuthStateChanged(state.auth, (user) => {
    state.user = user;
    if (user) {
      setStatus("Signed in", "Ready to join a room from Mac or iPhone.");
      if (displayNameInput.value.trim() && roomIdInput.value.trim()) {
        joinRoom().catch((error) => {
          setStatus("Auto-join failed", error.message, true);
        });
      }
    }
  });

  try {
    await signInAnonymously(state.auth);
  } catch (error) {
    setStatus("Auth failed", error.message, true);
  }
}

newRoomButton.addEventListener("click", () => {
  roomIdInput.value = createRoomId();
});

joinRoomButton.addEventListener("click", () => {
  joinRoom().catch((error) => {
    setStatus("Join failed", error.message, true);
  });
});

copyLinkButton.addEventListener("click", async () => {
  const roomId = sanitizeRoomId(roomIdInput.value);
  if (!roomId) {
    setStatus("No room link yet", "Create or enter a room code before copying.", true);
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  await navigator.clipboard.writeText(url.toString());
  setStatus("Invite link copied", "Open that link on the iPhone to join the same room.");
});

sendMessageButton.addEventListener("click", () => {
  sendMessage();
});

messageInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    sendMessage();
  }
});

clearDraftButton.addEventListener("click", () => {
  messageInput.value = "";
});

window.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    ensurePresence().catch(() => {});
  }
});

window.addEventListener("beforeunload", () => {
  window.clearInterval(presenceInterval);
  clearSubscriptions();
});

bootstrap();
