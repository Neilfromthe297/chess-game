// ============================================================
//  THE COMPUTER PLAYER
//  Uses Stockfish, the strongest free chess engine, running
//  inside the player's own browser (in a "Web Worker", so the
//  page doesn't freeze while it thinks). Nothing runs on the
//  server, so it's free however many people play.
//
//  We talk to Stockfish with text commands (the "UCI" protocol):
//    we send:   position fen <board>   then   go movetime 500
//    it sends:  bestmove e2e4
// ============================================================

// The difficulty levels shown on the main menu.
// Stockfish can limit itself to a rating (UCI_Elo) down to about
// 1320. Below that we also make it think less and sometimes play
// a random move, like a beginner would.
export const LEVELS = [
  { rating: 400,  label: "Beginner",     about: "Just learning how the pieces move.",       skill: 0,  depth: 1,  time: 100,  randomChance: 0.4 },
  { rating: 800,  label: "Novice",       about: "Knows the rules, often misses captures.",  skill: 0,  depth: 2,  time: 200,  randomChance: 0.2 },
  { rating: 1200, label: "Intermediate", about: "Plays sensibly but makes mistakes.",       skill: 3,  depth: 4,  time: 300,  randomChance: 0.06 },
  { rating: 1600, label: "Club player",  about: "A solid player — you'll need a plan.",     elo: 1600, depth: 12, time: 500 },
  { rating: 2000, label: "Expert",       about: "Strong tactics, few mistakes.",            elo: 2000, depth: 16, time: 700 },
  { rating: 2500, label: "Master",       about: "Plays like a chess master.",               elo: 2500, depth: 20, time: 900 },
  { rating: 3000, label: "Maximum",      about: "Full strength. Good luck!",                skill: 20, depth: 24, time: 1200 },
];
export const levelFor = (rating) => LEVELS.find((l) => l.rating === Number(rating)) || LEVELS[2];

const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

export class Computer {
  constructor() {
    this.waiting = [];               // things waiting for a reply from Stockfish
    this.queue = Promise.resolve();  // one move at a time
    try {
      this.worker = new Worker("engine/stockfish-18-lite-single.js");
      this.worker.onmessage = (e) => this.onLine(String(e.data));
      this.worker.onerror = () => (this.broken = true);
    } catch {
      this.broken = true; // very old browser: we'll use a simple backup player
    }
    this.ready = this.broken ? Promise.resolve(false) : this.start();
  }

  send(command) {
    if (this.worker && !this.broken) this.worker.postMessage(command);
  }

  // Each line Stockfish sends: see if anyone is waiting for it.
  onLine(line) {
    for (const w of [...this.waiting]) {
      if (line.startsWith(w.prefix)) {
        this.waiting.splice(this.waiting.indexOf(w), 1);
        w.resolve(line);
      }
    }
  }

  // Wait for a line starting with `prefix` (gives up after `ms`).
  waitFor(prefix, ms = 30000) {
    return new Promise((resolve) => {
      const w = { prefix, resolve };
      this.waiting.push(w);
      setTimeout(() => {
        const i = this.waiting.indexOf(w);
        if (i >= 0) {
          this.waiting.splice(i, 1);
          resolve(null);
        }
      }, ms);
    });
  }

  async start() {
    this.send("uci");
    if (!(await this.waitFor("uciok"))) {
      this.broken = true;
      return false;
    }
    this.send("isready");
    await this.waitFor("readyok");
    return true;
  }

  newGame() { this.send("ucinewgame"); }
  stop() { this.send("stop"); }

  // Ask for a move. `game` is a chess.js game. Returns
  // { from, to, promotion }. Requests are handled one at a time.
  chooseMove(game, rating) {
    const fen = game.fen();
    const legal = game.moves({ verbose: true });
    const job = this.queue.then(() => this.think(fen, legal, levelFor(rating)));
    this.queue = job.catch(() => {});
    return job;
  }

  async think(fen, legal, level) {
    if (legal.length === 0) return null;
    // Weaker levels sometimes just play a random move.
    if (level.randomChance && Math.random() < level.randomChance) return randomItem(legal);
    if (!(await this.ready)) return backupMove(legal);

    if (level.elo) {
      this.send("setoption name Skill Level value 20");
      this.send("setoption name UCI_LimitStrength value true");
      this.send(`setoption name UCI_Elo value ${level.elo}`);
    } else {
      this.send("setoption name UCI_LimitStrength value false");
      this.send(`setoption name Skill Level value ${level.skill}`);
    }
    this.send("position fen " + fen);
    this.send(`go depth ${level.depth} movetime ${level.time}`);

    const line = await this.waitFor("bestmove");
    const best = line && line.split(" ")[1]; // "bestmove e2e4 ponder e7e5"
    const move = best && legal.find((m) => m.from + m.to + (m.promotion || "") === best);
    return move || backupMove(legal);
  }
}

// If Stockfish can't load: grab the most valuable capture,
// otherwise play a random move.
function backupMove(legal) {
  const value = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const captures = legal.filter((m) => m.captured).sort((a, b) => value[b.captured] - value[a.captured]);
  return captures[0] || randomItem(legal);
}
