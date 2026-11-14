// ============================================================
//  THE AI COACH (server side)
//  The browser sends us what happened in the lesson (the moves,
//  and Stockfish's verdict on the student's last move). We turn
//  that into reliable facts, add the coach's personality, and
//  ask Claude to say something friendly and helpful about it.
//
//  Your Anthropic API key lives ONLY here on the server, in the
//  ANTHROPIC_API_KEY environment variable — never in the browser.
//  Without a key, the browser uses built-in tips instead.
// ============================================================

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { Chess } = require("chess.js");
const COACHES = require("./public/coaches.json");

const MODEL = process.env.COACH_MODEL || "claude-opus-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ------------------------------------------------------------
//  LIMITS — so a busy day (or someone spamming) can't run up a
//  big bill. Change them on Render with environment variables.
// ------------------------------------------------------------
const PER_HOUR = Number(process.env.COACH_LIMIT_PER_HOUR) || 60;   // per visitor
const PER_DAY = Number(process.env.COACH_LIMIT_PER_DAY) || 300;    // per visitor
const SITE_PER_DAY = Number(process.env.COACH_LIMIT_SITE_PER_DAY) || 3000; // whole site

const visitors = new Map(); // ip -> { hourStart, hour, dayStart, day }
let site = { dayStart: Date.now(), day: 0 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function allowRequest(ip) {
  const now = Date.now();
  if (now - site.dayStart > DAY) site = { dayStart: now, day: 0 };
  let v = visitors.get(ip);
  if (!v) visitors.set(ip, (v = { hourStart: now, hour: 0, dayStart: now, day: 0 }));
  if (now - v.hourStart > HOUR) Object.assign(v, { hourStart: now, hour: 0 });
  if (now - v.dayStart > DAY) Object.assign(v, { dayStart: now, day: 0 });
  if (v.hour >= PER_HOUR || v.day >= PER_DAY || site.day >= SITE_PER_DAY) return false;
  v.hour++;
  v.day++;
  site.day++;
  return true;
}
// Forget old visitors once an hour so the list doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of visitors) if (now - v.dayStart > DAY) visitors.delete(ip);
}, HOUR);

// ------------------------------------------------------------
//  TURNING THE GAME INTO FACTS FOR THE AI
// ------------------------------------------------------------
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const COLOR = { w: "White", b: "Black" };
const isUci = (m) => typeof m === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m);

// Rebuild the game from a list of moves like ["e2e4", "e7e5"].
function replay(moves) {
  const chess = new Chess();
  for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return chess;
}

// "Nf3 (knight from g1 to f3)" for a move in a given position.
function describeMove(chess, uci) {
  if (!isUci(uci)) return null;
  try {
    const copy = new Chess(chess.fen());
    const m = copy.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    let text = `${m.san} (${PIECE_NAMES[m.piece]} from ${m.from} to ${m.to}`;
    if (m.captured) text += `, capturing a ${PIECE_NAMES[m.captured]}`;
    if (m.promotion) text += `, promoting to a ${PIECE_NAMES[m.promotion]}`;
    return text + ")";
  } catch {
    return null;
  }
}

function moveListText(chess) {
  const san = chess.history();
  if (san.length === 0) return "(no moves yet)";
  const parts = [];
  for (let i = 0; i < san.length; i += 2) parts.push(`${i / 2 + 1}. ${san[i]}${san[i + 1] ? " " + san[i + 1] : ""}`);
  return parts.join(" ");
}

function piecesText(chess) {
  const lists = { w: [], b: [] };
  const value = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const material = { w: 0, b: 0 };
  for (const row of chess.board())
    for (const p of row)
      if (p) {
        lists[p.color].push(`${PIECE_NAMES[p.type]} ${p.square}`);
        material[p.color] += value[p.type];
      }
  return { text: `White: ${lists.w.join(", ")}.\nBlack: ${lists.b.join(", ")}.`, material };
}

// Engine score (centipawns, from White's side) -> words for the student.
function evalWords(cp, studentColor) {
  if (typeof cp !== "number" || !isFinite(cp)) return "unknown";
  const forStudent = studentColor === "w" ? cp : -cp;
  if (Math.abs(forStudent) >= 9000) return forStudent > 0 ? "the student has a forced checkmate" : "the coach has a forced checkmate";
  const pawns = Math.abs(forStudent / 100).toFixed(1);
  if (Math.abs(forStudent) < 40) return "about equal";
  return forStudent > 0 ? `the student is better by about ${pawns} pawns` : `the coach is better by about ${pawns} pawns`;
}

const VERDICTS = {
  best: "the best move (the engine's top choice)",
  good: "a good move",
  inaccuracy: "an inaccuracy (a small slip)",
  mistake: "a mistake",
  blunder: "a blunder (a serious mistake)",
};

function systemPrompt(coach) {
  return `You are ${coach.name}, a friendly chess coach on the website "Chess with Friends". You are giving a student a lesson by playing a practice game against them. You play at about ${coach.rating} rating strength, and you coach players around that level.

Your personality: ${coach.personality}
What you like to teach: ${coach.focus}

How to reply:
- Talk directly to the student, warmly, like a real coach sitting beside them. Always kind and encouraging, never mean or sarcastic, even after a blunder.
- Keep it short: 1 to 3 sentences (under 60 words). Answers to the student's own questions may be up to about 120 words.
- Use words that suit a player rated about ${coach.rating}. Explain any chess term a player at that level may not know.
- The engine facts in each message come from Stockfish and are reliable. Base what you say on them. Do not invent move sequences or claim things about the position that the facts don't support. If you are not sure, explain the general idea or principle instead.
- When giving a hint, nudge the student towards the idea (which piece to look at, what to look for) without naming the exact move, unless they ask for the answer.
- When you mention a move, say it in words and notation, e.g. "your knight to f3 (Nf3)".
- Plain text only: no markdown, no lists, no headings. At most one emoji.
- Only talk about chess and learning chess. If the student asks about something else, kindly bring them back to the game.`;
}

// The facts + the task for this particular moment in the lesson.
function eventPrompt(body, coach) {
  const moves = body.moves;
  const chess = replay(moves);
  const student = body.playerColor;
  const coachColor = student === "w" ? "b" : "w";
  const name = String(body.playerName || "the student").slice(0, 20);
  const { text: pieces, material } = piecesText(chess);
  const diff = material[student] - material[coachColor];

  const facts = [
    "GAME FACTS (from the chess engine, reliable):",
    `Student: ${name}, playing ${COLOR[student]}. You (${coach.name}) play ${COLOR[coachColor]}.`,
    `Moves so far: ${moveListText(chess)}`,
    `Position (FEN): ${chess.fen()}`,
    `Pieces on the board:\n${pieces}`,
    `Material: ${diff === 0 ? "even" : diff > 0 ? `the student is ahead by ${diff}` : `the coach is ahead by ${-diff}`}.`,
    chess.isCheckmate()
      ? `Checkmate! ${COLOR[chess.turn() === "w" ? "b" : "w"]} has won the game.`
      : `It is ${COLOR[chess.turn()]}'s turn.${chess.inCheck() ? " That side is in check." : ""}`,
  ];

  let task = "";
  switch (body.kind) {
    case "greet":
      task = "The lesson is starting. Greet the student and give one tip for this game, suited to their level.";
      break;
    case "move": {
      const ply = Math.max(0, Math.min(moves.length - 1, Number(body.ply) || 0));
      const before = replay(moves.slice(0, ply));
      const played = describeMove(before, moves[ply]);
      const best = describeMove(before, body.bestUci);
      const verdict = VERDICTS[body.cls] || "a move";
      facts.push(
        `The student's last move: ${played}. Engine verdict: ${verdict}.`,
        `Before that move: ${evalWords(body.evalBefore, student)}. After it: ${evalWords(body.evalAfter, student)}.`,
        best && body.cls !== "best" ? `The engine's best move in that position was ${best}.` : ""
      );
      task =
        body.cls === "blunder" || body.cls === "mistake"
          ? "React to the student's move as their coach. Gently explain what went wrong and what the better idea was. You can remind them they may press the Undo button to try again."
          : body.cls === "inaccuracy"
            ? "React to the student's move. Say what was a little better and why, briefly."
            : "React to the student's move with short, specific encouragement or a useful tip about the position.";
      break;
    }
    case "hint": {
      const best = describeMove(chess, body.bestUci);
      facts.push(`The engine's best move for the student now is ${best}.`);
      task = body.reveal
        ? "The student asked to see the answer. Tell them the best move and explain in a sentence or two why it's good."
        : "The student asked for a hint. Point them towards the idea without naming the exact move.";
      break;
    }
    case "question":
      task = `The student asks you: "${String(body.question || "").slice(0, 300)}"\nAnswer as their coach.`;
      break;
    case "end":
      facts.push(`The game is over: ${String(body.result || "").slice(0, 80)}.`);
      task = "The game just ended. Congratulate or encourage the student, and give one thing to remember for next time.";
      break;
    default:
      return null;
  }
  return `${facts.filter(Boolean).join("\n")}\n\nTASK: ${task}`;
}

// Earlier chat in this lesson, so the coach remembers the conversation.
function historyMessages(history) {
  if (!Array.isArray(history)) return [];
  const messages = history.slice(-8).map((h) => ({
    role: h.from === "coach" ? "assistant" : "user",
    content: String(h.text || "").slice(0, 600) || "…",
  }));
  // The conversation has to start with the student, not the coach.
  if (messages.length && messages[0].role === "assistant") {
    messages.unshift({ role: "user", content: "(The lesson begins.)" });
  }
  return messages;
}

// ------------------------------------------------------------
//  THE WEB ADDRESSES THE BROWSER CALLS
// ------------------------------------------------------------
function setupCoach(app) {
  // Lets the menu show whether the AI is switched on.
  app.get("/api/coach/status", (req, res) => res.json({ ai: !!client }));

  app.post("/api/coach", express.json({ limit: "32kb" }), async (req, res) => {
    const body = req.body || {};
    const coach = COACHES.find((c) => c.id === body.coachId);
    if (!coach || !Array.isArray(body.moves) || body.moves.length > 600 || !body.moves.every(isUci)) {
      return res.status(400).json({ error: "bad request" });
    }
    if (body.playerColor !== "w" && body.playerColor !== "b") return res.status(400).json({ error: "bad request" });

    let prompt;
    try {
      prompt = eventPrompt(body, coach);
    } catch {
      return res.status(400).json({ error: "illegal moves" });
    }
    if (!prompt) return res.status(400).json({ error: "bad request" });

    // No API key, or over the limit: the browser uses built-in tips.
    if (!client) return res.json({ fallback: true, reason: "no-key" });
    if (!allowRequest(req.ip)) return res.json({ fallback: true, reason: "limit" });

    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 2000,
        output_config: { effort: "low" }, // short, friendly replies don't need deep thinking
        // If a reply is ever declined by the model's safety checks,
        // the API retries it on a fallback model automatically.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: systemPrompt(coach),
        messages: [...historyMessages(body.history), { role: "user", content: prompt }],
      });
      if (response.stop_reason === "refusal") return res.json({ fallback: true, reason: "refusal" });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (!text) return res.json({ fallback: true, reason: "empty" });
      res.json({ text: text.slice(0, 1200) });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error("Coach AI: the ANTHROPIC_API_KEY is not valid. Check it in your Render settings.");
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error("Coach AI: rate limited by the API — using built-in tips for now.");
      } else if (err instanceof Anthropic.APIError) {
        console.error(`Coach AI error ${err.status}: ${err.message}`);
      } else {
        console.error("Coach AI error:", err.message);
      }
      res.json({ fallback: true, reason: "error" });
    }
  });
}

module.exports = { setupCoach };
