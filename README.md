# ♞ Chess with Friends

An online chess game with live chat. Two people play from their own web browsers, and anyone else who opens the link can watch.

**Features:** play the computer (Stockfish, 7 difficulty levels from 400 to 3000) · public & private game lobbies with a live game list · play or spectate · secret codes for private games · drag-and-drop or click-to-move · legal-move dots · last-move highlights · captured pieces & material score · move list · sounds · resign, draw offers and rematch (colours swap) · chat · games survive refreshes and server restarts (each browser keeps a backup copy) · works on phones.

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
6. **Play vs Computer:** pick a difficulty from 400 (Beginner) to 3000 (Maximum) and a colour. The computer runs in your own browser. Use **↶ Takeback** to undo a move. Refreshing the page keeps your game.
7. Click **← Menu** to go back to the main menu. Leaving in the middle of a game counts as resigning, and your seat is freed for someone else.

---

## 5. Ideas for what to learn next
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
