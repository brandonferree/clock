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
3. Invite the bot with the `bot` + `applications.commands` scopes and these permissions: Manage Roles, Manage Channels, Manage Threads, Create Public Threads, Create Private Threads, Send Messages, Send Messages in Threads, Manage Messages, **Pin Messages**, Embed Links, **Attach Files**, Read Message History, Add Reactions.
   - Quick invite URL: `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=2252195219237968`
   - **Pin Messages** is its own permission now — Discord split it out of Manage Messages. A bot invited with an older link posts the script reference sheets to #town-square and then fails to pin them, with a bare `Missing Permissions` that names nothing. If pinning is broken, re-invite with the link above (it updates the existing role rather than adding a second bot) and run `/st script`.
   - The single source of truth for this list is `src/permissions.js`; `/setup` checks against it and prints a matching invite link when something is missing.
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
5. **`/st deal`** — deal the whole town at random from the official setup table and privately tell every player who they are, all in one command. Or **`/assign player character`** to place characters one at a time. Either way the character is delivered to that player's private Storyteller thread with its full ability text and token art — see [Telling players their character](#telling-players-their-character).
6. **`/st night-order`** — private night order (first night vs. other nights) for the characters actually in play, with Storyteller reminders from clocktower.online data.
7. **`/phase day` / `/phase night`** — advance the game; announced in the game log. Night also fires the **night alert** (below).
8. **`/nominate player`** — any living player nominates; a voting panel with **YES/NO** buttons appears in `#town-square`. Dead players get one final yes-vote (tracked automatically). The Storyteller clicks **Close vote** to tally — the result is logged with the majority threshold.
9. **`/st kill` / `/st revive`** — record deaths (night kill, execution, other) in the game log.
10. **`/game end`** — archives all Grimoire and whisper threads and clears the game.

## Telling players their character

A character only ever reaches a player through their private `st-<name>` thread, as a card with the team, the full ability text, the token art, and an `@`-mention so they get a notification. Two commands put it there:

| | |
|---|---|
| **`/st deal`** | Deals the **whole town at once**, at random, using the official setup table for the player count, then delivers every character privately. This is the one-command way to run a randomized game. |
| **`/assign player character`** | Places **one** character on one player and delivers it. Use it for a hand-built setup, or to correct a deal — re-assigning re-delivers, so the player is told about the change. |

`/st deal` refuses to run if anyone already has a character, since a mid-game re-deal would tell the whole town they are somebody new. Pass `redeal:true` if that is genuinely what you want.

Neither applies setup-modifying abilities — a Baron does not add Outsiders, a Drunk is not swapped in. The deal follows the plain setup table, and you adjust with `/assign` afterwards.

If a player's thread cannot be reached (archived beyond recovery, or they left the server), the reply names them explicitly rather than silently skipping, so you know who still needs telling by hand.

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
- **`/st deal`** — randomly deal the whole town and privately tell everyone their character (see above).
- **`/st night-alert`** — re-fire the night alert: ping every acting player's Storyteller thread and post a fresh wake checklist in `#grimoire`.
- **`/st refresh`** — force-refresh the pinned Grimoire board (town, characters, deaths, phase, votes needed).
- **`/st script`** — re-post the full character reference with every ability for the current script.
- **`/whisper player`** or the **Open a private chat** button — creates a private thread between two players.
- **`/character name`** — look up any character's ability (private reply, autocompleted from the current script).
- **`/game status`** — who's alive, current phase, script.
- **`/st grimoire`** — Storyteller-only view of every player's character and life status, with a rendered picture of the board.

## Scheduling meetups

A Sesh-style event scheduler for game nights (or anything else).

- **`/meetup create title when`** — posts an event card with RSVP buttons. `when` takes plain English: `friday 8pm`, `tomorrow 7:30pm`, `oct 12 6pm`, `2026-10-20 19:00`, always read as **Pacific time**. Times are shown to everyone in **their own** timezone. `image` takes up to 4 links separated by spaces; more than one shows as a gallery.
  - **RSVP buttons** — pick a `preset` (Going/Maybe/Not going, Playing/Spectating/Maybe/Can't, Yes/No, On time/Late) or type your own in `options`: `✅ Playing (12), 👀 Watching, 🤔 Maybe, ❌ Out`. Up to 10 options; server custom emoji work too. `(12)` caps an option — extra sign-ups join a **waitlist** and are promoted (and DM'd) automatically when a spot opens.
  - Clicking a button again removes you. By default you can hold one answer at a time; set `multi: true` to allow several.
  - **Running tally** — each option lists who picked it with a live count (`Playing 9/12`), plus a one-line tally. `hide_attendees: true` shows counts only.
  - **`image`** — paste an image link (right-click a picture → *Copy image address*). The bot checks the link really is an image and tells you if you copied a page link instead.
  - Also: `description`, `location`, `duration`, `color`, `channel`, `mention` (role pinged on posting), and `remind` (minutes before start to ping everyone signed up; default 60, `0` off). Attendees are pinged again when it starts.
- **`/meetup web`** — a private link to the **web editor**: a calendar date picker (Pacific time), an RSVP options table (emoji, name, limit), up to 4 image links with previews, colour, reminders, and a live preview of the Discord post. Links last 2 hours and are tied to you.
  - **Notifications tab:** type `@` to pick roles, people, @everyone or @here to ping when the meetup is posted and when it starts. **Add role to attendees** gives a role to everyone signed up (except "not going"-type answers), either when they sign up or when the event starts, and can take it back when the event ends. Only people with *Manage Roles* can pick the role, and the bot needs *Manage Roles* with its own role above the one it hands out.
- **Guests** — track people who aren't on Discord by name: ⚙️ → **Guests** on the post (one box per option, one name per line), or the **Attendees** tab in the web editor. Guests show on the post as "Name *(guest)*", count toward option limits and the attendee list download, but are never pinged or given roles.
- **⚙️ on the post** (host or anyone with *Manage Events*) — **Edit on web** (every setting, including RSVP options and moving the post to another channel; people keep their answers when options are renamed or reordered), quick edit, download the attendee list, ping attendees, cancel/un-cancel, or delete.
- **Add to Google Calendar** button on every post.
- **`/meetup list`** — upcoming meetups with links and head counts.

The web editor is served by the bot at `http://localhost:3000/meetup` — by default only reachable from the computer running the bot. To let other people use their links, give it an address they can reach and set in `.env`: `MEETUP_WEB_HOST=0.0.0.0` and `MEETUP_WEB_URL=https://that-address` (for example with Tailscale Funnel: `tailscale funnel 3000`).

Meetups are stored in `data/meetups.json` and survive restarts; reminders resume when the bot comes back.

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
4. **`/test deal`** — randomly deals characters to everyone using the official setup table and delivers each to its thread (identical to `/st deal`, but it never objects to re-dealing, which is handy while testing). Follow with **`/st night-alert`** to see the Night 1 wake list.
5. `/phase day`, then `/nominate` — use the optional `as:` option to nominate on behalf of a bot.
6. **`/test vote how:Random`** — makes the bots vote on the open nomination; then click **Close vote**.
7. `/st kill`, `/phase night`, etc. — all player pickers autocomplete with bots included.
8. `/test remove-bots` (in lobby) clears them out.

## Notes

- Character/script data is vendored from the open-source [bra1n/townsquare](https://github.com/bra1n/townsquare) project that powers clocktower.online (`src/data/roles.json`, `src/data/editions.json`).
- **Character token art** is hotlinked from that same project, keyed by role id, so nothing is stored or served by this bot. It appears on `/character` lookups and on the character reveal in each player's Storyteller thread. Point `ICON_BASE_URL` at your own copy of the images to stop depending on GitHub. The art itself belongs to The Pandemonium Institute.
- Game state persists to `data/games.json`, so the bot can restart mid-game without losing anything.
- Private threads are used for all secret communication, so no server boost is required and the Storyteller can supervise everything from one place.
