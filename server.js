// ============================================================
//  CHESS GAME SERVER
//  This file runs on a computer (your laptop, or Render). Both
//  players' browsers connect to it. It:
//    1. Sends the web page files to the browsers
//    2. Keeps the "real" copy of each game
//    3. Checks every move is legal (so nobody can cheat)
//    4. Passes moves, chat, resign and draw offers between players
// ============================================================

const path = require("path");
const http = require("http");
const express = require("express");          // serves web pages
const { Server } = require("socket.io");     // real-time messages
const { Chess } = require("chess.js");       // chess rules

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Render tells us which port to use via PORT. Locally we use 3000.
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
// Let the browser use chess.js too (to show legal moves).
app.use("/lib", express.static(path.join(__dirname, "node_modules/chess.js/dist/esm")));

// ------------------------------------------------------------
//  GAME ROOMS — one room = one game between two players.
//
//  Every browser has a secret random "playerId" saved in it.
//  Seats are tied to that id, so refreshing gives you your
//  seat back.
// ------------------------------------------------------------
const rooms = new Map();

function newRoom() {
  return {
    chess: new Chess(),
    moves: [],              // e.g. ["e2e4", "e7e5", "e7e8q"]
    players: { w: null, b: null }, // { playerId, name, sockets:Set }
    lastMove: null,
    result: null,           // set when someone resigns / agrees a draw
    drawOffer: null,        // "w" or "b" while a draw is offered
    chatLog: [],
    touched: false,         // has anything happened since the server started?
    lastActive: Date.now(),
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, newRoom());
  return rooms.get(roomId);
}

// Tidy up games nobody has touched for 24 hours (checked hourly).
const ONE_DAY = 24 * 60 * 60 * 1000;
setInterval(() => {
  for (const [id, room] of rooms) {
    const connected = io.sockets.adapter.rooms.get(id)?.size || 0;
    if (connected === 0 && Date.now() - room.lastActive > ONE_DAY) rooms.delete(id);
  }
}, 60 * 60 * 1000);

const NAMES = { w: "White", b: "Black" };
const other = (c) => (c === "w" ? "b" : "w");

// Which colour is this player? ("w", "b" or null = spectator)
function colorOf(room, playerId) {
  if (room.players.w?.playerId === playerId) return "w";
  if (room.players.b?.playerId === playerId) return "b";
  return null;
}

// Is the game over, and why?
function gameStatus(room) {
  const chess = room.chess;
  if (room.result) return { over: true, ...room.result };
  if (chess.isCheckmate()) {
    return { over: true, title: `${NAMES[other(chess.turn())]} won`, reason: "by checkmate" };
  }
  if (chess.isStalemate()) return { over: true, title: "Draw", reason: "by stalemate" };
  if (chess.isThreefoldRepetition()) return { over: true, title: "Draw", reason: "by repetition" };
  if (chess.isInsufficientMaterial()) return { over: true, title: "Draw", reason: "by insufficient material" };
  if (chess.isDraw()) return { over: true, title: "Draw", reason: "by 50-move rule" };
  return { over: false };
}

// Turn a stored result like { type:"resign", loser:"w" } into text.
function resultFromBackup(r) {
  if (!r) return null;
  if (r.type === "resign" && (r.loser === "w" || r.loser === "b")) {
    return { type: "resign", loser: r.loser, title: `${NAMES[other(r.loser)]} won`, reason: "by resignation" };
  }
  if (r.type === "draw") return { type: "draw", title: "Draw", reason: "by agreement" };
  return null;
}

// Send the current game to everyone in the room. Each person
// also gets told which colour THEY are ("you").
function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const seat = (s) => (s ? { name: s.name, online: s.sockets.size > 0 } : null);
  const base = {
    moves: room.moves,
    lastMove: room.lastMove,
    status: gameStatus(room),
    drawOffer: room.drawOffer,
    players: { w: seat(room.players.w), b: seat(room.players.b) },
  };
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit("state", { ...base, you: colorOf(room, s.data.playerId) });
  }
}

function sendChat(roomId, msg) {
  const room = rooms.get(roomId);
  if (room) {
    room.chatLog.push(msg);
    if (room.chatLog.length > 100) room.chatLog.shift();
    room.lastActive = Date.now();
  }
  io.to(roomId).emit("chat", msg);
}
const systemMessage = (roomId, text) => sendChat(roomId, { system: true, text });

// ------------------------------------------------------------
//  RESTORING FROM A BACKUP
//  Render's free plan wipes the server's memory when it sleeps.
//  Each browser keeps a copy of the game, and sends it when it
//  reconnects. We replay the moves (checking each one is legal)
//  to rebuild the game.
// ------------------------------------------------------------
function tryRestore(room, backup) {
  if (!backup || room.touched || !Array.isArray(backup.moves)) return false;
  if (backup.moves.length <= room.moves.length || backup.moves.length > 1000) return false;
  const chess = new Chess();
  let last = null;
  for (const m of backup.moves) {
    if (typeof m !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)) return false;
    try {
      const r = chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
      last = { from: r.from, to: r.to };
    } catch {
      return false; // an illegal move means the backup is broken
    }
  }
  room.chess = chess;
  room.moves = backup.moves.slice();
  room.lastMove = last;
  room.result = resultFromBackup(backup.result);
  if (room.chatLog.length === 0 && Array.isArray(backup.chat)) {
    room.chatLog = backup.chat.slice(-100).map((c) => ({
      system: !!c.system,
      name: String(c.name || "").slice(0, 20),
      color: c.color === "w" || c.color === "b" ? c.color : null,
      text: String(c.text || "").slice(0, 300),
    }));
  }
  return true;
}

// ------------------------------------------------------------
//  Everything below runs whenever a browser connects.
// ------------------------------------------------------------
io.on("connection", (socket) => {
  let roomId = null;
  let playerId = null;
  let myName = "Player";

  const myRoom = () => rooms.get(roomId);
  const myColor = () => (myRoom() ? colorOf(myRoom(), playerId) : null);

  socket.on("join", (data = {}) => {
    roomId = String(data.room || "").slice(0, 40);
    playerId = String(data.playerId || "").slice(0, 64);
    myName = String(data.name || "Player").trim().slice(0, 20) || "Player";
    if (!roomId || !playerId) return;
    socket.data.playerId = playerId;

    const room = getRoom(roomId);
    socket.join(roomId);
    room.lastActive = Date.now();

    const restored = tryRestore(room, data.backup);

    let color = colorOf(room, playerId);
    let returning = !!color;
    if (!color) {
      // New player: take the colour they had before (from the
      // backup) if it's free, otherwise any free seat.
      const wanted = data.backup?.color;
      if ((wanted === "w" || wanted === "b") && !room.players[wanted]) {
        color = wanted;
        returning = wanted && (data.backup.moves || []).length > 0; // back after a restart
      }
      else if (!room.players.w) color = "w";
      else if (!room.players.b) color = "b";
      if (color) room.players[color] = { playerId, name: myName, sockets: new Set() };
    }
    if (color) {
      room.players[color].name = myName;
      room.players[color].sockets.add(socket.id);
    }

    socket.emit("chatLog", room.chatLog);
    if (restored) systemMessage(roomId, "Game restored — carry on where you left off!");
    if (!returning) {
      const role = color ? NAMES[color] : "a spectator";
      systemMessage(roomId, `${myName} joined as ${role}.`);
    }
    broadcastState(roomId);
  });

  socket.on("move", (move = {}) => {
    const room = myRoom();
    const color = myColor();
    if (!room || !color || gameStatus(room).over) return;
    if (room.chess.turn() !== color) return;
    if (!room.players.w || !room.players.b) {
      socket.emit("errorMessage", "Wait for your opponent to join.");
      broadcastState(roomId);
      return;
    }
    try {
      const r = room.chess.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
      room.moves.push(r.from + r.to + (r.promotion || ""));
      room.lastMove = { from: r.from, to: r.to };
      room.drawOffer = null; // making a move turns down a draw offer
      room.touched = true;
      room.lastActive = Date.now();
    } catch {
      socket.emit("errorMessage", "Illegal move.");
    }
    broadcastState(roomId);
  });

  socket.on("resign", () => {
    const room = myRoom();
    const color = myColor();
    if (!room || !color || gameStatus(room).over) return;
    room.result = resultFromBackup({ type: "resign", loser: color });
    room.touched = true;
    systemMessage(roomId, `${myName} resigned.`);
    broadcastState(roomId);
  });

  socket.on("offerDraw", () => {
    const room = myRoom();
    const color = myColor();
    if (!room || !color || gameStatus(room).over || room.drawOffer) return;
    room.drawOffer = color;
    systemMessage(roomId, `${myName} offers a draw.`);
    broadcastState(roomId);
  });

  socket.on("answerDraw", (accept) => {
    const room = myRoom();
    const color = myColor();
    if (!room || !color || room.drawOffer !== other(color)) return;
    room.drawOffer = null;
    if (accept) {
      room.result = resultFromBackup({ type: "draw" });
      room.touched = true;
      systemMessage(roomId, "Draw agreed.");
    } else {
      systemMessage(roomId, `${myName} declined the draw.`);
    }
    broadcastState(roomId);
  });

  // New game / rematch. Players swap colours, like on chess sites.
  socket.on("newGame", () => {
    const room = myRoom();
    if (!room || !myColor()) return;
    room.chess = new Chess();
    room.moves = [];
    room.lastMove = null;
    room.result = null;
    room.drawOffer = null;
    room.touched = true;
    room.players = { w: room.players.b, b: room.players.w };
    systemMessage(roomId, `${myName} started a new game. Colours swapped!`);
    broadcastState(roomId);
  });

  socket.on("chat", (text) => {
    if (!roomId) return;
    text = String(text || "").trim().slice(0, 300);
    if (!text) return;
    sendChat(roomId, { name: myName, color: myColor(), text });
  });

  // Refresh / closed tab / phone asleep: keep the seat, show offline.
  socket.on("disconnect", () => {
    const room = myRoom();
    if (!room) return;
    room.lastActive = Date.now();
    const color = myColor();
    if (color) room.players[color].sockets.delete(socket.id);
    broadcastState(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Chess server running! Open http://localhost:${PORT} in your browser.`);
});
