/* UoPeople Reminder — Service Worker */
const CACHE = "uopeople-v1";
const ASSETS = ["./", "./index.html", "./manifest.json"];
const ICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20192%20192%22%3E%3Crect%20width%3D%22192%22%20height%3D%22192%22%20rx%3D%2242%22%20fill%3D%22%234f8cff%22%2F%3E%3Ccircle%20cx%3D%2296%22%20cy%3D%2296%22%20r%3D%2252%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%229%22%2F%3E%3Cpath%20d%3D%22M96%2058v42l28%2016%22%20stroke%3D%22%23fff%22%20stroke-width%3D%229%22%20stroke-linecap%3D%22round%22%20fill%3D%22none%22%2F%3E%3C%2Fsvg%3E";

/* ---------- install / activate / fetch ---------- */
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => checkReminders())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});

/* ---------- IndexedDB helpers ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("uopeople-db", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction("items", "readonly").objectStore("items").getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

async function putAll(items) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    store.clear();
    items.forEach((i) => store.put(i));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function getMeta(key) {
  const db = await openDB();
  return new Promise((res) => {
    const req = db.transaction("meta", "readonly").objectStore("meta").get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => res(null);
  });
}

async function setMeta(key, value) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(value, key);
    tx.oncomplete = () => res();
  });
}

/* ---------- sync from page ---------- */
async function syncItems(newItems) {
  const old = await getAll();
  const oldMap = new Map(old.map((i) => [i.id, i]));
  const merged = (newItems || []).map((ni) => ({
    ...ni,
    // Old wins per stage so we never re-fire something already fired while the page was closed.
    notified: { ...(ni.notified || {}), ...((oldMap.get(ni.id) || {}).notified || {}) },
  }));
  await putAll(merged);
}

async function resetItem(id) {
  const items = await getAll();
  const it = items.find((i) => i.id === id);
  if (it) { it.notified = {}; await putAll(items); }
}

/* ---------- reminder engine ---------- */
async function checkReminders() {
  const items = await getAll();
  const settings = (await getMeta("settings")) || { leadMinutes: 1440 };
  const now = Date.now();
  let changed = false;

  const stages = [
    { key: "lead", mins: Number(settings.leadMinutes) || 1440 },
    { key: "h1", mins: 60 },
    { key: "m0", mins: 0 },
  ].sort((a, b) => b.mins - a.mins);

  for (const it of items) {
    if (it.done) continue;
    it.notified = it.notified || {};
    const msLeft = it.due - now;
    const passed = stages.filter((s) => msLeft <= s.mins * 60000 && !it.notified[s.key]);
    if (passed.length) {
      passed.forEach((s) => { it.notified[s.key] = now; });
      await showReminder(it, passed[passed.length - 1]);
      changed = true;
    }
  }

  if (changed) {
    await putAll(items);
    await broadcastSync();
  }
}

async function showReminder(it, stage) {
  const when =
    stage.mins === 0 ? "now" :
    stage.mins < 60 ? `in ${stage.mins} min` :
    stage.mins < 1440 ? `in ${Math.round(stage.mins / 60)} hour(s)` :
    `in ${Math.round(stage.mins / 1440)} day(s)`;

  await self.registration.showNotification(`⏰ ${it.type} due ${when}`, {
    body: `${it.course ? it.course + " — " : ""}${it.title}`,
    icon: ICON,
    badge: ICON,
    tag: `${it.id}-${stage.key}`,
    requireInteraction: false,
    data: { id: it.id, url: "./" },
  });
}

async function broadcastSync() {
  const items = await getAll();
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: "sync-back", items }));
}

/* ---------- events ---------- */
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "sync") {
    e.waitUntil((async () => {
      await setMeta("settings", d.settings || { leadMinutes: 1440 });
      await syncItems(d.items || []);
      await checkReminders();
    })());
  }
  if (d.type === "check") e.waitUntil(checkReminders());
  if (d.type === "reset-item") e.waitUntil(resetItem(d.id));
});

self.addEventListener("periodicsync", (e) => {
  if (e.tag === "uopeople-check") e.waitUntil(checkReminders());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) { await c.focus(); return; }
    }
    await self.clients.openWindow("./");
  })());
});

/* Optional: real server-push (needs a VAPID backend) */
self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(p.title || "UoPeople reminder", {
    body: p.body || "",
    icon: ICON,
    data: { url: p.url || "./" },
  }));
});
