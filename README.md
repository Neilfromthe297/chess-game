# ♞ Chess with Friends

An online chess game with live chat. Two people play from their own web browsers, and anyone else who opens the link can watch.

**Features:** chess clocks (bullet, blitz, rapid, custom) · accounts with passwords and Elo ratings, profiles and a leaderboard · 7 friendly AI chess coaches (400–3000) who explain your moves, give hints and answer questions · play the computer (Stockfish, 7 difficulty levels from 400 to 3000) · public & private game lobbies with a live game list · play or spectate · secret codes for private games · drag-and-drop or click-to-move · legal-move dots · last-move highlights · captured pieces & material score · move list · sounds · resign, draw offers and rematch (colours swap) · chat · games survive refreshes and server restarts (each browser keeps a backup copy) · works on phones.

---

## 1. How it works (the big picture)

```
 Your browser  <──── internet ────>  SERVER  <──── internet ────>  Friend's browser
 (client.js)                       (server.js)                      (client.js)
```

* **The server** (`server.js`) runs on one computer. It hands out the web page, keeps the real copy of every game, checks each move is legal, and passes moves and chat between the players.
* **The client** (`public/` folder) runs in each player's browser. It draws the board and sends your clicks and chat messages to the server.
* They talk to each other with **WebSockets** (the `socket.io` library), a connection that stays open so moves show up instantly.

| File | What it does |
|------|--------------|
| `server.js` | The referee: rooms, move checking, chat relay |
| `public/index.html` | The page layout: lobby, board, chat box |
| `public/style.css` | Colours, sizes, and how it looks on phones |
| `public/client.js` | Draws the board, handles dragging & clicks, sounds, keeps a backup of the game |
| `public/pieces/` | The chess piece pictures (SVG images) |
| `accounts.js` | Sign up / log in, safe password storage, ratings, saved games (PostgreSQL database) |
| `coach.js` | The AI coach on the server: builds the facts, calls Claude, limits usage |
| `public/coaches.json` | The 7 coaches: names, ratings, personalities |
| `public/computer.js` | The computer opponent: talks to Stockfish and sets the difficulty |
| `public/engine/` | The Stockfish chess engine (runs inside the player's browser) |
| `package.json` | Lists the libraries the project needs |

Libraries used:
* **express** sends the web page files to browsers
* **socket.io** carries live messages (moves and chat)
* **chess.js** knows all the chess rules (check, checkmate, castling, en passant…)

---

## 2. Run it on your own computer

**Step 1: Install Node.js** (one time only)
Download the "LTS" version from https://nodejs.org and install it.
To check it worked, open a terminal (Mac: *Terminal*; Windows: *Command Prompt*) and type:

```bash
node -v
```

You should see a version number such as `v22.x.x`.

**Step 2: Open the project folder in the terminal**

```bash
cd path/to/chess-game
```

**Step 3: Install the libraries** (one time only; this creates the `node_modules` folder)

```bash
npm install
```

**Step 4: Start the server**

```bash
npm start
```

You'll see: `Chess server running! Open http://localhost:3000`

**Step 5: Play!**
Open http://localhost:3000, type your name, and click **Start game**.
To test on your own, copy the invite link into a second browser window. You will play both sides.

To stop the server, press `Ctrl + C` in the terminal.

> `localhost` means "this computer", so friends somewhere else **can't** open that link.
> To play with them over the internet, put the game online (section 3).

---

## 3. Put it online so friends can play

You need a **host**, a computer on the internet that runs `server.js` for you all the time.
**Render** (https://render.com) has a free plan and supports WebSockets, so this guide uses it.

### Step A: Put your code on GitHub
1. Create a free account at https://github.com.
2. Click **New repository**, name it `chess-game`, and click **Create**.
3. Upload your files. The easiest way is "uploading an existing file" on the repo page:
   drag in `server.js`, `package.json`, `package-lock.json`, `.gitignore`, `README.md`, and the whole `public` folder.
   **Don't upload `node_modules`**, because the host re-installs it itself.

### Step B: Deploy on Render
1. Sign up at https://render.com (you can sign in with GitHub).
2. Click **New + → Web Service** and pick your `chess-game` repository.
3. Fill in:
   * **Runtime:** Node
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
   * **Instance type:** Free
4. Click **Create Web Service** and wait a minute or two.
5. Render gives you an address like `https://chess-game-xxxx.onrender.com`. That's your game! 🎉

Open it, start a game, click **Copy**, and send the link to your friend.

**Good to know about free hosting:**
* The free server goes to sleep after about 15 minutes without visitors, so the first visit afterwards can take 30–60 seconds to load.
* Games are kept in the server's memory, so a restart or sleep wipes any game in progress.

**Updating the game later:** change your files, upload them to GitHub again, and Render rebuilds the site automatically.

---

## 4. How to play
1. Open the site and type your name.
2. **Create a game:** give it a name, choose **Public** or **Private**, and pick your colour (White, Black or Random).
   * **Public** games appear in the *Public games* list on the main menu. Anyone can click **Play** (if a seat is free) or **Watch**.
   * **Private** games are hidden from the list. They get a secret 6-letter code. Send the code (or the invite link) to your friend, who types it into **Join a private game**.
3. To move, drag a piece, or click it and then click where it should go. Dots show the legal moves.
4. Chat with the players and watchers in the chat box.
5. Use **½ Draw**, **⚑ Resign**, **⇅ Flip** and **＋ New** (rematch with colours swapped) under the move list.
6. **Learn with a Coach:** pick a coach (Pip 400 → Atlas 3000). Each of your moves gets a mark (★ best, ?! inaccuracy, ? mistake, ?? blunder), the coach comments in the chat, **💡 Hint** highlights a piece (press again for the answer), and you can type questions to your coach.
7. **Play vs Computer:** pick a difficulty from 400 (Beginner) to 3000 (Maximum) and a colour. The computer runs in your own browser. Use **↶ Undo** to take back a move. Refreshing the page keeps your game.
8. Click **← Menu** to go back to the main menu. Leaving in the middle of a game counts as resigning, and your seat is freed for someone else.

---

## 5. Switching on accounts and ratings

Accounts need a **database** — a permanent store for usernames, (scrambled) passwords, ratings and games. The game uses **PostgreSQL**, which many services host for you. Without one, everyone simply plays as a guest.

1. Create a free PostgreSQL database. **Neon** (https://neon.tech) is a good choice: sign up, create a project, and copy the **connection string** (it starts with `postgresql://` and ends with `?sslmode=require`). Check the provider's current free-plan limits before you rely on it — Render's own free database, for example, is deleted after a limited time.
2. On Render, open your service → **Environment** → **Add Environment Variable**:
   * Key: `DATABASE_URL`
   * Value: *(paste the connection string)*
3. Click **Save Changes**. When Render restarts, its log should say **"Accounts: connected to the database."** The game creates its tables automatically.
4. The main menu now shows **Log In** and **Sign Up** buttons.

How it keeps accounts safe: passwords are never stored — only a "hash" made with `scrypt`; logins use a random token in a secure, HttpOnly cookie (only a hash of it is stored); and repeated sign-up or login attempts are slowed down. There's no email, so passwords can't be reset — players should remember them.

**Ratings:** like big chess sites, each player has separate **Bullet**, **Blitz** and **Rapid** ratings, starting at 400 / 800 / 1200 / 1600 depending on the level chosen at sign-up. Only **rated** games change them: both players must be signed in and the game must have a clock. Ratings use the Elo system (new players' ratings move faster for their first 20 games). Games that end before both players have moved are "aborted" and don't count. Games restored after a server restart are always unrated.

**Clocks:** choose a time control when creating a game — Bullet (1 min, 1 | 1, 2 | 1), Blitz (3 min, 3 | 2, 5 min), Rapid (10 min, 15 | 10, 30 min), Custom, or No clock. "3 | 2" means 3 minutes each plus 2 seconds added after every move. Clocks start once both players have made their first move; running out of time loses (or draws, if the opponent can't possibly checkmate).

---

## 6. Switching on the AI coaches

Without any setup, the coaches use built-in tips. To let them really talk (explain moves, answer questions) they use **Claude**, Anthropic's AI:

1. Create an account at https://console.anthropic.com and add a payment method (Billing).
2. Go to **API Keys → Create Key**, and copy the key (it starts with `sk-ant-`). Keep it secret — never put it in your code or on GitHub.
3. On Render, open your service → **Environment** → **Add Environment Variable**:
   * Key: `ANTHROPIC_API_KEY`
   * Value: *(paste your key)*
4. Click **Save Changes**. Render restarts the game (1–2 minutes).
5. On the main menu, under **Learn with a Coach**, it should now say **✨ Coaches are powered by AI.**

**Cost control:** each visitor can get at most 60 coach messages an hour and 300 a day, and the whole site at most 3000 a day. You can change these with the environment variables `COACH_LIMIT_PER_HOUR`, `COACH_LIMIT_PER_DAY` and `COACH_LIMIT_SITE_PER_DAY`. It's also a good idea to set a monthly spend limit in the Anthropic Console (**Settings → Limits**).

---

## 7. Ideas for what to learn next
Try these in roughly this order. Each one teaches something new:

1. **Change the colours.** Edit the `--light-square` and `--dark-square` values at the top of `style.css`.
2. **Sound effects.** Play a sound when a move is made (look up `new Audio("move.mp3").play()`).
3. **Show captured pieces** beside the board.
4. **Drag and drop** pieces instead of clicking.
5. **Chess clocks**, e.g. a 5-minute timer for each player.
6. **Resign / offer draw** buttons.
7. **Save games in a database** so they survive server restarts.
8. **Turn it into an app.** Make the site a "PWA" (installable from the browser), or wrap it with **Capacitor** to publish it on the App Store and Google Play. Your HTML/CSS/JS code stays the same.

---

## Credits
The piece images in `public/pieces/` are the "cburnett" set by Colin M.L. Burnett,
taken from the open-source [chessground](https://github.com/lichess-org/chessground) project
(GPL-3.0; the original artwork is also available under GPLv2+ / CC BY-SA 3.0).

The computer opponent is [Stockfish](https://stockfishchess.org) 18 (lite, single-threaded build) from the
[stockfish.js](https://github.com/nmrugg/stockfish.js) project by Nathan Rugg, licensed under GPL-3.0
(see `public/engine/COPYING.txt`).

The AI coaches use [Claude](https://www.anthropic.com/claude) through the official `@anthropic-ai/sdk` package.
