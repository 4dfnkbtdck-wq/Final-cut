import { TMDB_API_KEY, FIREBASE_CONFIG } from "./config.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hashHue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";
const BLANK_GAME = { phase: "lobby", order: [], turns: 0, quota: 0, cuts: {}, pool: [], round: 0, winner: null, vote: null };
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const MAX_MOVIES = 100;

/* ================= Backends ================= */

// Firebase Realtime Database, loaded from Google's CDN on demand.
async function firebaseBackend(cfg) {
  const base = "https://www.gstatic.com/firebasejs/10.12.2/";
  const [{ initializeApp }, rtdb, { getAuth, signInAnonymously }] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-database.js"), import(base + "firebase-auth.js"),
  ]);
  const app = initializeApp(cfg);
  const cred = await signInAnonymously(getAuth(app));
  const db = rtdb.getDatabase(app);
  const r = (p) => rtdb.ref(db, p);
  return {
    uid: cred.user.uid,
    watch: (p, cb, onError) => rtdb.onValue(r(p), (s) => cb(s.val()), onError),
    get: async (p) => (await rtdb.get(r(p))).val(),
    set: (p, v) => rtdb.set(r(p), v),
    update: (p, v) => rtdb.update(r(p), v),
    remove: (p) => rtdb.remove(r(p)),
    txn: async (p, fn) => (await rtdb.runTransaction(r(p), fn)).committed,
  };
}

// Same interface, kept in this browser's localStorage. Each tab is its own player,
// so you can try a full game with a few tabs side by side.
function demoBackend() {
  const KEY = "final-cut-demo";
  let uid = sessionStorage.getItem("fc-demo-uid");
  if (!uid) { uid = "demo" + Math.random().toString(36).slice(2, 8); sessionStorage.setItem("fc-demo-uid", uid); }
  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const at = (o, p) => p.split("/").reduce((a, k) => (a == null ? a : a[k]), o);
  const put = (o, p, v) => {
    const ks = p.split("/"); let a = o;
    for (const k of ks.slice(0, -1)) { if (typeof a[k] !== "object" || a[k] === null) a[k] = {}; a = a[k]; }
    if (v == null) delete a[ks.at(-1)]; else a[ks.at(-1)] = clone(v);
  };
  const subs = new Set();
  const fire = () => { const o = load(); subs.forEach((s) => s.cb(clone(at(o, s.path)) ?? null)); };
  const save = (o) => { localStorage.setItem(KEY, JSON.stringify(o)); fire(); };
  addEventListener("storage", (e) => { if (e.key === KEY) fire(); });
  return {
    uid,
    watch(path, cb) { const s = { path, cb }; subs.add(s); setTimeout(() => cb(clone(at(load(), path)) ?? null)); return () => subs.delete(s); },
    get: async (p) => clone(at(load(), p)) ?? null,
    async set(p, v) { const o = load(); put(o, p, v); save(o); },
    async update(p, v) { const o = load(); for (const [k, val] of Object.entries(v)) put(o, p + "/" + k, val); save(o); },
    async remove(p) { const o = load(); put(o, p, null); save(o); },
    async txn(p, fn) { const o = load(); const res = fn(clone(at(o, p)) ?? null); if (res === undefined) return false; put(o, p, res); save(o); return true; },
  };
}

/* ================= TMDB ================= */

async function tmdb(path, query = {}) {
  const u = new URL(TMDB + path);
  u.searchParams.set("api_key", TMDB_API_KEY);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const res = await fetch(u);
  if (!res.ok) throw new Error("TMDB " + res.status);
  return res.json();
}
const poster = (path, size = "w342") => (path ? IMG + size + path : "");

/* ================= State ================= */

let be = null, me = null, code = null, unwatch = null;
let room = null;          // raw room snapshot
let pending = null, busy = false, searchSeq = 0;
const seenCuts = new Set();

const myName = () => store.get("fc-name") || "";
const movies = () => Object.entries(room?.movies || {}).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
const players = () => Object.entries(room?.players || {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
const game = () => ({ ...BLANK_GAME, ...(room?.game || {}) });
const byId = (id) => (room?.movies?.[id] ? { id, ...room.movies[id] } : null);
const inPlay = () => (game().phase === "lobby" ? movies() : (game().pool || []).map(byId).filter(Boolean));
const remaining = () => inPlay().filter((m) => !game().cuts?.[m.id]);
const order = () => game().order || [];
const turnPlayer = () => (order().length ? order()[(game().turns || 0) % order().length] : null);
const joined = () => !!room?.players?.[me];
const hostId = () => room?.meta?.createdBy || null;
const isHost = () => !!me && hostId() === me;
const full = () => movies().length >= MAX_MOVIES;
const myTurn = () => game().phase === "playing" && joined() && turnPlayer() === me;
const canVote = () => game().phase === "voting" && joined();
const banned = () => game().vote?.banned?.[me] || null;
const ballots = () => game().vote?.ballots || {};
const voters = () => players().map((p) => p.id);
// How a lineup splits: everyone gets the same number of cuts, and what's left goes to a vote.
const split = (movieCount, playerCount) => {
  const quota = playerCount ? Math.floor((movieCount - 1) / playerCount) : 0;
  return { quota, toVote: movieCount - quota * playerCount };
};
const cutLabel = (c) => (c.by === "vote" ? (c.random ? "random draw" : `${c.votes} vote${c.votes === 1 ? "" : "s"}${c.tie ? " · tied" : ""}`)
  : nameOf(c.by, c.name));
const nameOf = (id, fallback) => (id === me ? "You" : room?.players?.[id]?.name || fallback || "Someone");

/* ================= UI helpers ================= */

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3800);
}
async function guard(fn) {
  if (busy) return;
  busy = true; render();
  try { await fn(); } catch (e) { console.error(e); toast("That didn't save. Check your connection and try again."); }
  finally { busy = false; render(); }
}
function setURL(c) {
  const u = new URL(location.href);
  if (c) u.searchParams.set("room", c); else u.searchParams.delete("room");
  history.replaceState(null, "", u);
}
function inviteLink() {
  const u = new URL(location.href); u.search = "";
  if (DEMO) u.searchParams.set("demo", "");
  u.searchParams.set("room", code);
  return u.toString().replace("demo=&", "demo&");
}

/* ================= Render ================= */

function posterHTML(m, index = 0) {
  if (m.poster) return `<img alt="" src="${esc(poster(m.poster))}" loading="lazy">`;
  const len = String(m.title).length;
  const fs = len <= 6 ? 40 : len <= 12 ? 32 : len <= 20 ? 26 : len <= 32 ? 21 : 17;
  return `<div class="art" style="--h:${hashHue(m.title)};--fs:${fs}px">
    <span class="reel">REEL ${String(index + 1).padStart(2, "0")}${m.year ? " · " + esc(m.year) : ""}</span>
    <span class="ptitle">${esc(m.title)}</span></div>`;
}

function render() {
  const inRoom = !!code;
  $("#landing").hidden = inRoom;
  $("#room").hidden = !inRoom;
  $("#roomTools").hidden = !inRoom;
  $("#dock").hidden = !inRoom;
  if (!inRoom) {
    $("#status").textContent = DEMO ? "Demo mode · this device only" : "Ready when you are";
    // Opening the app from the Home Screen always starts here, so offer the last room back.
    const last = store.get("fc-last-room");
    $("#rejoinBtn").hidden = !last || !be;
    if (last) $("#rejoinBtn").textContent = `Back to room ${last}`;
    return;
  }
  if (!room) { $("#status").innerHTML = `Room <span class="code">${esc(code)}</span> · connecting…`; return; }

  const g = game(), list = inPlay(), cuts = g.cuts || {}, rem = remaining();
  const tail = g.phase === "lobby" ? `${list.length} of ${MAX_MOVIES} movies · ${players().length} in the crew`
    : g.phase === "playing" ? `Round ${g.round || 1} · ${rem.length} of ${list.length} left · ${g.quota} cuts each`
    : g.phase === "voting" ? `Round ${g.round || 1} · vote ${g.vote?.round || 1} · ${rem.length} left`
    : `Round ${g.round || 1} · decided`;
  $("#status").innerHTML = `Room <span class="code">${esc(code)}</span> · ${esc(tail)}`;

  // crew
  const ids = g.phase === "lobby" ? players().map((p) => p.id) : [...order(), ...players().map((p) => p.id).filter((p) => !order().includes(p))];
  const tp = turnPlayer();
  $("#cast").innerHTML = ids.map((id) => {
    const benched = g.phase !== "lobby" && !order().includes(id);
    const gone = !room.players?.[id];
    const name = nameOf(id);
    const ord = g.phase === "playing" && !benched ? `<span class="ord">${order().indexOf(id) + 1}</span>` : "";
    const voted = g.phase === "voting" && ballots()[id] ? ' <span class="ord">voted</span>' : "";
    const note = (id === hostId() ? ' <span class="ord">host</span>' : "") + voted + (gone ? ' <span class="ord">left</span>' : benched && g.phase === "playing" ? ' <span class="ord">votes at the end</span>' : "");
    return `<span class="chip${g.phase === "playing" && id === tp ? " turn" : ""}"><span class="dot" style="--h:${hashHue(id)}">${esc((room.players?.[id]?.name || "?")[0].toUpperCase())}</span>${ord}<span class="nm">${esc(name)}</span>${note}</span>`;
  }).join("") + (joined() ? "" : `<button class="btn primary small" data-act="join">Join the crew</button>`);

  renderHostPanel();

  // add
  $("#addSection").hidden = g.phase !== "lobby" || !isHost();
  $("#addLabel").textContent = full() ? `The wall is full (${MAX_MOVIES} movies)` : "Add to the lineup";
  $("#searchInput").disabled = full();

  // winner
  const feat = $("#feature");
  const win = g.phase === "done" ? byId(g.winner) || rem[0] : null;
  if (win) {
    const log = Object.entries(cuts).sort((a, b) => a[1].n - b[1].n).map(([id, c]) =>
      `<li><span class="n">${c.n}</span><span><b>${esc(byId(id)?.title || "A removed movie")}</b>, ${c.by === "vote"
        ? (c.random ? "drawn at random to break a tie" : `voted out (${c.votes} of ${c.of} votes${c.tie ? ", tied for most" : ""})`)
        : `cut by ${esc(nameOf(c.by, c.name))}`}</span></li>`).join("");
    feat.hidden = false;
    feat.innerHTML = `<div class="feature">
      <div class="poster-slot"><div class="poster">${posterHTML(win)}</div></div>
      <div style="min-width:0">
        <div class="eyebrow">Tonight's feature</div>
        <h2>${esc(win.title)}</h2>
        <p>${[win.year, win.director, win.runtime ? win.runtime + " min" : ""].filter(Boolean).map(esc).join(" · ") || "Last one standing."}</p>
        ${win.overview ? `<p class="overview">${esc(win.overview)}</p>` : ""}
        <span class="label" style="margin-top:14px">Cutting-room log</span>
        <ol class="log">${log}</ol>
      </div></div>`;
  } else feat.hidden = true;

  // wall
  const grid = $("#grid"), empty = $("#empty");
  const voting = g.phase === "voting";
  const live = (myTurn() || canVote()) && !busy;
  const mine = ballots()[me], last = banned();
  if (!list.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    empty.innerHTML = isHost()
      ? `<strong>The wall is empty</strong>Search for movies above, up to ${MAX_MOVIES}. Your friends will see them here when they join.`
      : `<strong>The wall is empty</strong>${esc(nameOf(hostId(), "The host"))} is still picking the movies.`;
  } else {
    empty.hidden = true;
    // During the vote, the movies still standing go first so nobody scrolls past the cut ones.
    const shown = list.map((m, i) => [m, i]);
    if (voting) shown.sort((x, y) => !!cuts[x[0].id] - !!cuts[y[0].id] || x[1] - y[1]);
    grid.innerHTML = shown.map(([m, i]) => {
      const c = cuts[m.id];
      const fresh = c && !seenCuts.has(m.id);
      const open = !c && live && !(canVote() && last === m.id);
      const cls = ["card", c ? "cut" : "", fresh ? "fresh" : "", open ? "live" : "idle", pending === m.id ? "pending" : "", voting && mine === m.id && !c ? "myvote" : ""].filter(Boolean).join(" ");
      const sub = [m.year, m.runtime ? m.runtime + " min" : ""].filter(Boolean).join(" · ");
      return `<article class="${cls}">
        <button class="poster" type="button" data-pick="${m.id}" aria-label="${esc(c ? m.title + ", cut" : open ? (canVote() ? "Vote to cut " : "Cut ") + m.title : m.title)}" ${open ? "" : 'tabindex="-1"'}>
          ${posterHTML(m, i)}
          <span class="stamp">Cut${c ? `<small>#${c.n} · ${esc(cutLabel(c))}</small>` : ""}</span>
          ${voting && mine === m.id && !c ? '<span class="vote-tag">Your vote</span>'
            : canVote() && last === m.id && !c ? '<span class="vote-tag off">Your last pick</span>' : ""}
        </button>
        <div class="confirm"><p>${canVote() ? "Vote to cut" : "Cut"} ${esc(m.title)}?</p>
          ${canVote() ? `<button class="btn danger" type="button" data-vote="${m.id}">Vote</button>`
            : `<button class="btn danger" type="button" data-cut="${m.id}">Cut it</button>`}
          <button class="btn keep" type="button" data-keep>Keep</button></div>
        <div class="meta"><b>${esc(m.title)}</b><span>${esc(sub) || "&nbsp;"}</span></div>
        ${g.phase === "lobby" && isHost() ? `<div class="tools"><button type="button" data-remove="${m.id}">Remove</button></div>` : ""}
      </article>`;
    }).join("");
    grid.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => {
      const m = byId(img.closest(".card")?.querySelector("[data-pick]")?.dataset.pick);
      if (m) img.outerHTML = posterHTML({ ...m, poster: null });
    }, { once: true }));
  }
  Object.keys(cuts).forEach((id) => seenCuts.add(id));
  renderDock();
}

let claimOpen = false;
function renderHostPanel() {
  const panel = $("#hostPanel");
  let html = "";
  if (isHost() && !room.pinSet) {
    html = `<p><b>Set a host PIN.</b> If your phone ever forgets you, you can use it to get your host controls back.</p>
      <form data-form="setpin"><input class="pin" id="setPinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="4 digits" aria-label="Host PIN" autocomplete="off"><button class="btn small primary" type="submit">Save PIN</button></form>`;
  } else if (!isHost() && room.pinSet && joined()) {
    html = claimOpen
      ? `<p><b>Are you the host?</b> Enter the room's host PIN to get your host controls back.</p>
        <form data-form="claim"><input class="pin" id="claimPinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="PIN" aria-label="Host PIN" autocomplete="off"><button class="btn small primary" type="submit">Take over hosting</button><button class="btn small ghost" type="button" data-act="claimclose">Cancel</button></form>`
      : `<button class="linkish" type="button" data-act="claimopen">I'm the host</button>`;
  }
  // Re-rendering would wipe a PIN someone is typing, so only touch the panel when its state changes.
  const key = html.slice(0, 40);
  if (panel.dataset.key !== key) { panel.innerHTML = html; panel.dataset.key = key; }
  panel.hidden = !html;
  panel.classList.toggle("bare", !!html && !claimOpen && !isHost());
}

const validPin = (p) => /^[0-9]{4}$/.test(p);

// The PIN lives where nobody can read it. The database rules only let someone
// take over hosting after they've written a matching guess under their own id.
async function savePin(c, pin) {
  await be.set(`hostpins/${c}`, { pin });
  await be.set(`rooms/${c}/pinSet`, true);
}

async function claimHost(pin) {
  if (!validPin(pin)) return toast("The PIN is 4 digits.");
  try {
    await be.set(`claims/${code}/${me}`, pin);
    if (DEMO) {
      const real = (await be.get(`hostpins/${code}`))?.pin;
      if (real !== pin) throw new Error("wrong pin");
    }
    await be.set(roomPath("meta/createdBy"), me);
    claimOpen = false;
    toast("You're the host again.");
  } catch (e) {
    console.error(e);
    toast("That PIN doesn't match.");
  } finally {
    be.remove(`claims/${code}/${me}`).catch(() => {});
  }
}

function renderDock() {
  const dock = $("#dock"), g = game();
  dock.classList.remove("myturn");
  let title = "", sub = "", buttons = "";
  if (g.phase === "lobby") {
    const n = movies().length;
    const host = nameOf(hostId(), "the host");
    const crew = Math.max(1, players().length + (joined() || !isHost() ? 0 : 1));
    const plan = n >= 2 ? split(n, crew) : null;
    const planText = !plan ? "" : plan.quota === 0
      ? `With ${crew} players it goes straight to a vote.`
      : `With ${crew} player${crew === 1 ? "" : "s"}: ${plan.quota} cut${plan.quota === 1 ? "" : "s"} each${plan.toVote > 1 ? `, then a vote on the last ${plan.toVote}` : ""}.`;
    if (isHost()) {
      title = n < 2 ? "Add at least 2 movies" : `${n} movies ready`;
      sub = planText || "Share the room code, then start when everyone's in.";
      buttons = `<button class="btn primary" data-act="start" ${n < 2 || busy ? "disabled" : ""}>Start cutting</button>`;
    } else {
      title = `Waiting for ${host}`;
      sub = joined() ? `${host} picks the movies and starts the game. ${planText}` : "Join the crew to take part.";
    }
  } else if (g.phase === "playing") {
    const tp = turnPlayer();
    const toVote = (g.pool || []).length - g.quota * order().length;
    const then = toVote > 1 ? `then the last ${toVote} go to a vote` : "and the last one standing wins";
    if (myTurn()) {
      const used = Object.values(g.cuts || {}).filter((c) => c.by === me).length;
      dock.classList.add("myturn"); title = "Your cut";
      sub = `Cut ${Math.min(used + 1, g.quota)} of ${g.quota}. Tap a poster.`;
    } else {
      title = `${nameOf(tp)}'s cut`;
      sub = !joined() ? "Join the crew to vote at the end." : order().includes(me) ? `Everyone gets ${g.quota}, ${then}.` : `You joined mid-round, so you'll vote at the end.`;
    }
    if (isHost()) buttons = `${tp && tp !== me ? `<button class="btn" data-act="skip">Skip ${esc(nameOf(tp))}</button>` : ""}<button class="btn" data-act="lobby">End round</button>`;
  } else if (g.phase === "voting") {
    const b = ballots(), v = voters(), n = v.filter((id) => b[id]).length;
    const mineTitle = byId(b[me])?.title;
    const revote = !!g.vote?.revote, lastTitle = byId(banned())?.title;
    if (canVote() && !mineTitle) dock.classList.add("myturn");
    title = revote ? "Revote: they all tied" : "Vote: which one goes?";
    const rule = revote ? (lastTitle ? `You can't pick ${lastTitle} again. ` : "Pick a different movie than last time. ") : "Most votes is out. ";
    sub = !joined() ? "Join the crew to vote." : mineTitle
      ? `You voted to cut ${mineTitle}. ${n} of ${v.length} voted. Tap another to change.`
      : `Tap the one you want gone. ${rule}${n} of ${v.length} voted.`;
    if (isHost()) buttons = `${n > 0 && n < v.length ? `<button class="btn" data-act="count">Count votes now</button>` : ""}<button class="btn" data-act="lobby">End round</button>`;
  } else {
    const w = byId(g.winner) || remaining()[0];
    title = w ? `Watch ${w.title}` : "Round over";
    sub = isHost() ? "Enjoy the movie. The lineup stays for next time." : `Enjoy the movie. ${nameOf(hostId(), "The host")} can start another round.`;
    if (isHost()) buttons = `<button class="btn primary" data-act="again">Play again</button>${w ? `<button class="btn" data-act="watched">Remove it &amp; play again</button>` : ""}`;
  }
  $("#dockMsg").innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
  $("#dockAct").innerHTML = buttons;
}

/* ================= Search ================= */

async function search(q) {
  const seq = ++searchSeq, box = $("#results");
  q = q.trim();
  if (!q) { box.hidden = true; box.innerHTML = ""; return; }
  const custom = `<li><button type="button" data-custom="${esc(q)}"><span class="thumb"></span><span class="t"><b>Add “${esc(q)}”</b><span>without a poster</span></span><span class="add">Add</span></button></li>`;
  if (!TMDB_API_KEY) { box.hidden = false; box.innerHTML = custom + `<li class="note">Add a TMDB key in config.js to search with posters.</li>`; return; }
  let data;
  try { data = await tmdb("/search/movie", { query: q, include_adult: "false" }); }
  catch { if (seq === searchSeq) { box.hidden = false; box.innerHTML = `<li class="note">Search isn't working right now. Check the TMDB key in config.js.</li>` + custom; } return; }
  if (seq !== searchSeq) return;
  const have = room?.movies || {};
  const rows = (data.results || []).slice(0, 8).map((r) => {
    const on = !!have["t" + r.id];
    const blocked = on || full();
    const year = (r.release_date || "").slice(0, 4);
    return `<li><button type="button" data-tmdb="${r.id}" ${blocked ? "disabled" : ""}>
      ${r.poster_path ? `<img class="thumb" alt="" src="${esc(poster(r.poster_path, "w92"))}">` : '<span class="thumb"></span>'}
      <span class="t"><b>${esc(r.title)}</b><span>${esc(year || "Year unknown")}</span></span>
      <span class="add">${on ? "On the wall" : blocked ? "Wall full" : "Add"}</span></button></li>`;
  });
  box.hidden = false;
  box.innerHTML = rows.length ? rows.join("") : `<li class="note">No movies match “${esc(q)}”.</li>` + custom;
}

async function addFromTmdb(id) {
  clearSearch();
  const key = "t" + id;
  if (!isHost()) return;
  if (room?.movies?.[key]) return toast("That one's already on the wall.");
  if (full()) return toast(`The wall is full. Remove a movie to add another (max ${MAX_MOVIES}).`);
  try {
    const d = await tmdb(`/movie/${id}`, { append_to_response: "credits" });
    const director = (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name).slice(0, 2).join(" & ");
    await be.set(`rooms/${code}/movies/${key}`, {
      title: d.title, year: (d.release_date || "").slice(0, 4) || null, poster: d.poster_path || null,
      runtime: d.runtime || null, director: director || null, overview: (d.overview || "").slice(0, 500) || null,
      tmdbId: d.id, addedBy: me, addedAt: Date.now(),
    });
  } catch (e) { console.error(e); toast("Couldn't add that movie. Try again."); }
}

async function addCustom(title) {
  clearSearch();
  title = title.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!title || !isHost()) return;
  if (full()) return toast(`The wall is full. Remove a movie to add another (max ${MAX_MOVIES}).`);
  if (movies().some((m) => m.title.toLowerCase() === title.toLowerCase())) return toast(`${title} is already on the wall.`);
  const key = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await guard(() => be.set(`rooms/${code}/movies/${key}`, { title, addedBy: me, addedAt: Date.now() }));
}

function clearSearch() { $("#searchInput").value = ""; searchSeq++; $("#results").hidden = true; $("#results").innerHTML = ""; }

/* ================= Game actions ================= */

const roomPath = (p = "") => `rooms/${code}${p ? "/" + p : ""}`;
const joinRoom = () => be.set(roomPath("players/" + me), { name: myName() || "Someone", joinedAt: Date.now() });

// One turn is used up (a cut or a skip). Once everyone has had their equal
// share of turns, whatever is left goes to a vote.
function afterTurn(g) {
  g.turns = (g.turns || 0) + 1;
  const left = (g.pool || []).filter((m) => !g.cuts?.[m]);
  if (left.length <= 1) { g.phase = "done"; g.winner = left[0] || null; g.vote = null; }
  else if (g.turns >= (g.quota || 0) * (g.order || []).length) { g.phase = "voting"; g.vote = { round: 1, ballots: {} }; }
  return g;
}

const actions = {
  join: () => guard(joinRoom),
  claimopen: () => { claimOpen = true; render(); $("#claimPinInput")?.focus(); },
  claimclose: () => { claimOpen = false; render(); },
  start: () => guard(async () => {
    if (!isHost() || movies().length < 2) return;
    if (!joined()) await joinRoom();
    const crew = [...new Set([...players().map((p) => p.id), me])];
    for (let i = crew.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [crew[i], crew[j]] = [crew[j], crew[i]]; }
    const { quota } = split(movies().length, crew.length);
    await be.set(roomPath("game"), {
      ...BLANK_GAME, order: crew, quota, pool: movies().map((m) => m.id), round: (game().round || 0) + 1, startedAt: Date.now(),
      ...(quota ? { phase: "playing" } : { phase: "voting", vote: { round: 1, ballots: {} } }),
    });
  }),
  skip: () => guard(() => be.txn(roomPath("game"), (g) => {
    if (!g) return g;
    if (g.phase !== "playing") return;
    return afterTurn(g);
  })),
  count: () => guard(() => tally(true)),
  lobby: () => guard(() => be.set(roomPath("game"), { ...BLANK_GAME, round: game().round || 0 })),
  again: () => guard(() => be.set(roomPath("game"), { ...BLANK_GAME, round: game().round || 0 })),
  watched: () => guard(async () => {
    const w = game().winner;
    await be.set(roomPath("game"), { ...BLANK_GAME, round: game().round || 0 });
    if (w) await be.remove(roomPath("movies/" + w));
  }),
};

async function cut(id) {
  pending = null;
  await guard(async () => {
    const ok = await be.txn(roomPath("game"), (g) => {
      if (!g) return g;
      const ord = g.order || [];
      const tp = ord.length ? ord[(g.turns || 0) % ord.length] : null;
      g.cuts = g.cuts || {};
      if (g.phase !== "playing" || tp !== me || g.cuts[id]) return;
      g.cuts[id] = { by: me, name: myName() || "Someone", n: Object.keys(g.cuts).length + 1, at: Date.now() };
      return afterTurn(g);
    });
    if (!ok) toast("Too late, the turn moved on.");
  });
}

async function castVote(id) {
  pending = null;
  if (!canVote() || game().cuts?.[id]) return;
  if (banned() === id) return toast("You picked that one last time. Choose a different movie.");
  await guard(() => be.set(roomPath(`game/vote/ballots/${me}`), id));
  tally(false).catch(() => {});
}

// Counts the vote once everyone in the room has voted (or right away when the
// host forces it). Most votes is out, and if several movies tie for most, they
// all go. If every movie still standing ties, there's a revote where nobody
// may pick the movie they just voted for; if that ties across the board too
// (or a revote couldn't change anything), one is drawn at random. Every phone may try this at once, so the transaction only
// goes through for the vote round it saw.
async function tally(force) {
  const g = game();
  if (g.phase !== "voting" || !g.vote) return;
  const b = ballots(), v = voters();
  const ready = force ? Object.keys(b).length > 0 : v.length > 0 && v.every((id) => b[id]);
  if (!ready) return;
  const round = g.vote.round;
  await be.txn(roomPath("game"), (x) => {
    if (!x) return x;
    if (x.phase !== "voting" || x.vote?.round !== round) return;
    x.cuts = x.cuts || {};
    const standing = (x.pool || []).filter((m) => !x.cuts[m]);
    const cast = x.vote.ballots || {};
    const counts = {};
    for (const [uid, id] of Object.entries(cast)) {
      if (standing.includes(id) && x.vote.banned?.[uid] !== id) counts[id] = (counts[id] || 0) + 1;
    }
    const ids = Object.keys(counts);
    if (!ids.length) return;
    const top = Math.max(...ids.map((id) => counts[id]));
    const tied = ids.filter((id) => counts[id] === top);
    const total = Object.keys(cast).length;
    // With two movies left, a revote can't change anything if everyone already
    // voted: each person has to switch, so the tie just flips. Skip straight to
    // the draw. Someone who didn't vote this time could still break it, though.
    const flipOnly = standing.length === 2 && v.every((id) => cast[id]);
    if (tied.length === standing.length && !x.vote.revote && !flipOnly) {
      x.vote = { round: round + 1, ballots: {}, revote: true, banned: { ...cast } };
      return x;
    }
    if (tied.length === standing.length) {
      const out = standing[Math.floor(Math.random() * standing.length)];
      x.cuts[out] = { by: "vote", random: true, n: Object.keys(x.cuts).length + 1, at: Date.now(), votes: top, of: total };
    } else {
      for (const id of tied) x.cuts[id] = { by: "vote", n: Object.keys(x.cuts).length + 1, at: Date.now(), votes: top, of: total, tie: tied.length > 1 };
    }
    const left = standing.filter((m) => !x.cuts[m]);
    if (left.length <= 1) { x.phase = "done"; x.winner = left[0] || null; x.vote = null; }
    else x.vote = { round: round + 1, ballots: {} };
    return x;
  });
}

/* ================= Rooms ================= */

function enterRoom(c) {
  store.set("fc-last-room", c);
  code = c; room = null; pending = null; seenCuts.clear();
  setURL(c);
  if (unwatch) unwatch();
  let first = true;
  unwatch = be.watch(roomPath(), (val) => {
    if (first && (!val || !val.meta)) { first = false; leaveRoom(); toast(`There's no room with the code ${c}.`); return; }
    if (first) { first = false; Object.keys(val.game?.cuts || {}).forEach((id) => seenCuts.add(id)); }
    room = val || {};
    const ph = room.game?.phase;
    if (pending && ((ph !== "playing" && ph !== "voting") || room.game?.cuts?.[pending])) pending = null;
    render();
    if (ph === "voting") tally(false).catch(() => {});
  }, (err) => { console.error(err); toast("Lost the connection to this room."); });
  render();
}

function leaveRoom() {
  store.set("fc-last-room", "");
  if (unwatch) unwatch();
  unwatch = null; code = null; room = null;
  setURL(null); render();
}

async function createRoom() {
  const pin = $("#pinInput").value.trim();
  if (!validPin(pin)) { $("#pinInput").focus(); return toast("Pick a 4-digit host PIN to start a room."); }
  for (let tries = 0; tries < 8; tries++) {
    const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
    const ok = await be.txn(`rooms/${c}/meta`, (m) => (m ? undefined : { createdAt: Date.now(), createdBy: me }));
    if (ok) {
      await be.set(`rooms/${c}/players/${me}`, { name: myName(), joinedAt: Date.now() });
      await savePin(c, pin).catch((e) => { console.error(e); toast("Room made, but the PIN didn't save. You can set it in the room."); });
      $("#pinInput").value = "";
      return enterRoom(c);
    }
  }
  toast("Couldn't make a room. Try again.");
}

async function joinByCode(c) {
  c = c.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(c)) return toast("Room codes are 4 letters.");
  const meta = await be.get(`rooms/${c}/meta`);
  if (!meta) return toast(`There's no room with the code ${c}.`);
  await be.set(`rooms/${c}/players/${me}`, { name: myName() || "Someone", joinedAt: Date.now() });
  enterRoom(c);
}

/* ================= Events ================= */

function saveName() {
  const n = $("#nameInput").value.trim().slice(0, 24);
  if (!n) { $("#nameInput").focus(); toast("Add your name first."); return false; }
  store.set("fc-name", n); return true;
}

$("#nameForm").addEventListener("submit", (e) => { e.preventDefault(); if (saveName()) createRoom().catch(failConn); });
$("#rejoinBtn").addEventListener("click", () => {
  const last = store.get("fc-last-room");
  if (!last) return;
  if (!myName()) { $("#codeInput").value = last; $("#nameInput").focus(); return toast("Add your name first."); }
  joinByCode(last).catch((e) => { failConn(e); store.set("fc-last-room", ""); render(); });
});
$("#hostPanel").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target.dataset.form;
  if (form === "setpin") {
    const pin = $("#setPinInput").value.trim();
    if (!validPin(pin)) return toast("The PIN is 4 digits.");
    guard(async () => { await savePin(code, pin); toast("Host PIN saved."); });
  }
  if (form === "claim") claimHost($("#claimPinInput").value.trim());
});
$("#joinBtn").addEventListener("click", () => { if (saveName()) joinByCode($("#codeInput").value).catch(failConn); });
$("#codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#joinBtn").click(); } });
$("#leaveBtn").addEventListener("click", async () => {
  if (code && me && game().phase === "lobby") await be.remove(roomPath("players/" + me)).catch(() => {});
  leaveRoom();
});
$("#inviteBtn").addEventListener("click", async () => {
  const url = inviteLink();
  if (navigator.share) { try { await navigator.share({ title: "Final Cut", text: `Join my Final Cut room: ${code}`, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(url); toast(`Link copied. Room code ${code}.`); }
  catch { toast(`Share this link: ${url}`); }
});

let debounce;
$("#searchInput").addEventListener("input", (e) => { clearTimeout(debounce); const v = e.target.value; debounce = setTimeout(() => search(v), 250); });
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSearch();
  if (e.key === "Enter") { e.preventDefault(); $("#results button:not(:disabled)")?.click(); }
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t || !code || !room) return;
  const d = t.dataset;
  if (d.act && actions[d.act]) return actions[d.act]();
  if (d.tmdb) return addFromTmdb(d.tmdb);
  if (d.custom !== undefined) return addCustom(d.custom);
  if (d.pick) {
    if (!(myTurn() || canVote()) || game().cuts?.[d.pick]) return;
    if (canVote() && banned() === d.pick) return toast("You picked that one last time. Choose a different movie.");
    pending = pending === d.pick ? null : d.pick; render();
    document.querySelector(`[data-cut="${d.pick}"]`)?.focus();
    return;
  }
  if (d.cut) return cut(d.cut);
  if (d.vote) return castVote(d.vote);
  if ("keep" in d) { pending = null; return render(); }
  if (d.remove) return guard(() => be.remove(roomPath("movies/" + d.remove)));
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pending) { pending = null; render(); } });
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".search")) $("#results").hidden = true; });

function failConn(e) { console.error(e); toast("Couldn't reach the room server. Check your connection."); }

/* ================= Boot ================= */

async function boot() {
  $("#nameInput").value = myName();
  const wanted = (params.get("room") || "").toUpperCase();
  if (wanted) $("#codeInput").value = wanted;

  if (!DEMO && !FIREBASE_CONFIG) {
    const b = $("#banner"); b.hidden = false;
    b.innerHTML = `<b>Almost ready.</b> Add your Firebase settings to <code>config.js</code> so friends can play together. Until then you can <a href="?demo">try the demo</a>, which runs on this device only (open a few tabs to play several people).`;
    $("#landing").hidden = false; $("#createBtn").disabled = true; $("#joinBtn").disabled = true;
    $("#status").textContent = "Setup needed";
    return;
  }
  if (DEMO) { const b = $("#banner"); b.hidden = false; b.innerHTML = "<b>Demo mode.</b> Everything stays on this device. Open this page in a few tabs to play as several people."; }

  try { be = DEMO ? demoBackend() : await firebaseBackend(FIREBASE_CONFIG); }
  catch (e) {
    console.error(e);
    const b = $("#banner"); b.hidden = false;
    b.innerHTML = "<b>Couldn't connect.</b> Check the Firebase settings in <code>config.js</code> and that Anonymous sign-in is turned on.";
    $("#status").textContent = "Offline"; return;
  }
  me = be.uid;

  if (wanted && myName()) {
    try { await joinByCode(wanted); } catch (e) { failConn(e); render(); }
  } else render();
}

boot();
