// ============================================================
//  CHESS GAME — BROWSER CODE
//  This runs inside each player's web browser. It:
//    - draws the board
//    - lets you click pieces to move them
//    - sends moves & chat to the server
//    - redraws when the server says something changed
// ============================================================

import { Chess } from "/lib/chess.js";

const socket = io(); // connect to the server

// Unicode chess symbols. We use the solid shapes for both sides
// and colour them with CSS. "︎" stops phones showing emoji.
const SYMBOLS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

// ---------- Game state (in this browser) ----------
let myColor = null;        // "w", "b" or null (spectator)
let game = new Chess();    // local copy, used to show legal moves
let lastMove = null;
let selected = null;       // square the player clicked, e.g. "e2"
let pendingPromotion = null;
let gameOver = false;

// ---------- Grab the bits of the page we need ----------
const $ = (id) => document.getElementById(id);
const boardEl = $("board");

// ---------- Which room are we in? ----------
// The room id lives in the web address: /?room=abc123
const params = new URLSearchParams(location.search);
let roomId = params.get("room");
if (roomId) {
  $("lobby-text").textContent = "You've been invited to a game! Enter your name to join.";
  $("start-btn").textContent = "Join game";
}

// localStorage = a small notebook the browser keeps for this
// website, even after a refresh. (try/catch: some private-browsing
// modes don't allow it.)
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// A random id that identifies THIS browser, so the server can
// give you your seat back when you refresh.
let playerId = load("chessPlayerId");
if (!playerId) {
  playerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  save("chessPlayerId", playerId);
}

// Remember the player's name for next time.
$("name-input").value = load("chessName") || "";

function joinRoom() {
  socket.emit("join", { room: roomId, name: load("chessName") || "Player", playerId });
}

function startGame() {
  const name = $("name-input").value.trim() || "Player";
  save("chessName", name);

  if (!roomId) {
    // Make a random 6-letter room id and put it in the address bar.
    roomId = Math.random().toString(36).slice(2, 8);
    history.replaceState(null, "", `?room=${roomId}`);
  }

  $("invite-link").value = location.href;
  $("lobby").hidden = true;
  $("game").hidden = false;
  joinRoom();
}

// Refreshed the page, or came back to the link? If we already
// know your name, skip the name screen and go straight in.
if (roomId && load("chessName")) startGame();

$("start-btn").addEventListener("click", startGame);
$("name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startGame();
});

$("copy-btn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("invite-link").value);
    $("copy-btn").textContent = "Copied!";
  } catch {
    $("invite-link").select(); // fallback: select so they can Ctrl+C
  }
  setTimeout(() => ($("copy-btn").textContent = "Copy"), 1500);
});

$("new-game-btn").addEventListener("click", () => {
  if (confirm("Start a new game? The current game will be lost.")) {
    socket.emit("newGame");
  }
});

// ============================================================
//  DRAWING THE BOARD
// ============================================================
function drawBoard() {
  boardEl.innerHTML = "";
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = [8, 7, 6, 5, 4, 3, 2, 1];

  // Black sees the board from the other side.
  const flip = myColor === "b";
  const rowOrder = flip ? [...ranks].reverse() : ranks;
  const colOrder = flip ? [...files].reverse() : files;

  // Squares the selected piece can legally move to.
  const targets = selected
    ? game.moves({ square: selected, verbose: true }).map((m) => m.to)
    : [];

  // Find the king that is in check (if any).
  let checkSquare = null;
  if (game.inCheck()) {
    for (const row of game.board()) {
      for (const p of row) {
        if (p && p.type === "k" && p.color === game.turn()) checkSquare = p.square;
      }
    }
  }

  rowOrder.forEach((rank, r) => {
    colOrder.forEach((file, c) => {
      const square = file + rank;
      const el = document.createElement("div");
      const isLight = (files.indexOf(file) + rank) % 2 === 1;
      el.className = "square " + (isLight ? "light" : "dark");
      if (lastMove && (square === lastMove.from || square === lastMove.to)) el.classList.add("last-move");
      if (square === selected) el.classList.add("selected");
      if (targets.includes(square)) el.classList.add("target");
      if (square === checkSquare) el.classList.add("in-check");

      const piece = game.get(square);
      if (piece) {
        const span = document.createElement("span");
        span.className = "piece " + piece.color;
        span.textContent = SYMBOLS[piece.type] + "︎";
        el.appendChild(span);
      }

      // Letters along the bottom, numbers along the left side.
      if (r === 7) addCoord(el, "file", file);
      if (c === 0) addCoord(el, "rank", rank);

      el.addEventListener("click", () => onSquareClick(square));
      boardEl.appendChild(el);
    });
  });
}

function addCoord(el, type, text) {
  const s = document.createElement("span");
  s.className = "coord " + type;
  s.textContent = text;
  el.appendChild(s);
}

// ============================================================
//  CLICKING TO MOVE
//  1st click: pick up your piece.  2nd click: put it down.
// ============================================================
function onSquareClick(square) {
  if (!myColor || gameOver || game.turn() !== myColor) return;
  if (pendingPromotion) return;

  const piece = game.get(square);

  // Clicked one of my own pieces → select it.
  if (piece && piece.color === myColor) {
    selected = selected === square ? null : square;
    drawBoard();
    return;
  }

  // Clicked somewhere else while holding a piece → try to move.
  if (selected) {
    const legal = game.moves({ square: selected, verbose: true }).find((m) => m.to === square);
    if (legal) {
      if (legal.promotion) {
        // Pawn reached the end: ask which piece they want.
        pendingPromotion = { from: selected, to: square };
        $("promotion").hidden = false;
        return;
      }
      sendMove(selected, square);
    }
    selected = null;
    drawBoard();
  }
}

function sendMove(from, to, promotion) {
  // Move it locally right away so it feels fast; the server
  // will confirm by sending back the official board.
  game.move({ from, to, promotion: promotion || "q" });
  lastMove = { from, to };
  selected = null;
  drawBoard();
  socket.emit("move", { from, to, promotion });
}

document.querySelectorAll("#promotion button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const { from, to } = pendingPromotion;
    pendingPromotion = null;
    $("promotion").hidden = true;
    sendMove(from, to, btn.dataset.piece);
  });
});

// ============================================================
//  MESSAGES FROM THE SERVER
// ============================================================
socket.on("joined", (data) => {
  myColor = data.color;
  // Show the chat so far (clear first so nothing appears twice).
  $("messages").innerHTML = "";
  data.chatLog.forEach(addMessage);
});

// The server sends the whole game every time something changes.
socket.on("state", (state) => {
  game = new Chess(state.fen);
  lastMove = state.lastMove;
  gameOver = state.status.over;
  selected = null;
  drawBoard();

  // Status line
  const me = myColor || "w";
  const them = me === "w" ? "b" : "w";

  let text = state.status.text;
  if (!state.players.w || !state.players.b) {
    text = "Waiting for your opponent to join… send them the invite link!";
  } else if (!gameOver && myColor === game.turn()) {
    text = "Your move! " + (game.inCheck() ? "You are in CHECK!" : "");
  }
  if (myColor && state.players[them] && !state.players[them].online && !gameOver) {
    text += ` (${state.players[them].name} is offline — they can come back with the same link.)`;
  }
  $("status").textContent = text;

  // Player names above/below the board
  const name = (c) => {
    const p = state.players[c];
    if (!p) return "(waiting…)";
    return p.name + (p.online ? "" : " (offline)");
  };
  const icon = (c) => (c === "w" ? "⚪" : "⚫");
  $("me-label").textContent = `${icon(me)} ${name(me)}${myColor ? " (you)" : ""}`;
  $("opponent-label").textContent = `${icon(them)} ${name(them)}`;
  $("new-game-btn").hidden = !myColor;

  // Move list, two moves (white + black) per line
  const list = $("history");
  list.innerHTML = "";
  for (let i = 0; i < state.history.length; i += 2) {
    const li = document.createElement("li");
    li.textContent = state.history[i] + "  " + (state.history[i + 1] || "");
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
});

socket.on("errorMessage", (msg) => addMessage({ system: true, text: msg }));

// ============================================================
//  CHAT
// ============================================================
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault(); // stop the page from reloading
  const text = $("chat-input").value.trim();
  if (!text) return;
  socket.emit("chat", text);
  $("chat-input").value = "";
});

socket.on("chat", addMessage);

function addMessage(msg) {
  const div = document.createElement("div");
  if (msg.system) {
    div.className = "system";
    div.textContent = msg.text;
  } else {
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = msg.name + ":";
    name.style.color = msg.color === "w" ? "#fff" : msg.color === "b" ? "#8fc1ff" : "#aaa";
    div.appendChild(name);
    // textContent (not innerHTML) so nobody can inject code via chat
    div.appendChild(document.createTextNode(msg.text));
  }
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

// If the connection drops and comes back (e.g. your phone was
// asleep), rejoin the room automatically.
let firstConnect = true;
socket.on("connect", () => {
  if (!firstConnect && !$("game").hidden) joinRoom();
  firstConnect = false;
});
