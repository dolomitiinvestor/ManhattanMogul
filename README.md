# Manhattan Mogul

A multiplayer property-trading card game, played in the browser. It follows the full Monopoly Deal rules. Each player uses their own phone or computer.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

**On the same Wi-Fi:** other players open `http://<your-computer's-IP>:3000`.
**Over the internet:** deploy it (see below) and share the link.

To play:

1. One player enters their name and taps **Create new game**. They get a 4-letter room code.
2. The others enter the code, or open the share link (`/?room=CODE`).
3. The host taps **Start game**. The game supports 2–10 players, and a second deck is added above 5 players.

If a player refreshes the page or loses connection, they rejoin automatically. The host can remove a player who has dropped.

## Deploy

The server is one Node process that holds game state in memory. Any host that supports WebSockets works:

- **Render:** create a new Blueprint from this repo. `render.yaml` is included. The free tier sleeps when idle, and active games are lost when it restarts.
- **Fly.io / Railway / any Docker host:** use the included `Dockerfile`. The app listens on `$PORT`.

Run a single instance. Rooms live in memory and are not shared between instances.

## Rename things / tweak rules

All game content is in **`server/cards.js`**:

- `COLORS`: set names, card colors, set sizes, rent ladders
- `PROPERTIES`: property names and values
- `WILDS`, `RENTS`, `MONEY`: card mix and values
- `ACTIONS`: action names, descriptions, values, counts
- `RULES`: hand size, plays per turn, sets needed to win, and more

The page title and logo are in `public/index.html` and `homeHTML()` in `public/app.js`.

## What's implemented

- The full 106-card deck: money, properties, two-color and multi-color wilds, and all 10 action types. Rent cards come in two-color (charges everyone) and wild (charges one player) versions.
- Draw 2 each turn, or 5 if your hand is empty. Play up to 3 cards. Discard down to 7.
- Banking actions as money. Paying from your bank and properties, with no change given. If you can't cover a debt, you pay everything you have.
- Just Say No chains: counter, counter-counter, and so on. Each target of a multi-player action responds on their own.
- Double The Rent, stackable to 4×. Each copy uses a play.
- Houses and hotels, but not on railroads or utilities. They move to the owner's bank if their set gets broken.
- Sly Deal and Forced Deal, which can't take from complete sets. Deal Breaker, which takes a whole set including its buildings.
- Moving wild cards between colors for free on your turn.
- Overflow properties start a new set of the same color.
- Win check after every action (3 complete sets of different colors).
- Game log, chat, reconnection, responsive layout for phone and desktop, and a rules screen.

## Code layout

```
server/cards.js   card definitions and rules config
server/game.js    game engine (the server enforces all rules)
server/index.js   HTTP static server + WebSocket rooms
public/           browser client (plain HTML/CSS/JS, no build step)
test/             engine fuzz tests (npm test)
```
