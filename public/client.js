// ============================================================
//  CHESS GAME — BROWSER CODE
//  Runs inside each player's browser. It:
//    - draws the board and player bars
//    - lets you drag (or click) pieces to move them
//    - plays sounds
//    - sends moves, chat, resign & draw offers to the server
//    - keeps a BACKUP of the game in the browser, so the game
//      survives even if the server restarts
// ============================================================

import { Chess } from "/lib/chess.js";
import { Computer, LEVELS, levelFor } from "./computer.js";

// The coaches (names, ratings, personalities) live in coaches.json,
// which the server also uses for the AI coach.
const COACHES = await fetch("coaches.json").then((r) => r.json()).catch(() => []);
const coachById = (id) => COACHES.find((c) => c.id === id);

// Are accounts switched on, and am I logged in? (asks the server)
const meInfo = await fetch("api/me").then((r) => r.json()).catch(() => ({ accounts: false, user: null }));
const accountsOn = !!meInfo.accounts;
const me = meInfo.user; // { username, ratings } when logged in, otherwise null
if (me) {
  try { localStorage.setItem("chessName", JSON.stringify(me.username)); } catch {}
}

const socket = io();
const $ = (id) => document.getElementById(id);
const boardEl = $("board");

// ---------- Game state (in this browser) ----------
let roomId = null;
let myColor = null;        // "w", "b" or null (spectator)
let game = new Chess();    // local copy of the game
let moves = [];            // ["e2e4", "e7e5", ...]
let lastMove = null;
let status = { over: false };
let players = { w: null, b: null };
let drawOffer = null;
let selected = null;       // the square you picked up, e.g. "e2"
let flipped = false;       // "Flip" button
let chat = [];             // chat messages, kept for the backup
let firstState = true;
let spectators = 0;
let clockData = null;      // the clocks, as last sent by the server
let clockReceivedAt = 0;   // when we got them (to count down smoothly)
let ratingChange = null;   // { w: +8, b: -8 } after a rated game

const pieceImg = (color, type) => `pieces/${color}${type.toUpperCase()}.svg`;

// ============================================================
//  SAVING THINGS IN THE BROWSER (localStorage)
//  A little notebook the browser keeps for this website, even
//  after a refresh. try/catch: private mode may not allow it.
// ============================================================
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// A random id that identifies THIS browser, so the server can
// give you your seat back when you refresh.
let playerId = load("chessPlayerId");
if (typeof playerId !== "string") {
  playerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  save("chessPlayerId", playerId);
}

// The backup copy of a game, stored under the room's id.
function saveBackup() {
  if (!roomId) return;
  save("chessGame:" + roomId, {
    moves,
    color: myColor,
    result: status.type ? { type: status.type, loser: status.loser } : null,
    chat: chat.slice(-100),
    meta: roomMeta ? { name: roomMeta.name, isPrivate: roomMeta.isPrivate, clock: roomMeta.clock } : null,
    timeLeft: clockData ? { w: shownTime("w"), b: shownTime("b") } : null,
  });
}

// ============================================================
//  MAIN MENU (LOBBY)
// ============================================================
const params = new URLSearchParams(location.search);
roomId = params.get("room");
const wantsToWatch = params.get("watch") === "1";
const botMode = params.get("vs") === "computer";   // playing the computer?
let roomMeta = null;       // { name, isPrivate, code } of the current game
let gameList = [];         // public games, sent by the server
$("name-input").value = load("chessName") || "";

function showNotice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
  if (text) window.scrollTo({ top: 0, behavior: "smooth" });
}

// Read the name box. If it's empty, ask for a name and return null.
function getName() {
  const name = $("name-input").value.trim();
  if (!name) {
    showNotice("Please enter your name first.");
    $("name-input").focus();
    return null;
  }
  save("chessName", name);
  return name;
}

// Open a game. This loads the page again with ?room=... in the
// address, so the link can be shared and refreshing works.
function goToRoom(id, watch) {
  location.href = location.pathname + "?room=" + encodeURIComponent(id) + (watch ? "&watch=1" : "");
}

function showMenu() {
  $("lobby").hidden = false;
  $("game").hidden = true;
  $("invite-card").hidden = !roomId;          // came from an invite link
  $("continue-card").hidden = !!roomId || !load("chessLastRoom");
  if (load("chessLastRoom") === "computer") {
    const c = coachById(load("chessBot")?.coach);
    $("continue-btn").textContent = c ? `${c.emoji} Continue your lesson with ${c.name}` : "🤖 Continue your game vs the computer";
  }
  if (params.get("notfound")) {
    showNotice("That game doesn't exist any more. Create a new one or pick one from the list!");
    history.replaceState(null, "", location.pathname);
  }
  socket.emit("watchLobbies");
}

// The Public/Private and White/Random/Black pickers.
function setupToggle(id, onChange) {
  const box = $(id);
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    if (onChange) onChange(btn.dataset.value);
  });
}
const toggleValue = (id) => $(id).querySelector(".on").dataset.value;

setupToggle("visibility", (v) => {
  $("visibility-hint").textContent =
    v === "private"
      ? "Hidden from the list. Friends need the secret code (or your link) to join."
      : "Anyone can see it in the list and join to play or watch.";
});
setupToggle("color-pick");

// ---------- Play vs Computer ----------
// Make one button per difficulty level.
for (const lv of LEVELS) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.value = lv.rating;
  b.innerHTML = `<span class="lv-num"></span><span class="lv-name"></span>`;
  b.querySelector(".lv-num").textContent = lv.rating;
  b.querySelector(".lv-name").textContent = lv.label;
  $("bot-level").appendChild(b);
}
function showLevelHint(rating) {
  const lv = levelFor(rating);
  $("bot-level-hint").textContent = `${lv.label} (${lv.rating}): ${lv.about}`;
}
// Start on the level picked last time (or 800).
const savedLevel = load("chessBotLevel") || 800;
$("bot-level").querySelector(`[data-value="${savedLevel}"]`)?.classList.add("on");
if (!$("bot-level").querySelector(".on")) $("bot-level").firstChild.classList.add("on");
showLevelHint(toggleValue("bot-level"));
setupToggle("bot-level", showLevelHint);
setupToggle("bot-color");

$("bot-btn").addEventListener("click", () => {
  const name = $("name-input").value.trim();
  if (name) save("chessName", name);
  const rating = Number(toggleValue("bot-level"));
  let color = toggleValue("bot-color");
  if (color === "random") color = Math.random() < 0.5 ? "w" : "b";
  save("chessBotLevel", rating);
  save("chessBot", { rating, color, moves: [], result: null });
  save("chessLastRoom", "computer");
  location.href = location.pathname + "?vs=computer";
});

// ---------- Learn with a Coach ----------
for (const c of COACHES) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.value = c.id;
  b.innerHTML = '<span class="c-emoji"></span><span class="c-name"></span><span class="c-rating"></span>';
  b.querySelector(".c-emoji").textContent = c.emoji;
  b.querySelector(".c-name").textContent = c.name.replace("Coach ", "");
  b.querySelector(".c-rating").textContent = c.rating;
  $("coach-pick").appendChild(b);
}
function showCoachHint(id) {
  const c = coachById(id);
  if (c) $("coach-hint").textContent = `${c.emoji} ${c.name} (${c.rating}, ${c.title}): ${c.specialty}.`;
}
if (COACHES.length) {
  const savedCoach = load("chessCoach");
  const first = $("coach-pick").querySelector(`[data-value="${savedCoach}"]`) || $("coach-pick").children[1] || $("coach-pick").firstChild;
  first.classList.add("on");
  showCoachHint(first.dataset.value);
  setupToggle("coach-pick", showCoachHint);
}
setupToggle("coach-color");

// Is the AI switched on? (Shown under the button.)
fetch("api/coach/status")
  .then((r) => r.json())
  .then((s) => {
    $("coach-ai-status").textContent = s.ai
      ? "✨ Coaches are powered by AI."
      : "Coaches are using built-in tips (the AI isn't switched on yet).";
  })
  .catch(() => {});

$("coach-btn").addEventListener("click", () => {
  const name = $("name-input").value.trim();
  if (name) save("chessName", name);
  const coach = coachById(toggleValue("coach-pick"));
  if (!coach) return;
  let color = toggleValue("coach-color");
  if (color === "random") color = Math.random() < 0.5 ? "w" : "b";
  save("chessCoach", coach.id);
  save("chessBot", { rating: coach.rating, color, moves: [], result: null, coach: coach.id, chat: [], marks: [] });
  save("chessLastRoom", "computer");
  location.href = location.pathname + "?vs=computer";
});

// Suggest a game name based on the player's name.
function updateGameNamePlaceholder() {
  const n = $("name-input").value.trim();
  $("game-name").placeholder = n ? `${n}'s game` : "e.g. Friday night chess";
}
$("name-input").addEventListener("input", () => { updateGameNamePlaceholder(); showNotice(""); });
updateGameNamePlaceholder();

// ---------- Create a game ----------
$("create-btn").addEventListener("click", () => {
  const name = getName();
  if (!name) return;
  $("create-btn").disabled = true;
  socket.emit(
    "create",
    {
      playerId,
      playerName: name,
      gameName: $("game-name").value.trim() || `${name}'s game`,
      isPrivate: toggleValue("visibility") === "private",
      color: toggleValue("color-pick"),
      clock: chosenClock(),
      rated: !!me && !!chosenClock() && toggleValue("rated-pick") === "rated",
    },
    (reply) => {
      $("create-btn").disabled = false;
      if (reply.error) showNotice(reply.error);
      else goToRoom(reply.roomId);
    }
  );
});

// ---------- Join a private game with a code ----------
$("code-btn").addEventListener("click", () => {
  const name = getName();
  if (!name) return;
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length !== 6) {
    showNotice("Private game codes are 6 characters long.");
    return;
  }
  socket.emit("checkCode", code, (reply) => {
    if (reply.ok) goToRoom(reply.code);
    else showNotice(`No private game found with the code "${code}". Check it and try again.`);
  });
});
$("code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("code-btn").click();
});

$("invite-join-btn").addEventListener("click", () => {
  if (getName()) enterGame();
});
$("continue-btn").addEventListener("click", () => {
  if (load("chessLastRoom") === "computer") location.href = location.pathname + "?vs=computer";
  else if (getName()) goToRoom(load("chessLastRoom"));
});

// ---------- The live list of public games ----------
socket.on("lobbies", (list) => {
  gameList = list;
  drawGameList();
});

function seatLabel(color, p) {
  const span = document.createElement("span");
  const img = document.createElement("img");
  img.src = pieceImg(color, "k");
  img.alt = "";
  span.appendChild(img);
  if (p) {
    span.append(p.name + (p.rating ? ` (${p.rating})` : "") + (p.online ? "" : " · offline"));
  } else {
    const open = document.createElement("span");
    open.className = "open";
    open.textContent = "Open seat";
    span.appendChild(open);
  }
  return span;
}

function drawGameList() {
  const box = $("game-list");
  box.innerHTML = "";
  if (gameList.length === 0) {
    box.innerHTML =
      '<div class="games-empty">No public games right now.<br>Create one and it will show up here for everyone!</div>';
    return;
  }
  for (const g of gameList) {
    const row = document.createElement("div");
    row.className = "game-row";

    const info = document.createElement("div");
    info.style.minWidth = "0";
    const name = document.createElement("div");
    name.className = "game-row-name";
    name.textContent = g.name;

    const ps = document.createElement("div");
    ps.className = "game-row-players";
    const vs = document.createElement("span");
    vs.className = "vs";
    vs.textContent = "vs";
    ps.append(seatLabel("w", g.players.w), vs, seatLabel("b", g.players.b));

    const meta = document.createElement("div");
    meta.className = "game-row-meta";
    const badge = document.createElement("span");
    badge.className = "badge " + g.state;
    badge.textContent = { waiting: "Waiting", playing: "Playing", finished: "Finished" }[g.state];
    const detail =
      g.state === "waiting" ? "Needs a player" : g.state === "playing" ? `Move ${g.moveCount}` : "Game over";
    const tc = document.createElement("span");
    tc.className = "tc-tag";
    tc.textContent = g.clock ? `${CATEGORY_ICONS[g.category] || ""} ${g.clock}` : "♾️ No clock";
    meta.append(tc, badge);
    if (g.rated) {
      const r = document.createElement("span");
      r.className = "badge rated";
      r.textContent = "Rated";
      meta.append(r);
    }
    meta.append(`${detail} · 👁 ${g.spectators} watching`);
    info.append(name, ps, meta);

    const buttons = document.createElement("div");
    buttons.className = "game-row-buttons";
    if (g.openSeat) {
      const play = document.createElement("button");
      play.className = "btn btn-primary";
      play.textContent = "Play";
      play.addEventListener("click", () => { if (getName()) goToRoom(g.id); });
      buttons.appendChild(play);
    }
    const watch = document.createElement("button");
    watch.className = "btn btn-secondary";
    watch.textContent = "Watch";
    watch.addEventListener("click", () => { if (getName()) goToRoom(g.id, true); });
    buttons.appendChild(watch);

    row.append(info, buttons);
    box.appendChild(row);
  }
}

// ============================================================
//  ENTERING AND LEAVING A GAME
// ============================================================
function enterGame() {
  save("chessLastRoom", roomId);
  $("invite-link").value = location.origin + location.pathname + "?room=" + roomId;
  $("lobby").hidden = true;
  $("game").hidden = false;
  chat = load("chessGame:" + roomId)?.chat || [];
  joinRoom();
}

function joinRoom() {
  socket.emit("join", {
    room: roomId,
    name: load("chessName") || "Player",
    playerId,
    want: wantsToWatch ? "watch" : "play",
    backup: load("chessGame:" + roomId), // lets the server restore the game
  });
}

function forgetThisGame() {
  try {
    localStorage.removeItem("chessLastRoom");
    localStorage.removeItem("chessGame:" + roomId);
  } catch {}
}

// "← Menu" button: leave the game and go back to the main menu.
$("menu-btn").addEventListener("click", () => {
  if (botMode) {
    // Computer games are saved, so you can continue later.
    if (status.over) forgetThisGame();
    location.href = location.pathname;
    return;
  }
  const playing = myColor && !status.over && players.w && players.b && moves.length > 0;
  if (playing && !confirm("Leave this game? Leaving in the middle of a game counts as resigning.")) return;
  forgetThisGame();
  const goHome = () => (location.href = location.pathname);
  socket.emit("leave", goHome);
  setTimeout(goHome, 1500); // just in case the server doesn't answer
});

// The server doesn't know this game (and we had no backup).
socket.on("notFound", () => {
  forgetThisGame();
  location.replace(location.pathname + "?notfound=1");
});


// ============================================================
//  SOUNDS — made with the Web Audio API, no sound files needed
// ============================================================
let audio = null;
function unlockAudio() {
  // Browsers only allow sound after the user clicks something.
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  if (audio?.state === "suspended") audio.resume();
}
document.addEventListener("pointerdown", unlockAudio);

function beep(freq, start, length, volume = 0.25, type = "triangle") {
  if (!audio) return;
  const t = audio.currentTime + start;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + length);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length);
}
const sounds = {
  move:    () => beep(220, 0, 0.08, 0.35),
  capture: () => { beep(300, 0, 0.06, 0.35); beep(160, 0.05, 0.1, 0.35); },
  check:   () => { beep(660, 0, 0.12, 0.2, "square"); beep(880, 0.1, 0.15, 0.15, "square"); },
  castle:  () => { beep(220, 0, 0.07, 0.35); beep(220, 0.1, 0.07, 0.35); },
  end:     () => { beep(523, 0, 0.2, 0.2, "sine"); beep(659, 0.15, 0.2, 0.2, "sine"); beep(784, 0.3, 0.4, 0.2, "sine"); },
  notify:  () => { beep(587, 0, 0.12, 0.15, "sine"); beep(880, 0.12, 0.2, 0.15, "sine"); },
};
function playMoveSound(m) {
  if (!m) return;
  if (m.san.includes("+") || m.san.includes("#")) sounds.check();
  else if (m.flags.includes("k") || m.flags.includes("q")) sounds.castle();
  else if (m.captured) sounds.capture();
  else sounds.move();
}

// ============================================================
//  DRAWING THE BOARD
// ============================================================
const FILES = "abcdefgh";
const isWhiteBottom = () => (myColor === "b") === flipped;

function legalTargets(square) {
  return game.moves({ square, verbose: true });
}

function drawBoard() {
  boardEl.innerHTML = "";
  const whiteBottom = isWhiteBottom();
  const targets = selected ? legalTargets(selected) : [];

  // Find the king in check, if any.
  let checkSquare = null;
  if (game.inCheck()) {
    for (const row of game.board())
      for (const p of row)
        if (p && p.type === "k" && p.color === game.turn()) checkSquare = p.square;
  }

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = whiteBottom ? FILES[col] : FILES[7 - col];
      const rank = whiteBottom ? 8 - row : row + 1;
      const square = file + rank;

      const el = document.createElement("div");
      el.className = "square " + ((col + row) % 2 === 0 ? "light" : "dark");
      el.dataset.square = square;
      if (lastMove && (square === lastMove.from || square === lastMove.to)) el.classList.add("hl");
      if (square === selected) el.classList.add("hl");
      if (square === checkSquare) el.classList.add("check");
      if (hintMove && square === hintMove.from) el.classList.add("hint-from");
      if (hintMove?.reveal && square === hintMove.to) el.classList.add("hint-to");
      const t = targets.find((m) => m.to === square);
      if (t) el.classList.add("target", t.captured ? "capture" : "move");

      const piece = game.get(square);
      if (piece) {
        const img = document.createElement("img");
        img.className = "piece";
        img.src = pieceImg(piece.color, piece.type);
        img.alt = "";
        img.draggable = false;
        el.appendChild(img);
      }
      // Letters along the bottom, numbers down the left.
      if (row === 7) addCoord(el, "file", file);
      if (col === 0) addCoord(el, "rank", rank);
      boardEl.appendChild(el);
    }
  }
}

function addCoord(el, type, text) {
  const s = document.createElement("span");
  s.className = "coord " + type;
  s.textContent = text;
  el.appendChild(s);
}

// ============================================================
//  MOVING PIECES — drag them, or click then click
// ============================================================
const canMove = () =>
  myColor && !status.over && game.turn() === myColor && players.w && players.b && $("promotion").hidden;

let drag = null; // info about the piece being dragged

boardEl.addEventListener("pointerdown", (e) => {
  const sqEl = e.target.closest(".square");
  if (!sqEl || !canMove() || e.button > 0) return;
  e.preventDefault();
  const square = sqEl.dataset.square;
  const piece = game.get(square);

  // Already holding a piece and clicked a square it can go to.
  if (selected && legalTargets(selected).some((m) => m.to === square)) {
    tryMove(selected, square);
    return;
  }
  if (piece && piece.color === myColor) {
    const wasSelected = selected === square;
    selected = square;
    drawBoard();
    startDrag(e, square, piece, wasSelected);
  } else {
    selected = null;
    drawBoard();
  }
});

function startDrag(e, square, piece, wasSelected) {
  const size = boardEl.getBoundingClientRect().width / 8;
  const ghost = document.createElement("img");
  ghost.src = pieceImg(piece.color, piece.type);
  ghost.className = "ghost";
  ghost.style.width = ghost.style.height = size + "px";
  ghost.style.left = e.clientX + "px";
  ghost.style.top = e.clientY + "px";
  document.body.appendChild(ghost);
  boardEl.querySelector(`[data-square="${square}"] .piece`)?.classList.add("lifted");
  drag = { from: square, ghost, wasSelected, hover: null };
}

function squareAt(x, y) {
  return document.elementFromPoint(x, y)?.closest?.(".square") || null;
}

window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.ghost.style.left = e.clientX + "px";
  drag.ghost.style.top = e.clientY + "px";
  const sq = squareAt(e.clientX, e.clientY);
  if (sq !== drag.hover) {
    drag.hover?.classList.remove("hover");
    sq?.classList.add("hover");
    drag.hover = sq;
  }
});

function endDrag(e) {
  if (!drag) return;
  const { from, ghost, wasSelected } = drag;
  drag = null;
  ghost.remove();
  const sq = e && squareAt(e.clientX, e.clientY);
  const to = sq?.dataset.square;
  if (to && to !== from && legalTargets(from).some((m) => m.to === to)) {
    tryMove(from, to);
  } else {
    // Dropped back on its own square: a click. Clicking a
    // selected piece again puts it down.
    if (to === from && wasSelected) selected = null;
    drawBoard();
  }
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", () => endDrag(null));

function tryMove(from, to) {
  const move = legalTargets(from).find((m) => m.to === to);
  if (!move) return;
  if (move.promotion) {
    showPromotion(from, to);
    return;
  }
  sendMove(from, to);
}

function sendMove(from, to, promotion) {
  // Show the move straight away; the server then confirms it.
  const m = game.move({ from, to, promotion: promotion || "q" });
  moves = [...moves, from + to + (m.promotion || "")];
  lastMove = { from, to };
  selected = null;
  playMoveSound(m);
  render();
  if (botMode) botPlayerMoved(m);
  else socket.emit("move", { from, to, promotion });
}

// Pawn reached the end: pick what it turns into.
function showPromotion(from, to) {
  const box = $("promotion");
  box.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "promo-box";
  for (const p of ["q", "r", "b", "n"]) {
    const btn = document.createElement("button");
    const img = document.createElement("img");
    img.src = pieceImg(myColor, p);
    img.alt = p;
    btn.appendChild(img);
    btn.addEventListener("click", () => {
      box.hidden = true;
      sendMove(from, to, p);
    });
    inner.appendChild(btn);
  }
  box.appendChild(inner);
  box.onclick = (e) => {
    if (e.target === box) { box.hidden = true; selected = null; drawBoard(); }
  };
  box.hidden = false;
}

// ============================================================
//  PLAYER BARS (name, captured pieces, whose turn)
// ============================================================
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };

function capturedBy(color) {
  // Count what's left of the OTHER side's pieces.
  const enemy = color === "w" ? "b" : "w";
  const left = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  let material = { w: 0, b: 0 };
  for (const row of game.board())
    for (const p of row)
      if (p && p.type !== "k") {
        material[p.color] += VALUES[p.type];
        if (p.color === enemy) left[p.type]++;
      }
  const taken = [];
  for (const t of ["p", "b", "n", "r", "q"])
    for (let i = 0; i < Math.max(0, START[t] - left[t]); i++) taken.push(t);
  return { taken, enemy, advantage: material[color] - material[enemy] };
}

function drawPlayerBar(el, color) {
  el.innerHTML = "";
  el.dataset.color = color;
  el.classList.toggle("active", !status.over && game.turn() === color && !!players.w && !!players.b);
  const p = players[color];

  const avatar = document.createElement("div");
  avatar.className = "avatar " + color + (p?.bot ? " bot" : "");
  avatar.textContent = p?.bot ? p.emoji || "🤖" : p ? p.name[0].toUpperCase() : "?";
  const dot = document.createElement("span");
  dot.className = "dot" + (p?.online ? " on" : "");
  dot.title = p?.online ? "Online" : "Offline";
  avatar.appendChild(dot);

  const info = document.createElement("div");
  info.className = "player-info";
  const name = document.createElement("div");
  name.className = "player-name";
  name.textContent = p ? p.name : "Waiting for opponent…";
  if (p?.rating) {
    const r = document.createElement("span");
    r.className = "p-rating";
    r.textContent = `(${p.rating})`;
    name.appendChild(r);
  }
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = p && color === myColor ? "(you)" : p && !p.online ? "(offline)" : "";
  name.appendChild(tag);

  const cap = document.createElement("div");
  cap.className = "captured";
  const { taken, enemy, advantage } = capturedBy(color);
  for (const t of taken) {
    const img = document.createElement("img");
    img.src = pieceImg(enemy, t);
    img.alt = "";
    cap.appendChild(img);
  }
  if (advantage > 0) {
    const adv = document.createElement("span");
    adv.className = "adv";
    adv.textContent = "+" + advantage;
    cap.appendChild(adv);
  }
  info.append(name, cap);

  let turn;
  if (clockData) {
    // A chess clock instead of the "White"/"Black" label.
    turn = document.createElement("div");
    turn.className = "clock";
    turn.dataset.color = color;
  } else {
    turn = document.createElement("div");
    turn.className = "turn-box";
    turn.textContent = color === "w" ? "White" : "Black";
  }

  el.append(avatar, info, turn);
}

// ============================================================
//  SIDE PANEL (status, moves list, buttons)
// ============================================================
function drawMoves() {
  const box = $("moves");
  box.innerHTML = "";
  const san = game.history();
  if (san.length === 0) {
    box.innerHTML = '<div class="moves-empty">Moves will appear here</div>';
    return;
  }
  for (let i = 0; i < san.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-row";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i / 2 + 1 + ".";
    row.appendChild(num);
    for (const j of [i, i + 1]) {
      const mv = document.createElement("span");
      mv.className = "mv" + (j === san.length - 1 ? " current" : "");
      mv.textContent = san[j] || "";
      const mark = botMode && bot?.marks?.[j];
      if (mark && MARKS[mark]) {
        const badge = document.createElement("span");
        badge.className = "mark " + mark;
        badge.textContent = MARKS[mark];
        badge.title = mark;
        mv.appendChild(badge);
      }
      row.appendChild(mv);
    }
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

function drawPanel() {
  const opp = myColor === "w" ? "b" : "w";
  const waiting = !players.w || !players.b;
  $("invite").hidden = !waiting;
  if (roomMeta) {
    $("room-name").textContent = roomMeta.name;
    document.title = roomMeta.name + " · Chess with Friends";
    // e.g. "⚡ 3 | 2 · 🏆 Rated · 🌍 Public"
    const timeText = clockData ? `${CATEGORY_ICONS[roomMeta.category] || ""} ${clockData.label}` : "♾️ No clock";
    $("room-kind").textContent = roomMeta.coach
      ? "🎓 Coach lesson"
      : roomMeta.bot
        ? "🤖 Computer game"
        : [timeText, roomMeta.rated ? "🏆 Rated" : null, roomMeta.isPrivate ? "🔒 Private" : "🌍 Public"].filter(Boolean).join(" · ");
    $("code-box").hidden = !roomMeta.isPrivate;
    $("room-code").textContent = roomMeta.code || "";
  }
  $("watchers").textContent = spectators;

  let text = "";
  if (status.over) text = `${status.title} ${status.reason}`;
  else if (waiting) text = "Waiting for your opponent — send them the invite link!";
  else if (!myColor) text = "You are watching this game.";
  else if (game.turn() === myColor) text = game.inCheck() ? "Your move — you're in check!" : "Your move";
  else text = botMode ? `${players[opp].name.replace(/ \(\d+\)$/, "")} is thinking` : `Waiting for ${players[opp].name} to move…`;
  $("status").classList.toggle("thinking", botMode && !status.over && game.turn() !== myColor);
  if (myColor && players[opp] && !players[opp].online && !status.over) {
    text += ` (${players[opp].name} is offline)`;
  }
  $("status").textContent = text;

  // Draw offer from the opponent?
  const offered = drawOffer && myColor && drawOffer !== myColor;
  $("draw-offer").hidden = !offered;
  if (offered) $("draw-offer-text").textContent = `${players[drawOffer]?.name || "Opponent"} offers a draw`;

  // Buttons
  const playing = myColor && !status.over && !waiting;
  $("draw-btn").disabled = !playing || !!drawOffer || moves.length < 2;
  $("resign-btn").disabled = !playing;
  $("new-game-btn").hidden = !myColor;
  $("new-game-btn").disabled = waiting && moves.length === 0;
  $("draw-btn").hidden = $("resign-btn").hidden = !myColor;

  $("watch-info").hidden = botMode;
  if (botMode) {
    // Against the computer the "Draw" button becomes "Takeback".
    $("draw-btn").textContent = "↶ Undo";
    $("draw-btn").title = "Take back your last move";
    $("draw-btn").disabled = myMoveCount() === 0 || status.type === "resign";
    $("new-game-btn").disabled = false;
    $("hint-btn").hidden = !coach;
    $("hint-btn").disabled = status.over || game.turn() !== myColor;
    $("hint-btn").textContent = hintMove && !hintMove.reveal ? "💡 Answer" : "💡 Hint";
  }
}

function render() {
  drawBoard();
  const bottom = isWhiteBottom() ? "w" : "b";
  drawPlayerBar($("bottom-bar"), bottom);
  drawPlayerBar($("top-bar"), bottom === "w" ? "b" : "w");
  updateClocks();
  drawMoves();
  drawPanel();
}

// ============================================================
//  BUTTONS
// ============================================================
$("copy-btn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("invite-link").value);
    $("copy-btn").textContent = "Copied!";
  } catch {
    $("invite-link").select();
  }
  setTimeout(() => ($("copy-btn").textContent = "Copy link"), 1500);
});
$("flip-btn").addEventListener("click", () => { flipped = !flipped; render(); });
$("resign-btn").addEventListener("click", () => {
  if (!confirm("Are you sure you want to resign?")) return;
  if (botMode) botResign();
  else socket.emit("resign");
});
$("draw-btn").addEventListener("click", () => {
  if (botMode) botTakeback();
  else socket.emit("offerDraw");
});
$("accept-draw").addEventListener("click", () => socket.emit("answerDraw", true));
$("decline-draw").addEventListener("click", () => socket.emit("answerDraw", false));
$("new-game-btn").addEventListener("click", () => {
  if (status.over || moves.length === 0 || confirm("Start a new game? This game will be lost.")) {
    if (botMode) botNewGame();
    else socket.emit("newGame");
  }
});
$("rematch-btn").addEventListener("click", () => {
  $("gameover").hidden = true;
  if (botMode) botNewGame();
  else socket.emit("newGame");
});
$("gameover-close").addEventListener("click", () => ($("gameover").hidden = true));

// ============================================================
//  MESSAGES FROM THE SERVER
// ============================================================
socket.on("state", (s) => applyState(s));

// Show a new game state (from the server, or from the computer game).
function applyState(s) {
  const prevMoveCount = game.history().length;
  const wasOver = status.over;
  const hadOpponent = players.w && players.b;

  // Rebuild the game from the list of moves.
  const g = new Chess();
  for (const m of s.moves) g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  const newMove = !firstState && s.moves.length === prevMoveCount + 1 && moves.length < s.moves.length;

  game = g;
  moves = s.moves;
  lastMove = s.lastMove;
  status = s.status;
  players = s.players;
  drawOffer = s.drawOffer;
  roomMeta = s.meta;
  spectators = s.spectators;
  clockData = s.clock || null;
  clockReceivedAt = performance.now();
  ratingChange = s.ratingChange || null;
  lowTimeWarned = clockData && shownTime(myColor) < 10000 ? lowTimeWarned : false;
  if (myColor !== s.you) flipped = false;
  myColor = s.you;
  if (!drag) selected = null;

  // Sounds: opponent moved, game ended, opponent arrived.
  if (newMove) playMoveSound(game.history({ verbose: true }).at(-1));
  if (!firstState && status.over && !wasOver) {
    sounds.end();
    $("gameover-title").textContent = status.title;
    $("gameover-reason").textContent = status.reason;
    $("gameover").hidden = false;
  }
  if (!status.over) $("gameover").hidden = true;
  showRatingChange();
  if (!firstState && !hadOpponent && players.w && players.b) sounds.notify();

  firstState = false;
  render();
  if (!botMode) saveBackup();
}

socket.on("errorMessage", (msg) => addMessage({ system: true, text: msg }, false));

// ============================================================
//  CHAT
// ============================================================
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault(); // stop the page reloading
  const text = $("chat-input").value.trim();
  if (!text) return;
  $("chat-input").value = "";
  if (botMode && coach) askCoach(text);
  else socket.emit("chat", text);
});

socket.on("chatLog", (log) => {
  $("messages").innerHTML = "";
  chat = [];
  log.forEach((m) => addMessage(m));
});
socket.on("chat", (m) => {
  addMessage(m);
  saveBackup();
});

function addMessage(msg, keep = true) {
  if (keep) chat.push(msg);
  const div = document.createElement("div");
  if (msg.system) {
    div.className = "system";
    div.textContent = msg.text;
  } else {
    const name = document.createElement("span");
    name.className = "name " + (msg.color || "s");
    name.textContent = msg.name;
    const text = document.createElement("span");
    text.className = "text";
    // textContent (not innerHTML) so nobody can inject code via chat
    text.textContent = msg.text;
    div.append(name, text);
  }
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

// Connection dropped and came back (phone asleep, server woke
// up): join again, sending our backup in case it's needed.
let firstConnect = true;
socket.on("connect", () => {
  if (!firstConnect && !botMode) {
    if (!$("game").hidden) joinRoom();
    else socket.emit("watchLobbies");
  }
  firstConnect = false;
});

// ============================================================
//  PLAYING THE COMPUTER
//  The whole game lives in this browser (saved in localStorage
//  as "chessBot"), so refreshing the page carries on the game.
// ============================================================
let bot = null;          // { rating, color, moves, result }
let computer = null;     // the Stockfish engine (computer.js)
let thinking = false;
let botVersion = 0;      // goes up on takeback / new game, so an old answer is ignored

function startBotGame() {
  bot = load("chessBot");
  if (!bot || !Array.isArray(bot.moves)) {
    location.replace(location.pathname); // nothing saved: back to the menu
    return;
  }
  $("lobby").hidden = true;
  $("game").hidden = false;
  coach = coachById(bot.coach) || null;
  $("rematch-btn").textContent = "Play Again";
  computer = new Computer();
  computer.newGame();
  if (coach) {
    // Lessons use the chat box to talk to your coach.
    bot.chat ||= [];
    bot.marks ||= [];
    $("chat-input").placeholder = `Ask ${coach.name} a question…`;
    document.querySelector(".panel").classList.add("coach-mode");
    redrawCoachChat();
    if (bot.chat.length === 0) coachSay("greet");
  } else {
    document.querySelector(".chat").hidden = true; // nobody to chat with
  }
  botUpdate();
}

// Number of moves YOU have made in this game.
function myMoveCount() {
  if (!bot) return 0;
  return bot.color === "w" ? Math.ceil(bot.moves.length / 2) : Math.floor(bot.moves.length / 2);
}

// Build the same kind of "state" the server sends, and show it.
function botUpdate() {
  save("chessBot", bot);
  const g = new Chess();
  let last = null;
  for (const m of bot.moves) {
    const r = g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    last = { from: r.from, to: r.to };
  }
  const me = bot.color;
  const cpu = me === "w" ? "b" : "w";
  const winnerTitle = (c) => (c === me ? "You won!" : "Computer won");
  let st = { over: false };
  if (bot.result?.type === "resign") st = { over: true, type: "resign", title: "Computer won", reason: "by resignation" };
  else if (g.isCheckmate()) st = { over: true, title: winnerTitle(g.turn() === "w" ? "b" : "w"), reason: "by checkmate" };
  else if (g.isStalemate()) st = { over: true, title: "Draw", reason: "by stalemate" };
  else if (g.isThreefoldRepetition()) st = { over: true, title: "Draw", reason: "by repetition" };
  else if (g.isInsufficientMaterial()) st = { over: true, title: "Draw", reason: "by insufficient material" };
  else if (g.isDraw()) st = { over: true, title: "Draw", reason: "by 50-move rule" };
  if (coach && st.title === "Computer won") st.title = `${coach.name} won`;
  // Positions change, so an old hint no longer applies.
  if (hintMove && hintMove.ply !== bot.moves.length) hintMove = null;
  // Coach says something when the game ends.
  if (coach && st.over && !bot.endSaid) {
    bot.endSaid = true;
    coachSay("end", { result: `${st.title} ${st.reason}` });
  }

  const level = levelFor(bot.rating);
  applyState({
    meta: coach
      ? { name: `Lesson with ${coach.name}`, bot: true, coach: true }
      : { name: `Computer · ${level.rating} ${level.label}`, bot: true },
    moves: bot.moves.slice(),
    lastMove: last,
    status: st,
    drawOffer: null,
    players: {
      [me]: { name: load("chessName") || "You", online: true },
      [cpu]: coach
        ? { name: `${coach.name} (${coach.rating})`, online: true, bot: true, emoji: coach.emoji }
        : { name: `Computer (${level.rating})`, online: true, bot: true },
    },
    spectators: 0,
    you: me,
  });
  computerTurn();
}

function botPlayerMoved(m) {
  bot.moves.push(m.from + m.to + (m.promotion || ""));
  botUpdate();
}

// If it's the computer's turn, ask Stockfish for a move.
async function computerTurn() {
  if (thinking || status.over || game.turn() === bot.color) return;
  thinking = true;
  const version = botVersion;
  if (coach) await reviewLastMove(version); // the coach judges your move first
  const started = Date.now();
  const move = await computer.chooseMove(game, bot.rating);
  // Wait at least ~0.6 s so the reply doesn't feel instant.
  const wait = 600 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  thinking = false;
  if (version !== botVersion) {
    // You took back a move or restarted while it was thinking.
    computerTurn();
    return;
  }
  if (move) {
    bot.moves.push(move.from + move.to + (move.promotion || ""));
    botUpdate();
    // Analyse the new position in the background, ready to judge your
    // next move (and for hints).
    if (coach && !status.over) analyzeFen(game);
  }
}

function botResign() {
  bot.result = { type: "resign" };
  botUpdate();
}

function botNewGame() {
  botVersion++;
  computer.stop();
  computer.newGame();
  bot.moves = [];
  bot.result = null;
  if (coach) {
    bot.marks = [];
    bot.endSaid = false;
    bot.quiet = 0;
    addCoachLine("Let's play again! Take your time and think about each move. 😊");
  }
  botUpdate();
}

// Take back your last move (and the computer's reply).
function botTakeback() {
  if (myMoveCount() === 0) return;
  botVersion++;
  computer.stop();
  const before = myMoveCount();
  // Remove moves until one of yours is gone and it's your turn.
  while (bot.moves.length && (myMoveCount() === before || turnAfter(bot.moves) !== bot.color)) {
    bot.moves.pop();
  }
  bot.result = null;
  if (coach) {
    bot.marks.length = bot.moves.length;
    bot.endSaid = false;
    addCoachLine("No problem, let's try that again. What else could you play here?");
  }
  botUpdate();
}
const turnAfter = (list) => (list.length % 2 === 0 ? "w" : "b");


// ============================================================
//  THE COACH
//  Stockfish (at full strength) checks each of your moves. The
//  coach then talks about it: the server asks the AI to explain
//  it in a friendly way. If the AI isn't available, the coach
//  uses built-in tips instead.
// ============================================================
let coach = null;        // the chosen coach from coaches.json
let hintMove = null;     // { from, to, reveal, ply } while a hint is showing
const analysisCache = new Map(); // fen -> { best, cp }
const MARKS = { best: "★", inaccuracy: "?!", mistake: "?", blunder: "??" };

function replayMoves(list) {
  const g = new Chess();
  for (const m of list) g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return g;
}

async function analyzeFen(g) {
  const fen = g.fen();
  if (!analysisCache.has(fen)) analysisCache.set(fen, computer.analyze(g));
  return analysisCache.get(fen);
}

// How good was the move? Compare the engine's score before and after.
function classify(before, after, playedUci) {
  const clamp = (v) => Math.max(-1500, Math.min(1500, v));
  const sign = bot.color === "w" ? 1 : -1;
  const loss = sign * (clamp(before.cp) - clamp(after.cp)); // how much worse it got for you
  if (playedUci === before.best || loss <= 15) return "best";
  if (loss <= 60) return "good";
  if (loss <= 130) return "inaccuracy";
  if (loss <= 280) return "mistake";
  return "blunder";
}

async function reviewLastMove(version) {
  const ply = bot.moves.length - 1;
  if (ply < 0 || bot.marks[ply]) return;
  if (turnAfter(bot.moves.slice(0, ply)) !== bot.color) return; // last move wasn't yours
  const before = await analyzeFen(replayMoves(bot.moves.slice(0, ply)));
  const after = await analyzeFen(replayMoves(bot.moves));
  if (version !== botVersion || !before || !after) return;
  const cls = classify(before, after, bot.moves[ply]);
  bot.marks[ply] = cls;
  save("chessBot", bot);
  drawMoves();

  // Don't comment on every move: always on mistakes, sometimes otherwise.
  bot.quiet = (bot.quiet || 0) + 1;
  const firstMove = myMoveCount() === 1;
  const talk =
    cls === "blunder" || cls === "mistake" || firstMove ||
    (cls === "inaccuracy" && Math.random() < 0.6) ||
    (cls === "best" && Math.random() < 0.35) ||
    bot.quiet >= 4;
  if (talk) {
    bot.quiet = 0;
    coachSay("move", { ply, cls, bestUci: before.best, evalBefore: before.cp, evalAfter: after.cp }, version);
  }
}

// ---------- Hint button ----------
$("hint-btn").addEventListener("click", async () => {
  if (!coach || status.over || game.turn() !== bot.color) return;
  const a = await analyzeFen(game);
  if (!a?.best) return;
  const reveal = !!hintMove; // second press shows the answer
  hintMove = { from: a.best.slice(0, 2), to: a.best.slice(2, 4), reveal, ply: bot.moves.length };
  render();
  coachSay("hint", { bestUci: a.best, reveal });
});

// ---------- Talking ----------
function askCoach(question) {
  bot.chat.push({ from: "player", text: question.slice(0, 300) });
  save("chessBot", bot);
  redrawCoachChat();
  coachSay("question", { question });
}

function addCoachLine(text) {
  bot.chat.push({ from: "coach", text });
  if (bot.chat.length > 60) bot.chat.splice(0, bot.chat.length - 60);
  save("chessBot", bot);
  redrawCoachChat();
}

function redrawCoachChat(typing = false) {
  $("messages").innerHTML = "";
  for (const m of bot.chat) {
    addMessage(
      m.from === "coach"
        ? { name: coach.emoji + " " + coach.name, color: "coach", text: m.text }
        : { name: load("chessName") || "You", color: bot.color, text: m.text },
      false
    );
  }
  if (typing) {
    const div = document.createElement("div");
    div.className = "typing";
    div.textContent = `${coach.name} is typing…`;
    $("messages").appendChild(div);
    $("messages").scrollTop = $("messages").scrollHeight;
  }
}

let typingCount = 0;
async function coachSay(kind, extra = {}, version = botVersion) {
  typingCount++;
  redrawCoachChat(true);
  let text = null;
  try {
    const res = await fetch("api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coachId: coach.id,
        kind,
        playerName: load("chessName") || "",
        playerColor: bot.color,
        moves: bot.moves,
        history: bot.chat.slice(-8),
        ...extra,
      }),
    });
    const data = await res.json();
    if (data.text) text = data.text;
  } catch {}
  typingCount--;
  // A comment about a move you've since taken back is out of date.
  if (kind === "move" && version !== botVersion) {
    redrawCoachChat(typingCount > 0);
    return;
  }
  addCoachLine(text || builtInTip(kind, extra));
  if (typingCount > 0) redrawCoachChat(true);
}

// ---------- Built-in tips (used when the AI isn't available) ----------
function moveWords(beforeMoves, uci) {
  if (!uci) return "";
  try {
    const m = replayMoves(beforeMoves).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
    return `${m.san} (your ${names[m.piece]} to ${m.to})`;
  } catch {
    return uci;
  }
}

const PRINCIPLES = [
  "Before every move, check: is my piece safe where it's going?",
  "In the opening, control the centre with pawns and bring out your knights and bishops.",
  "Castle early to keep your king safe.",
  "Look for checks, captures and threats — for you AND your opponent.",
  "Every piece should have a job. Find your least active piece and improve it.",
  "When you're ahead in material, trading pieces makes it easier to win.",
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function builtInTip(kind, extra) {
  switch (kind) {
    case "greet":
      return coach.greeting;
    case "move": {
      const best = moveWords(bot.moves.slice(0, extra.ply), extra.bestUci);
      if (extra.cls === "blunder") return `Oops — that move lets me win something big. A stronger idea was ${best}. Press ↶ Undo and have another look!`;
      if (extra.cls === "mistake") return `Hmm, that wasn't the best. ${best} was stronger. Always check what your opponent can do next!`;
      if (extra.cls === "inaccuracy") return `Not bad, but ${best} was a little better.`;
      if (extra.cls === "best") return pick(["Excellent move! That's exactly what I'd play. ⭐", "Great find — that's the best move here!", "Perfect! You're playing really well."]);
      return pick(["Nice, solid move. Keep it up!", "Good move! " + pick(PRINCIPLES)]);
    }
    case "hint": {
      const g = new Chess(game.fen());
      const p = g.get(extra.bestUci.slice(0, 2));
      const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
      return extra.reveal
        ? `The best move here is ${moveWords(bot.moves, extra.bestUci)}. Can you see why it's good?`
        : `Take a look at your ${names[p?.type] || "piece"} on ${extra.bestUci.slice(0, 2)} — I've highlighted it in blue. Can it do something useful? (Press 💡 again to see the answer.)`;
    }
    case "question":
      return `I can only give quick tips right now, but here's a good one: ${pick(PRINCIPLES)}`;
    case "end":
      return /^You won/.test(extra.result)
        ? "Well played — you won! 🎉 Press Play Again for another game, or try a stronger coach."
        : /^Draw/.test(extra.result)
          ? "A draw — a good fighting game! Press Play Again to try for the win."
          : "Good game! Every loss teaches you something. Use ↶ Undo to look at where things went wrong, or play again!";
  }
  return pick(PRINCIPLES);
}


// ============================================================
//  CHESS CLOCKS
//  The server keeps the official time and sends it with every
//  update. In between, we count down smoothly here (10 times a
//  second) so the clock looks alive.
// ============================================================
const CATEGORY_ICONS = { bullet: "🚀", blitz: "⚡", rapid: "⏱️" };
let lowTimeWarned = false;

// Time left for a colour right now, in milliseconds.
function shownTime(color) {
  if (!clockData || !color) return 0;
  let t = clockData[color];
  if (clockData.running === color && !status.over) t -= performance.now() - clockReceivedAt;
  return Math.max(0, t);
}

// 3:05 — or 0:09.4 (with tenths) under 20 seconds, like chess sites.
function formatTime(ms) {
  const total = Math.max(0, ms);
  if (total < 20000) {
    const tenths = Math.floor(total / 100);
    return `0:${String(Math.floor(tenths / 10)).padStart(2, "0")}.${tenths % 10}`;
  }
  const secs = Math.ceil(total / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = String(secs % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function updateClocks() {
  if (!clockData) return;
  for (const el of document.querySelectorAll(".clock")) {
    const t = shownTime(el.dataset.color);
    el.textContent = formatTime(t);
    // Red when time is short (10 s in bullet, 20 s otherwise).
    el.classList.toggle("low", t < (clockData.initial <= 120000 ? 10000 : 20000));
  }
  // One warning beep when YOUR time drops under 10 seconds.
  if (myColor && clockData.running === myColor && !status.over) {
    const mine = shownTime(myColor);
    if (mine < 10000 && !lowTimeWarned) {
      lowTimeWarned = true;
      beep(880, 0, 0.15, 0.2, "square");
    }
  }
}
setInterval(updateClocks, 100);

// ---------- The time-control picker on the main menu ----------
// The same choices the big chess sites offer.
const TIME_CONTROLS = [
  { cat: "bullet", label: "🚀 Bullet", options: [[1, 0], [1, 1], [2, 1]] },
  { cat: "blitz",  label: "⚡ Blitz",  options: [[3, 0], [3, 2], [5, 0]] },
  { cat: "rapid",  label: "⏱️ Rapid",  options: [[10, 0], [15, 10], [30, 0]] },
];
const tcLabel = (m, i) => (i ? `${m} | ${i}` : `${m} min`);

function buildTimePicker() {
  const box = $("time-pick");
  for (const group of TIME_CONTROLS) {
    const row = document.createElement("div");
    row.className = "time-row";
    const cat = document.createElement("span");
    cat.className = "t-cat";
    cat.textContent = group.label;
    row.appendChild(cat);
    for (const [m, i] of group.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.value = `${m}+${i}`;
      b.textContent = tcLabel(m, i);
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  const extra = document.createElement("div");
  extra.className = "time-row extra";
  for (const [value, text] of [["none", "♾️ No clock"], ["custom", "⚙️ Custom"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.value = value;
    b.textContent = text;
    extra.appendChild(b);
  }
  box.appendChild(extra);

  const saved = load("chessTime") || "10+0";
  (box.querySelector(`[data-value="${saved}"]`) || box.querySelector('[data-value="10+0"]')).classList.add("on");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    save("chessTime", b.dataset.value);
    timePickerChanged();
  });
  timePickerChanged();
}

// { minutes, increment } for the chosen option, or null for no clock.
function chosenClock() {
  const v = $("time-pick").querySelector(".on")?.dataset.value || "none";
  if (v === "none") return null;
  if (v === "custom") {
    const minutes = Math.min(180, Math.max(1, Math.round(Number($("custom-min").value) || 10)));
    const increment = Math.min(180, Math.max(0, Math.round(Number($("custom-inc").value) || 0)));
    return { minutes, increment };
  }
  const [minutes, increment] = v.split("+").map(Number);
  return { minutes, increment };
}

function timePickerChanged() {
  const v = $("time-pick").querySelector(".on")?.dataset.value;
  $("custom-time").hidden = v !== "custom";
  // Rated games need an account and a clock.
  $("rated-wrap").hidden = !me;
  const clock = chosenClock();
  const ratedBtn = $("rated-pick").querySelector('[data-value="rated"]');
  ratedBtn.disabled = !clock;
  if (!clock) {
    $("rated-pick").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === "casual"));
  }
  $("rated-hint").textContent = !clock
    ? "Games without a clock are always casual."
    : toggleValue("rated-pick") === "rated"
      ? "Your rating goes up or down after the game. Only signed-in players can join."
      : "Just for fun — ratings don't change, and guests can join.";
}
$("custom-min").addEventListener("input", timePickerChanged);
$("custom-inc").addEventListener("input", timePickerChanged);
setupToggle("rated-pick", timePickerChanged);
buildTimePicker();

// After a rated game: "+8" in the game-over box.
function showRatingChange() {
  const el = $("gameover-rating");
  const change = ratingChange && myColor ? ratingChange[myColor] : null;
  if (change == null) {
    el.hidden = true;
    return;
  }
  const rating = players[myColor]?.rating;
  el.hidden = false;
  el.textContent = `Your rating: ${rating ?? ""} (${change >= 0 ? "+" : ""}${change})`;
  el.style.color = change >= 0 ? "#96bc4b" : "#e05b5b";
}

// ============================================================
//  ACCOUNTS: sign up, log in, profiles, leaderboard
// ============================================================
function drawAccountBar() {
  const bar = $("account-bar");
  bar.innerHTML = "";
  if (!accountsOn) {
    bar.innerHTML = '<span class="account-off">Accounts aren\'t switched on yet — everyone plays as a guest.</span>';
    return;
  }
  if (me) {
    const name = document.createElement("button");
    name.className = "account-name";
    const best = Math.max(...Object.values(me.ratings || {}).map((r) => r.rating));
    name.textContent = `👤 ${me.username}${isFinite(best) ? ` · ${best}` : ""}`;
    name.title = "Your profile";
    name.addEventListener("click", () => openProfile(me.username));
    const out = document.createElement("button");
    out.className = "btn btn-secondary";
    out.textContent = "Log Out";
    out.addEventListener("click", logOut);
    bar.append(name, out);
  } else {
    const login = document.createElement("button");
    login.className = "btn btn-secondary";
    login.textContent = "Log In";
    login.addEventListener("click", () => openAuth("login"));
    const signup = document.createElement("button");
    signup.className = "btn btn-primary";
    signup.textContent = "Sign Up";
    signup.addEventListener("click", () => openAuth("signup"));
    bar.append(login, signup);
  }
}

function setupNameCard() {
  if (me) {
    // Signed in: your username is your name.
    $("name-input").value = me.username;
    $("name-input").disabled = true;
    $("name-card").querySelector(".label").textContent = "Playing as";
  } else if (accountsOn) {
    $("guest-hint").hidden = false;
  }
}
$("guest-signup").addEventListener("click", (e) => {
  e.preventDefault();
  openAuth("signup");
});

// ---------- the pop-up ----------
function openModal(which) {
  $("modal").hidden = false;
  $("auth-form").hidden = which !== "auth";
  $("profile").hidden = which !== "profile";
}
function closeModal() {
  $("modal").hidden = true;
}
$("modal-close").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("modal").hidden) closeModal();
});

let authMode = "signup";
function setAuthMode(mode) {
  authMode = mode;
  $("auth-tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === mode));
  $("signup-extra").hidden = mode !== "signup";
  $("auth-submit").textContent = mode === "signup" ? "Create Account" : "Log In";
  $("auth-pass").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("auth-error").hidden = true;
}
function openAuth(mode) {
  openModal("auth");
  setAuthMode(mode);
  $("auth-user").focus();
}
setupToggle("auth-tabs", setAuthMode);
setupToggle("auth-level");

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const showError = (msg) => {
    $("auth-error").textContent = msg;
    $("auth-error").hidden = false;
  };
  const username = $("auth-user").value.trim();
  const password = $("auth-pass").value;
  if (authMode === "signup" && password !== $("auth-pass2").value) return showError("The two passwords don't match.");
  $("auth-submit").disabled = true;
  try {
    const res = await fetch(authMode === "signup" ? "api/signup" : "api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, level: Number(toggleValue("auth-level")) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || "Something went wrong — please try again.");
    location.reload(); // reconnect as the signed-in player
  } catch {
    showError("Couldn't reach the server — check your connection.");
  } finally {
    $("auth-submit").disabled = false;
  }
});

async function logOut() {
  await fetch("api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  location.reload();
}

// ---------- profiles ----------
const CAT_NAMES = { bullet: "🚀 Bullet", blitz: "⚡ Blitz", rapid: "⏱️ Rapid" };
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

async function openProfile(username) {
  openModal("profile");
  const box = $("profile");
  box.textContent = "Loading…";
  const data = await fetch("api/profile/" + encodeURIComponent(username)).then((r) => r.json()).catch(() => null);
  if (!data || data.error) {
    box.textContent = data?.error || "Couldn't load this profile.";
    return;
  }
  box.innerHTML = "";
  const head = el("div", "profile-head");
  head.append(el("div", "avatar w", data.username[0].toUpperCase()));
  const title = el("div");
  title.append(el("h2", null, data.username), el("div", "hint", `Joined ${new Date(data.joined).toLocaleDateString()}`));
  head.append(title);
  box.append(head);

  const grid = el("div", "profile-ratings");
  for (const cat of ["bullet", "blitz", "rapid"]) {
    const r = data.ratings[cat];
    const b = el("div", "rating-box");
    b.append(el("div", "r-cat", CAT_NAMES[cat]), el("div", "r-num", r.rating), el("div", "r-wld", `${r.wins}W · ${r.losses}L · ${r.draws}D`));
    grid.append(b);
  }
  box.append(grid);

  box.append(el("span", "label", "Recent games"));
  const list = el("div", "history");
  if (data.games.length === 0) list.append(el("p", "hint", "No games yet. Play one to see it here!"));
  for (const g of data.games) {
    const row = el("div", "history-row");
    row.append(el("span", `res ${g.outcome}`, { win: "W", loss: "L", draw: "½" }[g.outcome]));
    row.append(el("span", null, `vs ${g.opponent}${g.opponentRating ? ` (${g.opponentRating})` : ""} · ${g.reason}`));
    row.append(el("span", "tc", `${CATEGORY_ICONS[g.category] || "🙂"} ${g.timeControl}${g.rated ? "" : " · casual"}`));
    const chg = g.change == null ? "" : `${g.change >= 0 ? "+" : ""}${g.change}`;
    row.append(el("span", `chg ${g.change > 0 ? "up" : g.change < 0 ? "down" : ""}`, chg));
    list.append(row);
  }
  box.append(list);
}

// ---------- leaderboard ----------
async function loadLeaderboard(category) {
  const data = await fetch("api/leaderboard?category=" + category).then((r) => r.json()).catch(() => null);
  const list = $("leaderboard");
  list.innerHTML = "";
  if (!data?.players?.length) {
    list.append(el("li", "lb-empty", "No rated games yet — be the first!"));
    return;
  }
  for (const p of data.players) {
    const li = el("li");
    const name = el("span", "lb-name", p.username);
    name.addEventListener("click", () => openProfile(p.username));
    li.append(name, el("span", null, p.rating));
    list.append(li);
  }
}
if (accountsOn) {
  $("leaderboard-card").hidden = false;
  setupToggle("board-pick", loadLeaderboard);
  loadLeaderboard("blitz");
}
drawAccountBar();
setupNameCard();

// Click a player's name in a game to see their profile.
for (const id of ["top-bar", "bottom-bar"]) {
  $(id).addEventListener("click", (e) => {
    const p = players[$(id).dataset.color];
    if (accountsOn && p?.registered && e.target.closest(".player-name")) openProfile(p.name);
  });
}

// ============================================================
//  START-UP (at the very end, so everything above is ready)
//  Computer game, online game, or the main menu?
// ============================================================
if (botMode) startBotGame();
else if (roomId && load("chessName")) enterGame();
else showMenu();
