# Whisper monitoring

An opt-in ruleset that makes private conversations scarce, consensual, and
publicly visible in aggregate.

**Why:** unlimited instant whispering favours the town. Good players can compare
notes with everyone in minutes, which no in-person game allows — at a real table
you have time for two or three conversations and everyone can see who you were
standing with. This restores both the scarcity and the visibility.

All six steps are built. The step sections below describe what shipped; where
the implementation had to answer a question the spec did not, the answer is
recorded under "Where the build went past the spec".

---

## Decisions (settled — do not relitigate)

| Question | Decision |
| --- | --- |
| Who pays | Everyone in the room, one whisper each |
| When it's paid | On acceptance, at room creation. No reservations |
| Consent | Everyone invited must accept. Trios are all-or-nothing |
| Over-commitment | Allowed. More invites than slots is fine; first to accept wins |
| Declines | Invisible — too much clutter, too little information |
| Same people, later day | Costs a fresh whisper from each of them |
| Thread reuse | Same thread reopened, so history carries over |
| Trio cost | 1 whisper each, not 2 — see "Why trios cost one" |
| Night | No whispers at all |
| While gathered | No whispers — the gather freezes every open room |
| Dead players | Same rules. They also still talk freely in #town-square |
| Day 1 | Same budget as any other day |
| Storyteller rooms | Cost nothing, never appear in the log |
| Mid-game changes | None. Rules freeze at `/game start` |
| Minimum session length | None. Gathering is entirely ST discretion |

### Why trios cost one

A trio creates three information links for three whispers; a pair creates one
for two. On link-efficiency alone trios dominate, which argues for charging two.
They aren't charged two, for three reasons:

1. **Risk premium.** In a 12-player game, one partner is 27% likely to be evil;
   two partners is 49%. A trio is close to a coin flip on the demon hearing
   everything you know.
2. **Trios protect liars.** Cross-checking inconsistent stories is a townsfolk's
   best tool. In a trio evil tells one story to two people, and there is nothing
   to cross-check afterwards.
3. **Pricing them at two makes them dominated** — same links per whisper as a
   pair, but double the evil exposure. Nobody would ever open one and the
   feature would be dead.

The residual concern is that the risk premium decays: by Day 3 a confirmed core
can form trios almost safely. The counterweight is the public log, which makes a
consolidating bloc visible and targetable — and unlike the risk premium, that
gets *stronger* as the game goes on.

Because `whisperDay.sessions` is structured data, whether trios actually
dominate is answerable from recorded games rather than from intuition. Revisit
the budget and size defaults then.

---

## Data model

```js
game.whisperRules = { enabled, budget: 1–5, size: 2–3, log: 'live'|'summary'|'both' }
game.daySegment   = 'discussion' | 'town'
game.whisperDay   = { day, spent: { playerId: n }, sessions: [{ key, members, openedAt, threadId }], closed }
game.whisperInvites = { inviteId: { from, targets, accepted, messageIds, day } }
game.whisperLiveId  = messageId | null              // the live panel in #game-log
game.whisperRecordId = messageId | null             // the pinned record in #whispers
game.whisperRecord  = { "id:id[:id]": { threadId, days: [1, 3] } }   // whole game
cfg.whisperThreads  = { "id:id[:id]": threadId }    // rooms, reused all game
```

`whisperDay` rebuilds itself the first time it is asked about a new day, rather
than being wiped by a dawn hook — see `ledger()` in
[`src/whisperSessions.js`](../src/whisperSessions.js). `closed` marks that the
day's teardown has run, so the gather and a straight-to-night both trigger it
and neither does it twice. `whisperInvites` clears at gather and at night, and
each invite carries the `day` it was raised on so a stale button cannot be
pressed into a new one. `whisperThreads` persists for the whole game.

Anything reading `daySegment` must go through `daySegment(game)` in
[`src/game.js`](../src/game.js) — it defaults to `'town'` so games saved before
segments existed keep working.

---

## Step 3 — key generalisation and trio threads

**New: `src/whisperSessions.js`.** The single source of truth for room identity
and budget accounting. Nothing else may build a key inline.

```js
whisperKey(ids)        // dedupe → sort → join(':'). The ONLY place a key is made
membersOf(key)         // key → id[]
remaining(game, id)    // budget minus spent today
canOpen(game, ids)     // every participant has a slot, size respected, segment is 'discussion'
recordSession(game, ids, threadId)
```

**`src/whisper.js`** — `openWhisper(guild, users[])` for 2–3 participants:

- key on the sorted set, so `{A,B}` and `{A,B,C}` are different rooms and a pair
  never becomes a trio
- on reuse, unarchive **and** unlock, then post a `── Day 3 ──` divider so the
  new conversation is visibly separate from the old one
- set `autoArchiveDuration: 1440` at creation, so Discord's own 60-minute idle
  timer cannot close a room mid-day behind the bot's back

Callers in [`src/interactions.js`](../src/interactions.js) move from a
single-user select (`setMaxValues(1)`) to `size - 1`.

---

## Step 4 — invites, acceptance, and the ledger

**New: `src/whisperInvite.js`.**

Flow:

1. Inviter presses 🤫 and picks 1–2 people, bounded by `rules.size`.
2. Each target gets an ephemeral **Accept / Decline**. Declines are silent —
   the invite is dropped and nobody is told.
3. On the **last** acceptance, re-check that *every* participant still has a
   slot. Only then create the room and debit everyone.
4. If anyone has run dry in the meantime, the invite dies with a message and
   nobody is charged. Nothing was reserved, so there is nothing to refund.
5. When an inviter reaches zero, their outstanding invites are voided.

Invites expire at gather or nightfall, whichever comes first.

Guards, all of which must refuse politely rather than throw: wrong phase, wrong
segment, budget exhausted, room too large, target not seated, target is the
inviter, feature disabled.

**Bots must auto-accept.** `/test` seats simulated players who cannot press
buttons, so without this every whisper test deadlocks. Mirror how bots already
auto-vote in [`src/commands/test.js`](../src/commands/test.js).

---

## Step 5 — freeze at the gather

`closeWhispers()` in [`src/phaseFlow.js`](../src/phaseFlow.js), called by
`gatherTown()` and by the day→night move. Order matters:

1. Post the warning **into each open room**: *"📢 The town is gathering — this
   room closes in 60 seconds."*
2. Void every pending invite.
3. After 60s: **lock** each room — and deliberately do *not* archive it. Locking
   is the part that matters: an archived-but-unlocked thread silently reopens
   the moment anyone types in it. Archiving is what was dropped. An archived
   thread falls out of the channel list and out of the sidebar, leaving the
   thread browser behind the icon in the top right as the only way back to it —
   and a record that takes three clicks to reach is not a record anyone reads.
   Locked and unarchived, every room stays listed under #whispers all game.
   Players keep full read access either way. Discord's own idle timer still
   archives a room after a full silent day and `openWhisper` unarchives on the
   way back in, so nothing is lost; `/game end` archives whatever is left.
4. Post the day's summary (step 6).

Going to night directly from `discussion` runs the same teardown first, so a day
with no nominations still gets its record.

Unlocking on a later day needs `ManageThreads`, which the bot holds via
`/setup`.

---

## Step 6 — the three log modes

**`src/whisperLog.js`** holds all three, plus **`src/whisperPanel.js`** for the
players' own panel in #whispers.

**`live`** — one message in #game-log, edited in place, showing only the groups
open *right now*. No history, no timestamps, nothing to scroll back through. It
reads like glancing across a room. Rebuilt on every open and close.

**`summary`** — silent until the gather, then one post listing the day's rooms.
Recollection rather than observation.

**`both`** — the live panel during discussion, and the summary at the gather.

**The standing record.** One pinned message in #whispers, edited in place,
listing every room the game has opened, with a `<#threadId>` link into each and
the days it met on. The day's summary in #game-log links its rooms the same way.
Backed by `game.whisperRecord` (`key → { threadId, days[] }`), written by
`recordSession` and — unlike `whisperDay` — never rebuilt. See `recordedRooms()`
in [`src/whisperSessions.js`](../src/whisperSessions.js).

It follows `showsSummary`, so **`live` games do not get one**. That mode is
defined by having no history to scroll back through; a pinned index of every
room of the game is exactly the history it exists to withhold, and posting one
anyway would quietly repeal the Storyteller's choice of mode.

The links are safe in a public channel: `<#id>` on a private thread is a jump
for the people in it and an unclickable name for everyone else, and the line
beside it has already said who met.

Remaining budget is public, shown on the whisper panel in #whispers — everyone
can count it off the summary anyway, so hiding it only creates bookkeeping.

The summary posts at the **gather**, not at nightfall: whispering ends when the
town is called in, so that is when the record is complete, and it lands right
before nominations when it is most useful.

---

## Where the build went past the spec

Four questions the spec left open, and the answers now in the code.

**The Accept / Decline is not ephemeral — it lands in the target's Storyteller
thread.** Discord will only deliver an ephemeral message in reply to that user's
own interaction, so a target cannot be handed one out of the blue. A public
invitation in #whispers was the alternative and it breaks the settled decision
that declines are invisible: an invitation everyone saw, followed by no room, is
a decline announced. The Storyteller thread is private, already exists for every
seated player, and is guaranteed reachable. That the Storyteller can read it
costs nothing — Storyteller rooms are free and unlogged precisely because the
Storyteller already sees everything. `whisperInvites[id].messageIds` holds
`"channelId:messageId"` per target so the messages can be swept when the
invitation resolves or lapses.

**The picker is a string select of the game roster, not a user select.**
Simulated players from `/test add-bots` are not Discord users and cannot appear
in a user picker at all, which would leave every whisper path untestable without
fifteen humans. `setMaxValues(size - 1)` is honoured either way, and the roster
select has the side benefit that nobody unseated can be picked.

**The summary posts at the start of the grace period, not the end.** The spec
ordered it after the sixty seconds. Nothing said in that minute can change it —
no room can be opened or joined once the segment has moved to `town` — and its
whole value is landing in the beat before nominations open rather than a minute
into them.

**Sessions carry `threadId`.** The teardown at the gather needs to reach every
room it is closing; keeping the id on the session it was recorded against beats
re-deriving keys and looking each one up.

The sixty-second grace period is a plain `setTimeout`. A bot restarted inside
that minute leaves those rooms unlocked until the next gather closes them, which
is a smaller problem than blocking the gather interaction for a minute would be.

---

## Open items

- Live panel refresh cost: every open/close edits a message. Fine at 15 players,
  worth watching if rooms churn.
- `cfg.whisperThreads` has no eviction. It is cleared at `/game end`; a very long
  game accumulates keys but they are small.
- Discord rate-limits thread creation. Reuse keeps this well clear at 5 whispers
  × 15 players, but a first day with many new rooms is the worst case.

## Deploying

`node src/deploy-commands.js` registers slash-command definitions only. Buttons
and selects are matched by `custom_id` at runtime and need a bot restart, not a
deploy. Steps 3–6 add no slash commands, so the deploy for steps 1–2
(`/game new` options, `/phase town`) is the only one needed.
