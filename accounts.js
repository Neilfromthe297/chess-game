// ============================================================
//  ACCOUNTS AND RATINGS
//  Sign up, log in and log out, with passwords stored safely,
//  plus chess ratings that go up and down after rated games.
//
//  Everything is saved in a PostgreSQL database. Set the
//  DATABASE_URL environment variable (on Render) to switch this
//  on. Without it the game still works, but only for guests.
// ============================================================

const crypto = require("crypto");
const { promisify } = require("util");
const express = require("express");
const { Pool } = require("pg");

const scrypt = promisify(crypto.scrypt);
const DATABASE_URL = process.env.DATABASE_URL;

// ------------------------------------------------------------
//  CONNECTING TO THE DATABASE
//  Online databases need an encrypted (SSL) connection; a
//  database on your own computer doesn't.
// ------------------------------------------------------------
let pool = null;
if (DATABASE_URL) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: local || /sslmode=/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== "true" },
    max: 5,
  });
  pool.on("error", (err) => console.error("Database error:", err.message));
}

// Create the tables the first time (safe to run every start-up).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  start_rating   INT  NOT NULL DEFAULT 800,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  user_id  INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  rating   INT  NOT NULL,
  games    INT  NOT NULL DEFAULT 0,
  wins     INT  NOT NULL DEFAULT 0,
  losses   INT  NOT NULL DEFAULT 0,
  draws    INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, category)
);
CREATE TABLE IF NOT EXISTS games (
  id           SERIAL PRIMARY KEY,
  white_id     INT REFERENCES users(id) ON DELETE SET NULL,
  black_id     INT REFERENCES users(id) ON DELETE SET NULL,
  white_name   TEXT NOT NULL,
  black_name   TEXT NOT NULL,
  time_control TEXT NOT NULL,
  category     TEXT NOT NULL,
  rated        BOOLEAN NOT NULL,
  result       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  moves        TEXT NOT NULL,
  white_rating INT,
  black_rating INT,
  white_change INT,
  black_change INT,
  ended_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_white_idx   ON games (white_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS games_black_idx   ON games (black_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS ratings_board_idx ON ratings (category, rating DESC);
`;

let enabled = false;
const ready = pool
  ? pool
      .query(SCHEMA)
      .then(() => {
        enabled = true;
        console.log("Accounts: connected to the database.");
      })
      .catch((err) => console.error("Accounts are OFF — could not set up the database:", err.message))
  : Promise.resolve(console.log("Accounts are OFF (no DATABASE_URL set). Everyone plays as a guest."));

const isEnabled = () => enabled;

// ------------------------------------------------------------
//  PASSWORDS
//  We never store the password itself. "scrypt" turns it into a
//  scrambled "hash" (slow on purpose, so guessing is very hard).
//  Each user gets a random "salt" so equal passwords look different.
// ------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function checkPassword(password, stored) {
  const [kind, saltB64, hashB64] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected); // compare without leaking timing
}
// Used when the username doesn't exist, so the reply takes the same time.
const DUMMY_HASH = hashPassword("not-a-real-password");

// ------------------------------------------------------------
//  LOGIN SESSIONS
//  After logging in, the browser gets a random secret "token" in a
//  cookie. We only store a hash of it, so a database leak doesn't
//  let anyone log in as you.
// ------------------------------------------------------------
const COOKIE = "chess_session";
const SESSION_DAYS = 30;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3::interval)", [
    sha256(token),
    userId,
    `${SESSION_DAYS} days`,
  ]);
  return token;
}

function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 86400}`];
  if (req.secure) parts.push("Secure"); // only sent over https on Render
  res.setHeader("Set-Cookie", parts.join("; "));
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Who is this? (from a cookie header) -> { id, username } or null
async function userFromCookieHeader(cookieHeader) {
  if (!enabled) return null;
  const token = readCookie(cookieHeader, COOKIE);
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] || null;
}

// ------------------------------------------------------------
//  RATINGS
//  Separate ratings for Bullet, Blitz and Rapid (like big chess
//  sites). We use the "Elo" system: beat a stronger player and
//  you gain more points; lose to a weaker one and you lose more.
// ------------------------------------------------------------
const CATEGORIES = ["bullet", "blitz", "rapid"];

// Which category is a time control? Estimated game length =
// minutes + 40 × increment (seconds), the same idea chess sites use.
function categoryOf(clock) {
  if (!clock) return null;
  const estimate = clock.initial / 1000 + 40 * (clock.inc / 1000);
  if (estimate < 180) return "bullet";
  if (estimate < 600) return "blitz";
  return "rapid";
}

async function getRating(userId, category) {
  if (!enabled || !CATEGORIES.includes(category)) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(r.rating, u.start_rating) AS rating FROM users u
     LEFT JOIN ratings r ON r.user_id = u.id AND r.category = $2 WHERE u.id = $1`,
    [userId, category]
  );
  return rows[0]?.rating ?? null;
}

async function getRatings(userId) {
  const { rows } = await pool.query(
    `SELECT c.category, COALESCE(r.rating, u.start_rating) AS rating,
            COALESCE(r.games, 0) AS games, COALESCE(r.wins, 0) AS wins,
            COALESCE(r.losses, 0) AS losses, COALESCE(r.draws, 0) AS draws
     FROM users u CROSS JOIN unnest($2::text[]) AS c(category)
     LEFT JOIN ratings r ON r.user_id = u.id AND r.category = c.category
     WHERE u.id = $1`,
    [userId, CATEGORIES]
  );
  const out = {};
  for (const r of rows) out[r.category] = { rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws };
  return out;
}

// Elo: expected score, then move the rating towards the result.
// New players (fewer than 20 games) move faster (K = 40).
function eloChange(rating, opponent, score, games) {
  const expected = 1 / (1 + 10 ** ((opponent - rating) / 400));
  const k = games < 20 ? 40 : 20;
  return Math.round(k * (score - expected));
}

// Save a finished game. If it's rated and both players have
// accounts, update both ratings. Returns the new ratings.
// game = { white:{userId,name}, black:{userId,name}, timeControl,
//          category, rated, result:"1-0"|"0-1"|"1/2-1/2", reason, moves }
async function recordGame(game) {
  if (!enabled) return null;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    let ratings = null;
    const rated = game.rated && game.white.userId && game.black.userId && CATEGORIES.includes(game.category);
    if (rated) {
      // Make sure both players have a rating row, then lock them
      // (so two games finishing at once can't mix up the numbers).
      for (const id of [game.white.userId, game.black.userId]) {
        await db.query(
          `INSERT INTO ratings (user_id, category, rating)
           SELECT id, $2, start_rating FROM users WHERE id = $1
           ON CONFLICT DO NOTHING`,
          [id, game.category]
        );
      }
      const { rows } = await db.query(
        "SELECT user_id, rating, games FROM ratings WHERE category = $1 AND user_id = ANY($2) FOR UPDATE",
        [game.category, [game.white.userId, game.black.userId]]
      );
      const w = rows.find((r) => r.user_id === game.white.userId);
      const b = rows.find((r) => r.user_id === game.black.userId);
      const scoreW = game.result === "1-0" ? 1 : game.result === "0-1" ? 0 : 0.5;
      const changeW = eloChange(w.rating, b.rating, scoreW, w.games);
      const changeB = eloChange(b.rating, w.rating, 1 - scoreW, b.games);
      const newW = Math.max(100, w.rating + changeW);
      const newB = Math.max(100, b.rating + changeB);
      const col = (score) => (score === 1 ? "wins" : score === 0 ? "losses" : "draws");
      await db.query(
        `UPDATE ratings SET rating = $3, games = games + 1, ${col(scoreW)} = ${col(scoreW)} + 1 WHERE user_id = $1 AND category = $2`,
        [game.white.userId, game.category, newW]
      );
      await db.query(
        `UPDATE ratings SET rating = $3, games = games + 1, ${col(1 - scoreW)} = ${col(1 - scoreW)} + 1 WHERE user_id = $1 AND category = $2`,
        [game.black.userId, game.category, newB]
      );
      ratings = { w: { before: w.rating, after: newW, change: newW - w.rating }, b: { before: b.rating, after: newB, change: newB - b.rating } };
    }
    await db.query(
      `INSERT INTO games (white_id, black_id, white_name, black_name, time_control, category, rated,
                          result, reason, moves, white_rating, black_rating, white_change, black_change)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        game.white.userId || null, game.black.userId || null, game.white.name, game.black.name,
        game.timeControl, game.category || "casual", !!rated, game.result, game.reason, game.moves.join(" "),
        ratings?.w.before ?? null, ratings?.b.before ?? null, ratings?.w.change ?? null, ratings?.b.change ?? null,
      ]
    );
    await db.query("COMMIT");
    return ratings;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

// ------------------------------------------------------------
//  LIMITS ON SIGN-UP AND LOGIN ATTEMPTS
//  Stops people guessing passwords or creating thousands of accounts.
// ------------------------------------------------------------
const attempts = new Map(); // key -> { count, resetAt }
function tooMany(key, max, windowMs) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || now > a.resetAt) attempts.set(key, (a = { count: 0, resetAt: now + windowMs }));
  a.count++;
  return a.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now > a.resetAt) attempts.delete(k);
}, 10 * 60 * 1000);

// ------------------------------------------------------------
//  THE WEB ADDRESSES FOR ACCOUNTS
// ------------------------------------------------------------
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const RESERVED = /^(admin|administrator|moderator|computer|coach|guest|system|player)/i;
const START_LEVELS = [400, 800, 1200, 1600]; // New, Beginner, Intermediate, Advanced

function setupAccounts(app) {
  const json = express.json({ limit: "10kb" });
  // Only accept JSON posts — a simple protection against other
  // websites submitting forms to ours.
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "Expected JSON." }));
  const needDb = (req, res, next) =>
    enabled ? next() : res.status(503).json({ error: "Accounts aren't switched on yet on this server." });

  app.get("/api/me", async (req, res) => {
    if (!enabled) return res.json({ accounts: false, user: null });
    try {
      const user = await userFromCookieHeader(req.headers.cookie);
      if (!user) return res.json({ accounts: true, user: null });
      res.json({ accounts: true, user: { username: user.username, ratings: await getRatings(user.id) } });
    } catch (err) {
      console.error("me:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  });

  app.post("/api/signup", jsonOnly, json, needDb, async (req, res) => {
    const { username, password, level } = req.body || {};
    if (tooMany(`signup:${req.ip}`, 5, 60 * 60 * 1000)) {
      return res.status(429).json({ error: "Too many sign-ups from here. Please try again later." });
    }
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: "Usernames are 3–20 letters, numbers or _ (no spaces)." });
    }
    if (RESERVED.test(username)) return res.status(400).json({ error: "That username isn't allowed. Please pick another." });
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Passwords must be at least 8 characters." });
    }
    if (password.toLowerCase().includes(username.toLowerCase())) {
      return res.status(400).json({ error: "Your password shouldn't contain your username." });
    }
    const startRating = START_LEVELS.includes(Number(level)) ? Number(level) : 800;
    try {
      const hash = await hashPassword(password);
      const { rows } = await pool.query(
        `INSERT INTO users (username, username_lower, password_hash, start_rating)
         VALUES ($1, $2, $3, $4) ON CONFLICT (username_lower) DO NOTHING RETURNING id, username`,
        [username, username.toLowerCase(), hash, startRating]
      );
      if (!rows[0]) return res.status(409).json({ error: "That username is taken. Please pick another." });
      setSessionCookie(req, res, await createSession(rows[0].id));
      res.json({ ok: true, username: rows[0].username });
    } catch (err) {
      console.error("signup:", err.message);
      res.status(500).json({ error: "Server error — please try again." });
    }
  });

  app.post("/api/login", jsonOnly, json, needDb, async (req, res) => {
    const { username, password } = req.body || {};
    const name = String(username || "").toLowerCase().slice(0, 40);
    if (tooMany(`login-ip:${req.ip}`, 30, 15 * 60 * 1000) || tooMany(`login-user:${name}`, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes and try again." });
    }
    try {
      const { rows } = await pool.query("SELECT id, username, password_hash FROM users WHERE username_lower = $1", [name]);
      const user = rows[0];
      const ok = await checkPassword(String(password || ""), user ? user.password_hash : await DUMMY_HASH);
      if (!user || !ok) return res.status(401).json({ error: "Wrong username or password." });
      setSessionCookie(req, res, await createSession(user.id));
      res.json({ ok: true, username: user.username });
    } catch (err) {
      console.error("login:", err.message);
      res.status(500).json({ error: "Server error — please try again." });
    }
  });

  app.post("/api/logout", jsonOnly, async (req, res) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token && enabled) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]).catch(() => {});
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  // A player's public profile: ratings and recent games.
  app.get("/api/profile/:username", needDb, async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT id, username, created_at FROM users WHERE username_lower = $1", [
        String(req.params.username).toLowerCase().slice(0, 40),
      ]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: "No player with that name." });
      const games = await pool.query(
        `SELECT id, white_id, white_name, black_name, time_control, category, rated, result, reason,
                white_rating, black_rating, white_change, black_change, ended_at
         FROM games WHERE white_id = $1 OR black_id = $1 ORDER BY ended_at DESC LIMIT 15`,
        [user.id]
      );
      res.json({
        username: user.username,
        joined: user.created_at,
        ratings: await getRatings(user.id),
        games: games.rows.map((g) => {
          const asWhite = g.white_id === user.id;
          return {
            color: asWhite ? "w" : "b",
            opponent: asWhite ? g.black_name : g.white_name,
            opponentRating: asWhite ? g.black_rating : g.white_rating,
            outcome: g.result === "1/2-1/2" ? "draw" : (g.result === "1-0") === asWhite ? "win" : "loss",
            reason: g.reason,
            timeControl: g.time_control,
            category: g.category,
            rated: g.rated,
            change: asWhite ? g.white_change : g.black_change,
            endedAt: g.ended_at,
          };
        }),
      });
    } catch (err) {
      console.error("profile:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  });

  // Top 10 players in a category (players with at least one rated game).
  app.get("/api/leaderboard", needDb, async (req, res) => {
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : "blitz";
    try {
      const { rows } = await pool.query(
        `SELECT u.username, r.rating, r.games FROM ratings r JOIN users u ON u.id = r.user_id
         WHERE r.category = $1 AND r.games > 0 ORDER BY r.rating DESC, r.games DESC LIMIT 10`,
        [category]
      );
      res.json({ category, players: rows });
    } catch (err) {
      console.error("leaderboard:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  });

  // Remove expired logins once a day.
  setInterval(() => {
    if (enabled) pool.query("DELETE FROM sessions WHERE expires_at < now()").catch(() => {});
  }, 24 * 60 * 60 * 1000);
}

module.exports = { setupAccounts, ready, isEnabled, userFromCookieHeader, getRating, recordGame, categoryOf };
