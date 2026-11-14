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
    meta: roomMeta ? { name: roomMeta.name, isPrivate: roomMeta.isPrivate } : null,
  });
}

// ============================================================
//  MAIN MENU (LOBBY)
// ============================================================
const params = new URLSearchParams(location.search);
roomId = params.get("room");
const wantsToWatch = params.get("watch") === "1";
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
  if (getName()) goToRoom(load("chessLastRoom"));
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
    span.append(p.name + (p.online ? "" : " (offline)"));
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
    meta.append(badge, `${detail} · 👁 ${g.spectators} watching`);
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

// Start-up: show the game if we know who you are, otherwise the menu.
if (roomId && load("chessName")) enterGame();
else showMenu();

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
  socket.emit("move", { from, to, promotion });
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
  el.classList.toggle("active", !status.over && game.turn() === color && !!players.w && !!players.b);
  const p = players[color];

  const avatar = document.createElement("div");
  avatar.className = "avatar " + color;
  avatar.textContent = p ? p.name[0].toUpperCase() : "?";
  const dot = document.createElement("span");
  dot.className = "dot" + (p?.online ? " on" : "");
  dot.title = p?.online ? "Online" : "Offline";
  avatar.appendChild(dot);

  const info = document.createElement("div");
  info.className = "player-info";
  const name = document.createElement("div");
  name.className = "player-name";
  name.textContent = p ? p.name : "Waiting for opponent…";
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

  const turn = document.createElement("div");
  turn.className = "turn-box";
  turn.textContent = color === "w" ? "White" : "Black";

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
    $("room-kind").textContent = roomMeta.isPrivate ? "🔒 Private" : "🌍 Public";
    $("code-box").hidden = !roomMeta.isPrivate;
    $("room-code").textContent = roomMeta.code || "";
  }
  $("watchers").textContent = spectators;

  let text = "";
  if (status.over) text = `${status.title} ${status.reason}`;
  else if (waiting) text = "Waiting for your opponent — send them the invite link!";
  else if (!myColor) text = "You are watching this game.";
  else if (game.turn() === myColor) text = game.inCheck() ? "Your move — you're in check!" : "Your move";
  else text = `Waiting for ${players[opp].name} to move…`;
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
}

function render() {
  drawBoard();
  const bottom = isWhiteBottom() ? "w" : "b";
  drawPlayerBar($("bottom-bar"), bottom);
  drawPlayerBar($("top-bar"), bottom === "w" ? "b" : "w");
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
  setTimeout(() => ($("copy-btn").textContent = "Copy"), 1500);
});
$("flip-btn").addEventListener("click", () => { flipped = !flipped; render(); });
$("resign-btn").addEventListener("click", () => {
  if (confirm("Are you sure you want to resign?")) socket.emit("resign");
});
$("draw-btn").addEventListener("click", () => socket.emit("offerDraw"));
$("accept-draw").addEventListener("click", () => socket.emit("answerDraw", true));
$("decline-draw").addEventListener("click", () => socket.emit("answerDraw", false));
$("new-game-btn").addEventListener("click", () => {
  if (status.over || moves.length === 0 || confirm("Start a new game? This game will be lost.")) {
    socket.emit("newGame");
  }
});
$("rematch-btn").addEventListener("click", () => { $("gameover").hidden = true; socket.emit("newGame"); });
$("gameover-close").addEventListener("click", () => ($("gameover").hidden = true));

// ============================================================
//  MESSAGES FROM THE SERVER
// ============================================================
socket.on("state", (s) => {
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
  if (!firstState && !hadOpponent && players.w && players.b) sounds.notify();

  firstState = false;
  render();
  saveBackup();
});

socket.on("errorMessage", (msg) => addMessage({ system: true, text: msg }, false));

// ============================================================
//  CHAT
// ============================================================
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault(); // stop the page reloading
  const text = $("chat-input").value.trim();
  if (!text) return;
  socket.emit("chat", text);
  $("chat-input").value = "";
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
  if (!firstConnect) {
    if (!$("game").hidden) joinRoom();
    else socket.emit("watchLobbies");
  }
  firstConnect = false;
});
