# 🕰️ Clocktower — Blood on the Clocktower for Discord

A Discord bot that runs Blood on the Clocktower games with the same structure as an in-person game, using character data from [clocktower.online](https://clocktower.online/) (Trouble Brewing, Bad Moon Rising, Sects & Violets, and Laissez un Faire).

## What it builds in your server

Running `/setup` creates a **Blood on the Clocktower** category with:

| Channel | Purpose |
|---|---|
| `#town-square` | Open chat for all players — public discussion, nominations, and voting happen here. When a game starts, each player also gets a **private thread** under this channel: a one-on-one line to the Storyteller where their character is delivered. |
| `#game-log` | **Read-only.** Every game action (joins, phases, nominations, vote tallies, deaths) is logged here by the bot. Nobody can chat. |
| `#grimoire` | **Storyteller-only — hidden from players.** Holds the **pinned live board** (who is alive, who they are, reminder tokens, phase, votes needed) plus the **full character reference** for the script. It shows hidden information, which is why players cannot see it. |
| `#whispers` | Private rooms. A button panel lets any player open a **private thread** with another player. The Storyteller can see all rooms. |

It also creates **Storyteller** and **Townsfolk** roles. The Townsfolk role is auto-assigned to seated players and removed when the game ends.

## Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications), add a **Bot**, and copy the token.
2. Under **Bot → Privileged Gateway Intents**, enable **Server Members Intent**.
3. Invite the bot with the `bot` + `applications.commands` scopes and these permissions: Manage Roles, Manage Channels, Manage Threads, Create Private Threads, Send Messages, Send Messages in Threads, Embed Links, Read Message History.
   - Quick invite URL: `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=395405511696`
4. Configure and run:

```bash
cp .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, and (recommended) GUILD_ID
npm install
npm run deploy         # registers slash commands
npm start
```

> The bot's role must be **above** the Storyteller/Townsfolk roles in your server's role list so it can assign them.

### If `/setup` reports a permission error

Discord only lets a bot write a channel permission overwrite for a permission it currently holds *in that channel*. If a channel ends up denying the bot something it needs, it cannot repair itself. Run **`/setup repair:true`** to delete and recreate the game channels with correct permissions from the start. Roles and game state (including an open lobby) are preserved; only the channels' message history is lost.

## Playing a game

1. **`/setup`** — build the channels (needs Manage Server permission).
2. Give a player the **Storyteller** role.
3. **`/game new script:Trouble Brewing`** — posts a join panel in `#town-square`; players click **Join Game**.
4. **`/game start`** — seats everyone, creates each player's private Storyteller thread under `#town-square`, posts the whisper panel, and begins Night 1.
5. **`/assign player character`** — Storyteller secretly assigns characters; each is delivered to the player's private Storyteller thread with full ability text.
6. **`/st night-order`** — private night order (first night vs. other nights) for the characters actually in play, with Storyteller reminders from clocktower.online data.
7. **`/phase day` / `/phase night`** — advance the game; announced in the game log. Night also fires the **night alert** (below).
8. **`/nominate player`** — any living player nominates; a voting panel with **YES/NO** buttons appears in `#town-square`. Dead players get one final yes-vote (tracked automatically). The Storyteller clicks **Close vote** to tally — the result is logged with the majority threshold.
9. **`/st kill` / `/st revive`** — record deaths (night kill, execution, other) in the game log.
10. **`/game end`** — archives all Grimoire and whisper threads and clears the game.

## The night alert

When day turns to night, the bot works out who actually acts tonight and does two things:

- **Pings each acting player's private Storyteller thread**, tagging the Storyteller there. That thread is the one-on-one line you were going to use anyway, so the reminder lands exactly where the conversation has to happen. The player sees only *"your character acts tonight, the Storyteller will be with you shortly"* — the character name and the official night reminder never appear in a thread a player can read.
- **Posts a wake checklist in `#grimoire`** (Storyteller-only, so it carries the hidden detail): every step in official night order, with the character, the clocktower.online Storyteller reminder, and a jump link to that player's thread.

The checklist is the response-driven half. Each waking player gets a button; tap it as you finish with them and the line turns ✅ and the button turns green, so you can see at a glance who is left. **Reset** clears the ticks. Dead players stay listed, struck through and marked *skip*, so you can see you are skipping them on purpose rather than wondering whether you missed someone.

It stays live: `/assign`, `/test deal`, `/st kill`, and `/st revive` all re-render the open checklist, so a mid-night death drops that player off the list.

**First night** additionally includes the two team-wide steps — **Minion info** (slot 6) and **Demon info & bluffs** (slot 9) — which have no entry in the character data, so the evil team gets woken like everyone else. A player who acts twice in one night (a Poisoner gets Minion info *and* their own ability) gets two checklist entries but only one thread ping.

Because characters are usually dealt *after* `/game start`, Night 1's alert only fires automatically if someone already has a character. Run **`/st night-alert`** once you have assigned to fire it — it also re-sends the alert any time you want a fresh checklist.

### Other commands

- **`/st remind player token`** / **`/st unremind player token`** — place or remove the script's official reminder tokens (Poisoned, Red herring, Protected, Master…). They appear on the pinned board, in `/st grimoire` (as small tokens next to the character, like the physical grimoire), and autocomplete from the current script — `unremind` only offers tokens the player actually has.
- **`/st night-alert`** — re-fire the night alert: ping every acting player's Storyteller thread and post a fresh wake checklist in `#grimoire`.
- **`/st refresh`** — force-refresh the pinned Grimoire board (town, characters, deaths, phase, votes needed).
- **`/st script`** — re-post the full character reference with every ability for the current script.
- **`/whisper player`** or the **Open a private chat** button — creates a private thread between two players.
- **`/character name`** — look up any character's ability (private reply, autocompleted from the current script).
- **`/game status`** — who's alive, current phase, script.
- **`/st grimoire`** — Storyteller-only view of every player's character and life status, with a rendered picture of the board.

## The board picture

The bot draws the town as an image — seats in a circle on real parchment tokens, a fogged rooftop skyline and the clocktower behind them — instead of screen-scraping the online grimoire. It renders from the bot's own game state, so it is always in sync. Dead players keep their token but get a shadow falling across the top of it, so you can still read who they were.

The tokens use the genuine `token.png` from the same project as the character art. It ships greyscale (a paper texture meant to be tinted), so the renderer multiplies parchment over it; drawn raw it comes out flat grey.

The backdrop in [`src/backdrop.js`](src/backdrop.js) is drawn procedurally from a fixed seed, so it is identical every render. It is deliberately dark and low-contrast, and every name label sits on a small translucent plate, because readability over the artwork is a requirement rather than a nice-to-have. The centre text has no plate — it relies on the backdrop's soft radial scrim instead, which keeps the town visible. The clock face is positioned from the seat-ring radius into the corner beyond it — the seats form a circle inscribed in a square, so the corners are free at any player count.

A status image is posted to `#game-log` on **both** `/phase day` and `/phase night`. The night one matters: it reflects whoever was executed during the day just ended.

Because the public view has no character to put on the token face, it uses that space for the dead vote instead — a ringed **tick** for a dead player who still holds their one ghost vote, a ringed **cross** once it is spent, with the same thing written under the name. Living players are left unmarked. The grim view never shows these, since its token faces carry the character art.

There are **two versions, and the difference matters**:

| Where | Shows | Who sees it |
|---|---|---|
| **`/st grimoire`** | Every character, plus a red ring on evil players | Storyteller only (private reply) |
| **`#game-log` at `/phase day` and `/phase night`** | Seats, names, who is dead, and each dead player's ghost vote — **no characters, no alignments** | The whole town |

The public version deliberately draws blank tokens and neutral rings, so posting the day status can never leak the grimoire. If you add more posting sites, keep `reveal: false` for anything a player can read.

Character art is downloaded once per character and cached in `data/icon-cache/` (git-ignored), so a game only ever hits the network on its first render. If rendering fails for any reason, every command falls back to its text-only output rather than erroring.

## Testing solo

You can run a full game by yourself using simulated players (Storyteller only):

1. `/game new` → click **Join Game** yourself.
2. **`/test add-bots count:4`** — seats 4 AI placeholders (Alice, Bob, Carol, Dave) so you hit the 5-player minimum.
3. `/game start` — bots get Storyteller threads too (visible only to you).
4. **`/test deal`** — randomly deals characters to everyone using the official setup table. Follow with **`/st night-alert`** to see the Night 1 wake list.
5. `/phase day`, then `/nominate` — use the optional `as:` option to nominate on behalf of a bot.
6. **`/test vote how:Random`** — makes the bots vote on the open nomination; then click **Close vote**.
7. `/st kill`, `/phase night`, etc. — all player pickers autocomplete with bots included.
8. `/test remove-bots` (in lobby) clears them out.

## Notes

- Character/script data is vendored from the open-source [bra1n/townsquare](https://github.com/bra1n/townsquare) project that powers clocktower.online (`src/data/roles.json`, `src/data/editions.json`).
- **Character token art** is hotlinked from that same project, keyed by role id, so nothing is stored or served by this bot. It appears on `/character` lookups and on the character reveal in each player's Storyteller thread. Point `ICON_BASE_URL` at your own copy of the images to stop depending on GitHub. The art itself belongs to The Pandemonium Institute.
- Game state persists to `data/games.json`, so the bot can restart mid-game without losing anything.
- Private threads are used for all secret communication, so no server boost is required and the Storyteller can supervise everything from one place.
