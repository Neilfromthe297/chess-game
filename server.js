// ============================================================
//  CHESS GAME SERVER
//  This file runs on a computer (your laptop, or a hosting
//  service). Both players' browsers connect to it. It:
//    1. Sends the web page files to the browsers
//    2. Keeps the "real" copy of each game
//    3. Checks every move is legal (so nobody can cheat)
//    4. Passes moves and chat messages between the two players
// ============================================================

const path = require("path");
const http = require("http");
const express = require("express");          // serves web pages
const { Server } = require("socket.io");     // real-time messages
const { Chess } = require("chess.js");       // chess rules

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Hosting services tell us which port to use via PORT.
// On your own computer we fall back to 3000.
const PORT = process.env.PORT || 3000;

// Send everything in the "public" folder to the browser.
app.use(express.static(path.join(__dirname, "public")));
// Let the browser also use chess.js (to show legal moves).
app.use("/lib", express.static(path.join(__dirname, "node_modules/chess.js/dist/esm")));

// ------------------------------------------------------------
//  Game rooms. Each room is one game between two players.
//  rooms = { "abc123": { chess, players: { w, b }, lastMove, chatLog } }
//
//  Each player's browser has its own secret "playerId" (saved in
//  the browser). When you refresh, the server sees the same
//  playerId and gives you back your seat, so the game carries on.
// ------------------------------------------------------------
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      chess: new Chess(),
      // each seat is { playerId, name, sockets: Set } or null
      players: { w: null, b: null },
      lastMove: null,
      chatLog: [],              // recent chat, re-sent after a refresh
      lastActive: Date.now(),
    });
  }
  return rooms.get(roomId);
}

// Games are kept even when everyone leaves, so people can come
// back. Once an hour, tidy up games nobody has touched in 24 hours.
const ONE_DAY = 24 * 60 * 60 * 1000;
setInterval(() => {
  for (const [id, room] of rooms) {
    const connected = io.sockets.adapter.rooms.get(id)?.size || 0;
    if (connected === 0 && Date.now() - room.lastActive > ONE_DAY) rooms.delete(id);
  }
}, 60 * 60 * 1000);

// Work out a human-readable status line for the game.
function describeStatus(chess) {
  const side = chess.turn() === "w" ? "White" : "Black";
  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "Black" : "White";
    return { over: true, text: `Checkmate! ${winner} wins.` };
  }
  if (chess.isStalemate()) return { over: true, text: "Draw by stalemate." };
  if (chess.isThreefoldRepetition()) return { over: true, text: "Draw by threefold repetition." };
  if (chess.isInsufficientMaterial()) return { over: true, text: "Draw: insufficient material." };
  if (chess.isDraw()) return { over: true, text: "Draw (50-move rule)." };
  if (chess.inCheck()) return { over: false, text: `${side} to move — CHECK!` };
  return { over: false, text: `${side} to move.` };
}

// Send the current game to everyone in the room.
function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("state", {
    fen: room.chess.fen(),          // a text code describing the board
    lastMove: room.lastMove,
    history: room.chess.history(),  // list of moves like ["e4","e5"]
    status: describeStatus(room.chess),
    players: { w: seatInfo(room.players.w), b: seatInfo(room.players.b) },
  });
}

// What everyone is allowed to see about a seat (not the secret id).
function seatInfo(seat) {
  return seat ? { name: seat.name, online: seat.sockets.size > 0 } : null;
}

// Send a chat line to the room and remember it for refreshes.
function sendChat(roomId, msg) {
  const room = rooms.get(roomId);
  if (room) {
    room.chatLog.push(msg);
    if (room.chatLog.length > 100) room.chatLog.shift(); // keep the last 100
    room.lastActive = Date.now();
  }
  io.to(roomId).emit("chat", msg);
}

function systemMessage(roomId, text) {
  sendChat(roomId, { system: true, text });
}

// ------------------------------------------------------------
//  Everything below runs whenever a browser connects.
//  "socket" represents that one player's connection.
// ------------------------------------------------------------
io.on("connection", (socket) => {
  let roomId = null;
  let myColor = null; // "w", "b", or null (spectator)
  let myName = "Player";

  // A player joins a room.
  socket.on("join", (data) => {
    roomId = String(data.room || "").slice(0, 40);
    myName = String(data.name || "Player").trim().slice(0, 20) || "Player";
    const playerId = String(data.playerId || "").slice(0, 64);
    if (!roomId || !playerId) return;

    const room = getRoom(roomId);
    socket.join(roomId);
    room.lastActive = Date.now();

    // 1) Is this someone coming back? Give them their old seat.
    // 2) Otherwise take a free seat: white first, then black.
    // 3) Otherwise the game is full, so they watch.
    let returning = true;
    if (room.players.w?.playerId === playerId) myColor = "w";
    else if (room.players.b?.playerId === playerId) myColor = "b";
    else {
      returning = false;
      if (!room.players.w) myColor = "w";
      else if (!room.players.b) myColor = "b";
      else myColor = null;
      if (myColor) room.players[myColor] = { playerId, name: myName, sockets: new Set() };
    }

    if (myColor) {
      const seat = room.players[myColor];
      seat.name = myName;
      seat.sockets.add(socket.id);
    }

    // Send them their colour plus the chat so far.
    socket.emit("joined", { color: myColor, chatLog: room.chatLog });

    const role = myColor === "w" ? "White" : myColor === "b" ? "Black" : "a spectator";
    if (!returning) systemMessage(roomId, `${myName} joined as ${role}.`);
    broadcastState(roomId);
  });

  // A player tries to make a move.
  socket.on("move", (move) => {
    const room = rooms.get(roomId);
    if (!room || !myColor) return;
    if (room.chess.turn() !== myColor) return;          // not your turn
    if (!room.players.w || !room.players.b) {
      socket.emit("errorMessage", "Wait for your opponent to join.");
      return;
    }
    try {
      // chess.js throws an error if the move is illegal.
      const result = room.chess.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || "q",
      });
      room.lastMove = { from: result.from, to: result.to };
      room.lastActive = Date.now();
      broadcastState(roomId);
    } catch (err) {
      socket.emit("errorMessage", "Illegal move.");
    }
  });

  // A chat message.
  socket.on("chat", (text) => {
    if (!roomId) return;
    text = String(text || "").trim().slice(0, 300);
    if (!text) return;
    sendChat(roomId, { name: myName, color: myColor, text });
  });

  // Start a fresh game (only the two players can do this).
  socket.on("newGame", () => {
    const room = rooms.get(roomId);
    if (!room || !myColor) return;
    room.chess = new Chess();
    room.lastMove = null;
    systemMessage(roomId, `${myName} started a new game.`);
    broadcastState(roomId);
  });

  // A player refreshes, closes the tab, or their phone loses
  // connection. We KEEP their seat and the game, and just mark
  // them offline, so they can come straight back.
  socket.on("disconnect", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.lastActive = Date.now();
    const seat = myColor && room.players[myColor];
    if (seat) seat.sockets.delete(socket.id); // shows "(offline)" when 0
    broadcastState(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Chess server running! Open http://localhost:${PORT} in your browser.`);
});
