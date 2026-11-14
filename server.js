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
//  rooms = { "abc123": { chess, players: { w, b }, lastMove } }
// ------------------------------------------------------------
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      chess: new Chess(),
      players: { w: null, b: null }, // each is { id, name } or null
      lastMove: null,
    });
  }
  return rooms.get(roomId);
}

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
    players: {
      w: room.players.w ? room.players.w.name : null,
      b: room.players.b ? room.players.b.name : null,
    },
  });
}

function systemMessage(roomId, text) {
  io.to(roomId).emit("chat", { system: true, text });
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
    if (!roomId) return;

    const room = getRoom(roomId);
    socket.join(roomId);

    // Give them a free seat: white first, then black.
    if (!room.players.w) myColor = "w";
    else if (!room.players.b) myColor = "b";
    else myColor = null; // room is full: they can watch

    if (myColor) room.players[myColor] = { id: socket.id, name: myName };

    socket.emit("joined", { color: myColor });
    const role = myColor === "w" ? "White" : myColor === "b" ? "Black" : "a spectator";
    systemMessage(roomId, `${myName} joined as ${role}.`);
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
    io.to(roomId).emit("chat", { name: myName, color: myColor, text });
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

  // A player closes the tab or loses connection.
  socket.on("disconnect", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (myColor && room.players[myColor]?.id === socket.id) {
      room.players[myColor] = null; // free their seat so they can rejoin
    }
    systemMessage(roomId, `${myName} left.`);
    broadcastState(roomId);

    // Delete the room when nobody is left in it.
    const left = io.sockets.adapter.rooms.get(roomId);
    if (!left || left.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Chess server running! Open http://localhost:${PORT} in your browser.`);
});
