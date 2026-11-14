# Chess with Friends — notes for Claude

Read this first. It's the briefing for any new chat working on this project.

## About the owner
- A beginner learning to code by building this game. Explain things simply, step by step, without jargon (or explain the jargon).
- Give click-by-click instructions for anything they must do themselves (GitHub, Render, Neon, Anthropic Console).
- They may sell or hand the game over to others, so keep licence files and credits intact.

## What the game is
An online chess website: play friends in public or private lobbies (with a live game list and spectators), chess clocks, accounts with ratings, a computer opponent, and AI chess coaches. Hosted on **Render** (free plan), code on **GitHub**; Render redeploys automatically when `main` changes.

## Files
| File | What it does |
|---|---|
| `server.js` | Express + Socket.IO server: lobbies/rooms, moves (validated with chess.js), clocks, draw/resign/rematch, chat, spectators, restoring games from browser backups, saving finished games |
| `accounts.js` | Sign up / log in / log out, passwords (scrypt), sessions (random token in HttpOnly cookie, only its SHA-256 stored), Elo ratings per category, saved games, profiles, leaderboard. PostgreSQL via `pg` |
| `coach.js` | AI coaches: builds reliable engine facts + coach persona, calls Claude with `@anthropic-ai/sdk`, per-visitor and site-wide limits |
| `public/index.html` | Page layout: main menu (lobby) screen and game screen, pop-ups |
| `public/style.css` | All styling; colours are CSS variables at the top; phone layout under 900px |
| `public/client.js` | All browser logic: menu, board drawing, drag/click moves, sounds (Web Audio), clocks display, chat, accounts UI, computer and coach games |
| `public/computer.js` | Talks to Stockfish (UCI) in a Web Worker: difficulty levels and position analysis |
| `public/coaches.json` | The 7 coaches (Pip 400 → Atlas 3000): names, ratings, personalities. Used by both browser and server |
| `public/engine/` | Stockfish 18 lite single-threaded (GPL-3.0) + `COPYING.txt` |
| `public/pieces/` | "cburnett" piece SVGs (GPL; from the chessground package) |
| `README.md` | Owner-facing guide: run locally, deploy, switch on accounts and AI, ideas |

## Settings (environment variables on Render — never in code)
- `DATABASE_URL` — PostgreSQL connection string (e.g. Neon). Without it, accounts are off and everyone is a guest.
- `ANTHROPIC_API_KEY` — turns on the AI coaches. Without it, coaches use built-in tips.
- Optional: `COACH_MODEL`, `COACH_LIMIT_PER_HOUR` (60), `COACH_LIMIT_PER_DAY` (300), `COACH_LIMIT_SITE_PER_DAY` (3000), `DATABASE_SSL_NO_VERIFY`.
- `PORT` is set by Render (3000 locally).

## Decisions — don't undo without asking the owner
- **Everything must keep working without a database or AI key** (guest mode, built-in coach tips).
- **The server is the source of truth**: it validates every move and keeps the official clock time.
- **Browsers keep a backup of online games** so a game survives Render's free plan sleeping. Restored games are **always unrated** (a backup can't be trusted for ratings).
- **Rated games** need two signed-in players and a clock. Games ending before 2 moves are "aborted" (not saved/rated). Rating categories: bullet / blitz / rapid by estimated length (minutes + 40 × increment seconds: < 3 min bullet, < 10 min blitz, else rapid). Elo with K=40 for a player's first 20 games, then 20.
- **Clocks** start after both players' first moves; timeout vs a side that can't mate is a draw.
- **Signed-in players' seats** are tied to `user:<id>`; guests to a random id saved in their browser.
- **Stockfish runs in the player's browser** (no server cost). The computer and coach games live entirely in the browser (`localStorage` key `chessBot`).
- **Coaches**: Stockfish judges moves (★ / ?! / ? / ??); the AI only *explains* the facts it is given. Coaches comment on mistakes always and on other moves sometimes (to limit AI cost). The API key stays on the server.
- **Security**: never store plain passwords or tokens; only accept JSON posts on account routes; rate-limit sign-up/login; use `textContent` (not `innerHTML`) for anything a user typed.
- **Dependencies** are pinned to versions that were at least a couple of weeks old when added. Don't upgrade casually.
- **Licences**: keep `public/engine/COPYING.txt` and the README Credits section (Stockfish and the piece set are GPL).

## Running and testing
- Run: `npm install` then `npm start` → http://localhost:3000.
- `npm test` does nothing yet; testing so far has been done with **Playwright browser scripts** (several browser windows/phones playing each other: lobbies, private codes, spectators, refresh, server restart restore, computer/coach games, clocks timing out, rated games and rating changes). Write such a script for any change and check there are no browser console errors.
- Accounts testing: start a temporary local PostgreSQL and run with `DATABASE_URL=postgres://...` (the schema is created automatically on start-up).
- AI coach testing without a real key: point `ANTHROPIC_BASE_URL` at a small fake server that records requests and returns a canned reply, and check the prompt it receives.
- Sign-up is limited to 5 per hour per IP — restart the server between big account tests.
- Take screenshots of desktop and phone layouts after visual changes.

## Workflow
- Explain the plan briefly before big changes; after changes, test, then commit and push to `main` (Render deploys it).
- Write clear commit messages describing what changed and why.
- Keep code comments friendly and explanatory — the owner learns from them.

## Ideas the owner has heard about (not built yet)
Game review after each game (reuse coach analysis), daily puzzles, installable phone app (PWA, then Capacitor), board/piece themes, real sound files, pre-moves and arrows, tournaments, quick matchmaking, chat moderation, a stats page, and an easy "rebrand" settings file (for selling to clubs).
