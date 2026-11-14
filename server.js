// ============================================================
//  CHESS GAME SERVER
//  This file runs on a computer (your laptop, or Render). All
//  players' browsers connect to it. It:
//    1. Sends the web page files to the browsers
//    2. Keeps a list of game lobbies (public and private)
//    3. Keeps the "real" copy of each game and checks every
//       move is legal (so nobody can cheat)
//    4. Runs the chess clocks
//    5. Passes moves, chat, resign and draw offers between players
//    6. Saves finished games and updates ratings (accounts.js)
// ============================================================

const path = require("path");
const http = require("http");
const express = require("express");          // serves web pages
const { Server } = require("socket.io");     // real-time messages
const { Chess } = require("chess.js");       // chess rules
const { setupCoach } = require("./coach");   // the AI chess coaches
const accounts = require("./accounts");      // sign up, log in, ratings

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Render tells us which port to use via PORT. Locally we use 3000.
const PORT = process.env.PORT || 3000;

// Render sits in front of our server, so trust it to tell us
// each visitor's real IP address (used for limits) and https.
app.set("trust proxy", 1);
app.use(express.static(path.join(__dirname, "public")));
setupCoach(app);
accounts.setupAccounts(app);
// Let the browser use chess.js too (to show legal moves).
app.use("/lib", express.static(path.join(__dirname, "node_modules/chess.js/dist/esm")));

// Every connection: check the login cookie, so we know if this
// is a signed-in player (socket.data.user) or a guest.
io.use(async (socket, next) => {
  try {
    socket.data.user = await accounts.userFromCookieHeader(socket.handshake.headers.cookie);
  } catch (err) {
    console.error("Login check failed:", err.message);
    socket.data.user = null;
  }
  next();
});

// ------------------------------------------------------------
//  TIME CONTROLS (CLOCKS)
//  Written as "minutes | increment": 3 | 2 means each player has
//  3 minutes, and gets 2 extra seconds after every move.
// ------------------------------------------------------------
function cleanClock(c) {
  if (!c) return null;
  const minutes = Number(c.minutes);
  const increment = Number(c.increment) || 0;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return null;
  if (!Number.isInteger(increment) || increment < 0 || increment > 180) return null;
  const clock = { initial: minutes * 60000, inc: increment * 1000 };
  clock.label = increment ? `${minutes} | ${increment}` : `${minutes} min`;
  clock.category = accounts.categoryOf(clock); // bullet / blitz / rapid
  return clock;
}

// ------------------------------------------------------------
//  GAME ROOMS (LOBBIES)
//
//  Public games get a random id like "k3x9q2ab" and are shown
//  in the list on the main menu.
//  Private games use their secret code as the id, e.g. "K7P2QX",
//  and are NOT shown in the list. You need the code to join.
//
//  Seats are tied to a "playerId": "user:12" for signed-in players
//  (so you get your seat back on any device), or a random id saved
//  in a guest's browser.
// ------------------------------------------------------------
const rooms = new Map();

function newRoom(meta) {
  const room = {
    name: meta.name,          // e.g. "Neil's game"
    isPrivate: meta.isPrivate,
    clock: meta.clock || null, // time control, or null for no clock
    rated: !!meta.rated,       // do ratings change?
    chess: new Chess(),
    moves: [],                // e.g. ["e2e4", "e7e5", "e7e8q"]
    players: { w: null, b: null }, // { playerId, userId, name, rating, sockets:Set }
    lastMove: null,
    result: null,             // set on resign / agreed draw / timeout
    drawOffer: null,          // "w" or "b" while a draw is offered
    chatLog: [],
    seen: new Set(),          // playerIds that have been here (to avoid repeat messages)
    touched: false,           // has anything happened since the server started?
    finished: false,          // has this game's end been handled?
    ratingChange: null,       // { w: +8, b: -8 } after a rated game
    gameNo: 0,                // goes up with each new game in this room
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  resetClock(room);
  return room;
}

function cleanMeta(meta = {}) {
  return {
    name: String(meta.name || "").trim().slice(0, 30) || "Chess game",
    isPrivate: !!meta.isPrivate,
    clock: cleanClock(meta.clock),
  };
}

// Random ids. Private codes skip look-alike characters (0/O, 1/I).
function randomId(chars, length) {
  let id = "";
  for (let i = 0; i < length; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
function newRoomId(isPrivate) {
  let id;
  do {
    id = isPrivate
      ? randomId("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)
      : randomId("abcdefghijkmnpqrstuvwxyz23456789", 8);
  } while (rooms.has(id));
  return id;
}

// Tidy up games nobody has been in for 24 hours (checked hourly).
const ONE_DAY = 24 * 60 * 60 * 1000;
setInterval(() => {
  for (const [id, room] of rooms) {
    if (connectedCount(id) === 0 && Date.now() - room.lastActive > ONE_DAY) {
      clearTimeout(room.flagTimer);
      rooms.delete(id);
    }
  }
}, 60 * 60 * 1000);

const NAMES = { w: "White", b: "Black" };
const other = (c) => (c === "w" ? "b" : "w");
const connectedCount = (roomId) => io.sockets.adapter.rooms.get(roomId)?.size || 0;

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

// Is a game being played right now (both seated, moves made, not over)?
const inProgress = (room) =>
  room.players.w && room.players.b && room.moves.length > 0 && !gameStatus(room).over;

// Turn a stored result like { type:"resign", loser:"w" } into text.
function makeResult(r) {
  if (!r) return null;
  if (r.type === "resign" && (r.loser === "w" || r.loser === "b")) {
    return { type: "resign", loser: r.loser, title: `${NAMES[other(r.loser)]} won`, reason: "by resignation" };
  }
  if (r.type === "timeout" && (r.loser === "w" || r.loser === "b")) {
    return { type: "timeout", loser: r.loser, title: `${NAMES[other(r.loser)]} won`, reason: "on time" };
  }
  if (r.type === "timeout-draw") return { type: "timeout-draw", title: "Draw", reason: "timeout vs insufficient material" };
  if (r.type === "draw") return { type: "draw", title: "Draw", reason: "by agreement" };
  return null;
}

function resetGame(room) {
  room.chess = new Chess();
  room.moves = [];
  room.lastMove = null;
  room.result = null;
  room.drawOffer = null;
  room.touched = true;
  room.finished = false;
  room.ratingChange = null;
  room.gameNo++;
  resetClock(room);
}

// ------------------------------------------------------------
//  THE CLOCK
//  The server keeps the official time. Clocks start once both
//  players have made their first move (like on big chess sites).
//  When it's your turn your time runs down; after your move you
//  get the increment. A timer fires if your time runs out.
// ------------------------------------------------------------
function resetClock(room) {
  clearTimeout(room.flagTimer);
  room.flagTimer = null;
  room.turnStart = null; // when the current player's clock started running
  room.timeLeft = room.clock ? { w: room.clock.initial, b: room.clock.initial } : null;
}

// Is a clock running right now, and whose?
const runningSide = (room) => (room.clock && room.turnStart && !room.finished ? room.chess.turn() : null);

// Start the clock for the player whose turn it is.
function startTurnClock(roomId, room) {
  clearTimeout(room.flagTimer);
  if (!room.clock || room.moves.length < 2 || gameStatus(room).over) {
    room.turnStart = null;
    return;
  }
  room.turnStart = Date.now();
  const side = room.chess.turn();
  room.flagTimer = setTimeout(() => checkFlag(roomId), room.timeLeft[side] + 50);
}

// Stop the clocks (game over): take off the time used this turn.
function stopClock(room) {
  clearTimeout(room.flagTimer);
  const side = runningSide(room);
  if (side) room.timeLeft[side] = Math.max(0, room.timeLeft[side] - (Date.now() - room.turnStart));
  room.turnStart = null;
}

// Can this side still checkmate? (If not, running out of time
// against them is a draw, not a loss — that's the official rule.)
function canCheckmate(chess, color) {
  let minors = 0;
  for (const row of chess.board())
    for (const p of row)
      if (p && p.color === color && p.type !== "k") {
        if (p.type === "n" || p.type === "b") minors++;
        else return true; // a pawn, rook or queen can always mate
      }
  return minors >= 2;
}

// Has the current player run out of time?
function checkFlag(roomId) {
  const room = rooms.get(roomId);
  if (!room || !runningSide(room)) return;
  const side = room.chess.turn();
  const left = room.timeLeft[side] - (Date.now() - room.turnStart);
  if (left > 0) {
    room.flagTimer = setTimeout(() => checkFlag(roomId), left + 50);
    return;
  }
  room.timeLeft[side] = 0;
  room.turnStart = null;
  room.result = canCheckmate(room.chess, other(side))
    ? makeResult({ type: "timeout", loser: side })
    : makeResult({ type: "timeout-draw" });
  room.touched = true;
  systemMessage(roomId, `${room.players[side]?.name || NAMES[side]} ran out of time.`);
  broadcastState(roomId);
}

// The clocks as sent to the browsers (time left right now).
function clockState(room) {
  if (!room.clock) return null;
  const left = { ...room.timeLeft };
  const side = runningSide(room);
  if (side) left[side] = Math.max(0, left[side] - (Date.now() - room.turnStart));
  return { initial: room.clock.initial, inc: room.clock.inc, label: room.clock.label, w: left.w, b: left.b, running: side };
}

// ------------------------------------------------------------
//  WHEN A GAME ENDS: stop the clocks, save it, update ratings.
// ------------------------------------------------------------
function finishGame(roomId, room) {
  room.finished = true;
  stopClock(room);
  const status = gameStatus(room);
  const w = room.players.w;
  const b = room.players.b;
  // Fewer than 2 moves: the game was "aborted" — nothing is saved.
  if (room.moves.length < 2) {
    if (room.rated) systemMessage(roomId, "Game aborted — ratings don't change when a game ends this early.");
    return;
  }
  if (!w || !b || !(w.userId || b.userId) || !accounts.isEnabled()) return; // only save games with an account
  const gameNo = room.gameNo;
  const result = status.title === "White won" ? "1-0" : status.title === "Black won" ? "0-1" : "1/2-1/2";
  accounts
    .recordGame({
      white: { userId: w.userId, name: w.name },
      black: { userId: b.userId, name: b.name },
      timeControl: room.clock ? room.clock.label : "No clock",
      category: room.clock?.category,
      rated: room.rated,
      result,
      reason: status.reason,
      moves: room.moves,
    })
    .then((ratings) => {
      if (!ratings || room.gameNo !== gameNo) return;
      room.ratingChange = { w: ratings.w.change, b: ratings.b.change };
      if (room.players.w?.userId === w.userId) room.players.w.rating = ratings.w.after;
      if (room.players.b?.userId === b.userId) room.players.b.rating = ratings.b.after;
      const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
      systemMessage(
        roomId,
        `Ratings: ${w.name} ${ratings.w.after} (${sign(ratings.w.change)}), ${b.name} ${ratings.b.after} (${sign(ratings.b.change)}).`
      );
      broadcastState(roomId);
    })
    .catch((err) => console.error("Could not save game:", err.message));
}

// How many people are watching (connected, but not in a seat)?
function spectatorCount(roomId, room) {
  const seated = (room.players.w?.sockets.size || 0) + (room.players.b?.sockets.size || 0);
  return Math.max(0, connectedCount(roomId) - seated);
}

const seatInfo = (s) =>
  s ? { name: s.name, online: s.sockets.size > 0, rating: s.rating ?? null, registered: !!s.userId } : null;

// Send the current game to everyone in the room. Each person
// also gets told which colour THEY are ("you").
function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (gameStatus(room).over && !room.finished) finishGame(roomId, room);
  const base = {
    meta: {
      name: room.name,
      isPrivate: room.isPrivate,
      code: room.isPrivate ? roomId : null,
      rated: room.rated,
      category: room.clock?.category || null,
      clock: room.clock ? { minutes: room.clock.initial / 60000, increment: room.clock.inc / 1000 } : null,
    },
    moves: room.moves,
    lastMove: room.lastMove,
    status: gameStatus(room),
    drawOffer: room.drawOffer,
    players: { w: seatInfo(room.players.w), b: seatInfo(room.players.b) },
    spectators: spectatorCount(roomId, room),
    clock: clockState(room),
    ratingChange: room.ratingChange,
  };
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit("state", { ...base, you: colorOf(room, s.data.playerId) });
  }
  updateLobbyList();
}

// ------------------------------------------------------------
//  THE LIST OF PUBLIC GAMES (shown on the main menu)
//  People on the main menu are in a socket.io room called
//  "menu". Whenever a game changes we send them a fresh list
//  (at most every half second, so we don't flood them).
// ------------------------------------------------------------
function lobbyList() {
  const list = [];
  for (const [id, room] of rooms) {
    if (room.isPrivate || connectedCount(id) === 0) continue; // hide empty & private games
    const status = gameStatus(room);
    let state = "waiting";
    if (status.over) state = "finished";
    else if (room.players.w && room.players.b) state = "playing";
    list.push({
      id,
      name: room.name,
      players: { w: seatInfo(room.players.w), b: seatInfo(room.players.b) },
      openSeat: !!freeSeat(room),
      state,
      clock: room.clock?.label || null,
      category: room.clock?.category || null,
      rated: room.rated,
      moveCount: Math.ceil(room.moves.length / 2),
      spectators: spectatorCount(id, room),
      createdAt: room.createdAt,
    });
  }
  // Games waiting for a player first, then newest first.
  const order = { waiting: 0, playing: 1, finished: 2 };
  return list.sort((a, b) => order[a.state] - order[b.state] || b.createdAt - a.createdAt).slice(0, 100);
}

let lobbyTimer = null;
function updateLobbyList() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    io.to("menu").emit("lobbies", lobbyList());
  }, 500);
}

// Which seat can a new player take? An empty one, or — once a
// game is finished — the seat of a player who has gone offline.
function freeSeat(room, preferred) {
  const over = gameStatus(room).over;
  const isFree = (c) => !room.players[c] || (over && room.players[c].sockets.size === 0);
  if ((preferred === "w" || preferred === "b") && isFree(preferred)) return preferred;
  if (isFree("w")) return "w";
  if (isFree("b")) return "b";
  return null;
}

// Look up a signed-in player's rating for this room's time control.
function loadSeatRating(roomId, room, seat) {
  if (!seat.userId || !room.clock?.category) return;
  accounts
    .getRating(seat.userId, room.clock.category)
    .then((rating) => {
      seat.rating = rating;
      broadcastState(roomId);
    })
    .catch((err) => console.error("Rating lookup failed:", err.message));
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
//  to rebuild the game. Restored games are never rated (a
//  backup comes from a browser, so it can't be fully trusted).
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
  room.result = makeResult(backup.result);
  room.rated = false;
  // Clocks carry on from the times in the backup.
  if (room.clock && backup.timeLeft) {
    for (const c of ["w", "b"]) {
      const t = Number(backup.timeLeft[c]);
      if (t >= 0 && t <= room.clock.initial + 180 * room.clock.inc) room.timeLeft[c] = t;
    }
  }
  // A game that had already ended was handled before the restart.
  room.finished = gameStatus(room).over;
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
  const user = socket.data.user; // { id, username } or null for guests
  let roomId = null;
  let playerId = null;
  let myName = "Player";

  const myRoom = () => rooms.get(roomId);
  const myColor = () => (myRoom() ? colorOf(myRoom(), playerId) : null);
  // Signed-in players are always "user:<id>"; guests use their browser's id.
  const idFor = (given) => (user ? `user:${user.id}` : String(given || "").slice(0, 64));
  const nameFor = (given) => (user ? user.username : String(given || "Player").trim().slice(0, 20) || "Player");

  // ---------- Main menu ----------
  socket.on("watchLobbies", () => {
    socket.join("menu");
    socket.emit("lobbies", lobbyList());
  });

  // Create a new game. The creator gets a seat straight away.
  socket.on("create", (data = {}, reply) => {
    if (typeof reply !== "function") return;
    const id = idFor(data.playerId);
    if (!id) return reply({ error: "Something went wrong — please refresh." });
    const meta = cleanMeta({ name: data.gameName, isPrivate: data.isPrivate, clock: data.clock });
    // Rated games need an account and a clock.
    meta.rated = !!(data.rated && user && meta.clock && accounts.isEnabled());
    const newId = newRoomId(meta.isPrivate);
    const room = newRoom(meta);
    let color = data.color;
    if (color !== "w" && color !== "b") color = Math.random() < 0.5 ? "w" : "b";
    const name = nameFor(data.playerName);
    room.players[color] = { playerId: id, userId: user?.id || null, name, rating: null, sockets: new Set() };
    rooms.set(newId, room);
    const kind = `${room.rated ? "rated" : "casual"} ${room.clock ? room.clock.label : "no-clock"} game`;
    systemMessage(newId, `${name} created a ${kind} and plays ${NAMES[color]}.`);
    loadSeatRating(newId, room, room.players[color]);
    reply({ roomId: newId });
  });

  // Does a private code exist? (used by "Join with code")
  socket.on("checkCode", (code, reply) => {
    if (typeof reply !== "function") return;
    code = String(code || "").trim().toUpperCase();
    reply({ ok: rooms.has(code) && rooms.get(code).isPrivate, code });
  });

  // ---------- Joining a game (to play or to watch) ----------
  socket.on("join", (data = {}) => {
    roomId = String(data.room || "").slice(0, 40);
    playerId = idFor(data.playerId);
    myName = nameFor(data.name);
    if (!roomId || !playerId) return;
    socket.data.playerId = playerId;
    socket.leave("menu");

    let room = rooms.get(roomId);
    if (!room) {
      // The server forgot this game (it restarted). If this browser
      // has a backup, bring the game back. Otherwise it's gone.
      if (data.backup?.meta) {
        room = newRoom(cleanMeta(data.backup.meta));
        rooms.set(roomId, room);
      } else {
        socket.emit("notFound");
        roomId = null;
        return;
      }
    }
    socket.join(roomId);
    room.lastActive = Date.now();

    const restored = tryRestore(room, data.backup);

    let color = colorOf(room, playerId);
    let message = null;
    let notice = null; // a note just for this player
    if (!color && data.want !== "watch") {
      if (room.rated && !user) {
        notice = "This is a rated game — sign up or log in to play. You're watching for now.";
      } else {
        // Wants to play: take the colour from the backup if it's
        // free (coming back after a restart), otherwise any free seat.
        const wanted = data.backup?.color;
        color = freeSeat(room, wanted);
        if (color) {
          const comingBack = color === wanted && restored;
          if (room.players[color]) {
            systemMessage(roomId, `${room.players[color].name} left — ${myName} takes their seat.`);
          }
          room.players[color] = { playerId, userId: user?.id || null, name: myName, rating: null, sockets: new Set() };
          // Sitting down at a finished game starts a fresh one.
          if (gameStatus(room).over) resetGame(room);
          if (!comingBack) message = `${myName} joined as ${NAMES[color]}.`;
          loadSeatRating(roomId, room, room.players[color]);
        }
      }
    }
    if (!color && !room.seen.has(playerId)) message = `${myName} is watching.`;
    room.seen.add(playerId);
    if (color) {
      room.players[color].name = myName;
      room.players[color].sockets.add(socket.id);
    }

    socket.emit("chatLog", room.chatLog);
    if (restored) systemMessage(roomId, "Game restored — carry on where you left off! (Restored games are unrated.)");
    if (message) systemMessage(roomId, message);
    if (notice) socket.emit("errorMessage", notice);
    if (restored) startTurnClock(roomId, room);
    broadcastState(roomId);
  });

  // Leave the game and go back to the main menu. Leaving in the
  // middle of a game counts as resigning.
  socket.on("leave", (reply) => {
    const room = myRoom();
    const color = myColor();
    if (room) {
      if (color) {
        if (inProgress(room)) {
          room.result = makeResult({ type: "resign", loser: color });
          room.touched = true;
          systemMessage(roomId, `${myName} left the game and resigned.`);
          broadcastState(roomId); // handle the result while both are still seated
        } else {
          systemMessage(roomId, `${myName} left the game.`);
        }
        room.players[color] = null; // free the seat for someone else
        room.drawOffer = null;
      } else {
        systemMessage(roomId, `${myName} stopped watching.`);
      }
      socket.leave(roomId);
      const oldRoom = roomId;
      roomId = null;
      broadcastState(oldRoom);
    }
    if (typeof reply === "function") reply();
  });

  // ---------- Playing ----------
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
    // Take the time used for this move off your clock.
    const now = Date.now();
    if (runningSide(room) === color) {
      const left = room.timeLeft[color] - (now - room.turnStart);
      if (left <= 0) {
        checkFlag(roomId); // too late — you ran out of time
        return;
      }
      room.timeLeft[color] = left;
    }
    try {
      const r = room.chess.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
      room.moves.push(r.from + r.to + (r.promotion || ""));
      room.lastMove = { from: r.from, to: r.to };
      room.drawOffer = null; // making a move turns down a draw offer
      room.touched = true;
      room.lastActive = now;
      if (room.clock && room.turnStart) room.timeLeft[color] += room.clock.inc; // the increment
      startTurnClock(roomId, room); // now the other player's clock runs
    } catch {
      if (room.clock && room.turnStart) room.turnStart = now; // keep counting from now
      socket.emit("errorMessage", "Illegal move.");
    }
    broadcastState(roomId);
  });

  socket.on("resign", () => {
    const room = myRoom();
    const color = myColor();
    if (!room || !color || gameStatus(room).over) return;
    room.result = makeResult({ type: "resign", loser: color });
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
      room.result = makeResult({ type: "draw" });
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
    if (inProgress(room)) {
      // Starting over mid-game counts as resigning this one.
      room.result = makeResult({ type: "resign", loser: myColor() });
      broadcastState(roomId);
    }
    resetGame(room);
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
  // (The clock keeps running, like on real chess sites.)
  socket.on("disconnect", () => {
    const room = myRoom();
    if (!room) return;
    room.lastActive = Date.now();
    const color = myColor();
    if (color) room.players[color].sockets.delete(socket.id);
    broadcastState(roomId);
  });
});

accounts.ready.then(() => {
  server.listen(PORT, () => {
    console.log(`Chess server running! Open http://localhost:${PORT} in your browser.`);
  });
});
