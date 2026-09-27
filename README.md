# Manhattan Mogul

A multiplayer property-trading card game that follows the full Monopoly Deal rules. It runs entirely in Chrome (or any modern browser). Nothing to install, no server to run.

## Play

**Link:** https://dolomitiinvestor.github.io/ManhattanMogul/ (after the one-time setup below)

1. The host opens the link, enters a name and taps **Create new game**. They get a 4-letter code.
2. Everyone else opens the same link on their own phone or computer and enters the code. The host can also send them the invite link.
3. The host taps **Start**. The game supports 2–10 players.

The host's browser tab runs the game, so **the host must keep that tab open** until the game ends. Refreshing is fine for anyone, host included: the game resumes and players reconnect. A computer makes the best host, because phones can pause background tabs.

### One-time setup: free hosting on GitHub Pages

In the repo on GitHub, go to **Settings → Pages**. Under "Build and deployment", pick **Deploy from a branch**, choose the branch and the `/ (root)` folder, then **Save**. The link above goes live about a minute later.

Other options:
- **No hosting:** download the folder and double-click `index.html`. It works from a file, but every player needs a copy of the folder.
- **Any static host:** drag the folder into Netlify Drop (app.netlify.com/drop) to get a link.

## How it works

- `game.js` holds the full rules engine. It runs in the **host's** browser.
- Players connect straight to the host over WebRTC, using PeerJS (bundled in `vendor/`).
- The free public PeerJS server is only used to introduce players to each other. It carries no game data. PeerJS's free TURN relay helps on strict networks.
- Each player receives only their own hand.

## Rename things / tweak rules

All content lives in **`cards.js`**:

- `COLORS`: set names, colors, sizes, rents
- `PROPERTIES`: property names and values
- `WILDS`, `RENTS`, `MONEY`: the card mix
- `ACTIONS`: action names, descriptions, values and counts
- `RULES`: hand size, plays per turn, sets to win, and so on

The title is in `index.html` and `homeHTML()` in `app.js`. Edit, commit, and the Pages link updates.

## Files

```
index.html, style.css, app.js   the page and UI
cards.js                        card definitions and rules config
game.js                         rules engine
vendor/peerjs.min.js            PeerJS 1.5.4 (MIT)
test/engine.test.js             optional fuzz test for developers: `node test/engine.test.js`
```
