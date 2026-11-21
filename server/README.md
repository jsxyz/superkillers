# Dedicated server

The game's dedicated server, as a Docker image. It runs the game page itself, the same file players open, in headless
Chromium and in the page's own server mode (the landing page's *Run a server*). Players join from the public game page
with the room code. Your own code can watch the game and act on it: hook modules run inside the page, every event goes
to stdout as a JSON line and to any webhooks you register, and a small HTTP API kicks, announces and changes the match.

## Run it

```sh
docker run -d --name superkillers --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 ghcr.io/jsxyz/superkillers-server
docker logs superkillers
```

The server writes every event to its log, a line of JSON each, so the two `--log-opt` flags keep the log to 30 MB.

The log names the room and its join link:

```
Room K7XQ2M  Yard  join: https://jsxyz.github.io/superkillers/#K7XQ2M
```

The image is rebuilt from this repository whenever the game changes, so `latest` always runs the game players open. Each
build is also tagged with its commit's sha. To build it yourself instead, from the repository root:

```sh
docker build -f server/Dockerfile -t superkillers-server .
```

Run it with `--network host`. Players connect to the server directly over WebRTC, and host networking lets them reach it
at the machine's own addresses. Behind Docker's own NAT (a bridge network) each player's link has to be made through that
NAT too, which can fail. The server needs the internet: the page loads its libraries from a CDN and finds players through
the public PeerJS signaling server.

Chromium picks the server's WebRTC ports from the system's ephemeral range (on Linux 32768–60999, unless
`net.ipv4.ip_local_port_range` says otherwise), so a firewall on the machine must let in UDP across that range.

`docker stop` closes the room cleanly. The players are told the host left, and the last events go out first. With a
fixed `ROOM_CODE` they are told instead that the server is restarting, and they ask for the room again by themselves,
three times over about a minute, so a server that restarts or updates in that time gets its players back.

## A room's key

A room code belongs to whoever registers it first with the signaling server. When this server stops or crashes, its code
is free within a second, while its players go on asking for the room by themselves for up to half an hour: whoever holds
the code then gets them. With `HOST_KEY_FILE` the server signs its welcome to each player, and a player's page remembers
the key the first time it joins. On every later join the page checks the key before it shows anything of the room or
sends anything to it. A server with another key, or with none, is shown as a room that has changed hands, with Join
anyway, and nothing goes back to it by itself.

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out room.key
docker run ... -e ROOM_CODE=K7XQ2M -v ./room.key:/keys/room.key:ro -e HOST_KEY_FILE=/keys/room.key ...
```

The file must be readable by the image's user (uid 1000). Keep the key across restarts and updates: a new key looks to
every returning player like another server. The join link then carries the key's fingerprint (`#K7XQ2M.` and 22 more
characters), and a page opened from that link checks even its first join. A link's key is taken only for a code the
page does not know yet: a page that knows another key for it checks against that one. What the key cannot do:

- hide a player's address: a page sends it to whoever holds the code as it connects, before anything can be checked;
- keep the room: whoever holds the code keeps this server from getting it back until they let it go;
- check a first join without the key in its link, or a page that has forgotten the key;
- protect a server without a key or with a random code, or pages served over plain http, which browsers give no
  WebCrypto: those join unchecked.

## What a link may carry

Every message a player's page or the server takes from another is checked before it is read. One larger than the game's
own pages ever send at once (16,299 bytes, the most its networking library sends) closes the link, and so does a link
past its byte budget:

- a player's link to the server, which carries the room: 1 MiB a second, with a 12 MiB burst, what twelve seconds at
  that rate can owe (the longest a server keeps a silent player);
- the server's link from each player, which carries that player's moves: 64 KiB a second, with a 512 KiB burst, eight
  seconds' worth (the longest a player waits on a silent server).

Each message counts as at least 2 KiB on a player's link and 256 bytes on the server's, so however small they are a link
carries at most 512 and 256 messages a second; the busiest real traffic sends about 100 and 64. A player's page also
shows at most 20 lines a second from its server (40 at once, the rest counted in one line), applies at most 8 rosters a
second of at most the room's players and enemies, and follows a level change at most every 5 seconds.

The busiest real traffic is far below both: a 32-player City at the fastest snapshot rate sends a player about 190 KB in
its busiest second, and a player sends about 11 KB a second. Only a modified page sends more. What the limits cannot do:

- each browser takes in a whole message before any page code sees it (Chromium up to about 4 MB, closing the link for a
  larger one; Firefox at least 8 MB), so that much memory is spent before the game can refuse it;
- a link made anew starts with a fresh budget, and the links a server holds at once, open or opening, are bounded by the
  size of its room;
- a room full of hostile players costs the server a budget for each of them.

## Configure it

Everything is an environment variable (`-e NAME=value`).

| Variable | Default | |
|---|---|---|
| `LEVEL` | `Yard` | a level by name or number: Yard, Foundry, Sprawl, City |
| `MODE` | `waves` | `ffa` (free-for-all, 32 players) or `waves` (4 players) |
| `FRAGS` | `25` | kills to win, 0–200; 0 is no limit |
| `MINUTES` | `0` | length of a match, 0–60; 0 is untimed |
| `ENEMIES` | `3` | computer-run enemies |
| `ROOM_CODE` | random | a fixed room code, 6 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, so the join link stays the same and players come back by themselves after a restart |
| `SERVER_NAME` | `The server` | the name players see when it kicks them |
| `JOIN_URL` | the public game page | printed with `#` and the room code as the join link |
| `HOOKS_DIR` | `/hooks` | hook modules |
| `STDOUT_EVENTS` | `*` | the event types written to stdout |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` (or `WEBHOOK_SECRET_FILE`), `WEBHOOK_EVENTS` | | one webhook |
| `WEBHOOKS_FILE` | `/config/webhooks.json` | several webhooks |
| `ACTION_HOST`, `ACTION_PORT` | `127.0.0.1`, `8080` | the action API; port 0 turns it off |
| `ACTION_TOKEN` (or `ACTION_TOKEN_FILE`) | | required whenever `ACTION_HOST` is not loopback |
| `HOST_KEY_FILE` | | the room's own key, so players who have been here can tell this server from anyone else holding its code; needs `ROOM_CODE` (see A room's key) |
| `GAME_FILE` | the game in the image | run another copy of the game, mounted into the container |
| `BROADCAST_URL` | | a stream every player sees on the level's screens (see Broadcasts) |

An event type list is `*` for every type, a comma list such as `kill,player.join`, or a list of types to leave out such as
`-damage,-chat`.

## Events

Each event is one JSON object, the same on stdout and to a webhook:

```json
{"id":"6f1c…","type":"kill","ts":1795030120.52,"seq":41,"game":"superkillers","match":"90aa2b7d…",
 "data":{"killer":{"id":1,"name":"Ann","kind":"player","character":"Sam"},
         "victim":{"id":101,"name":"Blue","kind":"enemy","character":"Blue"},"weapon":"Pistol"}}
```

`id` is unique to the event. `ts` is when it happened, in unix seconds. `seq` rises with every event of a server run.
`match` is a random id for the match it happened in. Wherever a person appears it is `{id, name, kind, character}`:
- `kind` is `player`, `enemy`, or `ally` (a computer-run team-mate a player fields, with `owner`, that player's id).
- `id` belongs to whoever has it now and is given to someone else after they leave.

| Type | Data |
|---|---|
| `ping` | `reason` (`start`, or `request` from the action API), `players`, `enemies`, `level`, `uptime` |
| `match.start` | `level`, `mode`, `fragLimit`, `minutes` |
| `match.end` | `reason` (`frags`, `time`, `restart`, `stop`), `winner` (or null), `standings` with `kills` each |
| `player.join` | `player` |
| `player.leave` | `player`, `reason` (`left`, `kicked`, `timeout`, `dropped`) |
| `player.rename` | `player`, `was` |
| `kill` | `killer`, `victim`, `weapon`; `via`, the team-mate who struck for its owner |
| `death` | `victim`, `weapon`: a death nobody is credited with |
| `chat` | `player`, `text`, `action` (an emote) |
| `damage` | `victim`, `attacker` (or null), `weapon`, `amount`, `hp` |
| `spawn` | `who`: a respawn, or an enemy arriving |
| `pickup` | `player`, `item`, `kind` (`gun`, `power`, `heal`) |
| `wave` | `name`, `number` |
| `broadcast.start` | `origin`: a broadcast started, or switched to a stream from there |
| `broadcast.stop` | `origin` |

Every `match.start` is followed by one `match.end`. A level change, a restart or the room emptying ends it as
`restart`. Hook modules can add types of their own.

Joins and leaves can come in bursts, as when a crowd joins at once or one player reconnects over and over. Every join and
leave is an event; the players' chat summarises them when they come faster than one a second. A webhook keeps at most
the newest 10,000 events it has not delivered.

**Names and chat are typed by players.** They are capped (16 and 160 characters) and stripped of control characters,
bidi overrides included. Names also lose `§` colour codes; chat may carry them. Neither is authenticated or unique.
Escape them wherever you show them, and never treat them as identity. No event carries the room code, the room's only
credential.

## Broadcasts

`BROADCAST_URL`, `POST /broadcast` or a hook's `broadcast(url)` names a stream that plays on the level's screens: a wall
and a billboard in the Yard, building fronts and rooftop boards in the City. The server only names it. Each player's
own browser fetches and plays it, so **the stream's server sees every player's address**. A player can turn broadcasts
off in the settings.

- The URL must be https, and the stream's server must allow the game's page (`https://jsxyz.github.io`) by CORS.
  Without that, the screens keep their idle look, and each player is told why once.
- A stream on a player's own machine or network is refused: localhost and `.local` names, and loopback, private,
  link-local and carrier-grade NAT addresses. Each player's browser refuses one from the public page, so the server
  refuses `BROADCAST_URL` at start and `POST /broadcast` with a 400 saying so. A `JOIN_URL` on such a host itself (a
  game served on a LAN) allows one. A public name that resolves to a private address cannot be told apart from any
  other: there only the browser's own Local Network Access stands between the stream and the player's network.
- HLS (an `.m3u8` URL) plays through hls.js, at the best rendition whose shorter side is 360 or less, else the smallest.
  MP4 and WebM play as the browser plays them.
- A stream may be lying or standing: one larger than 1920x1080 either way round (1080x1920 standing) is refused, and
  tried again later, as a stream can change its size. Each shows at its own shape on the 16:9 screens, with bars in
  the screens' idle colour.
- To broadcast from OBS you need a server that takes its stream and serves it as HLS over https with CORS. That isn't
  part of this image.
- A page that frames the game and already plays the stream itself can hand the game its pictures, so the viewer fetches
  the stream once. While a screen in view wants a picture, the game asks its parent page with
  `{type: 'stream-frame-want', v: 1, w: 640, h: 360, fps: 15}` (`fps: 0` once none does) and takes
  `{type: 'stream-frame', v: 1, bitmap}` with an ImageBitmap from that parent only, while it asks: at most 30 a second,
  each no larger than 1920x1080 either way round. Until the first one comes, the game fetches the stream itself as above;
  from then the pictures replace it, and when they stop for about 2 s while wanted it fetches the stream again until they
  come back. Such a page can put any picture on its viewer's screens, as it could already cover them, and the asks tell it
  when a screen is in view. Nothing of it reaches other players.
- A framed game that gets no key, pointer, touch or wheel input for about 30 s draws at most 30 frames a second, at one
  pixel per CSS pixel at most, until its next input. Only its drawing slows: the game, its sound and the pictures it takes
  keep their rates. A game that isn't framed draws as before.

## Webhooks

The server POSTs each event as its JSON body to every webhook that wants its type, one at a time and in order. Any 2xx
answer is delivery. Otherwise it tries again after 1, 5, 30 and then every 60 seconds, with the same body, until five
minutes after the event, then drops it. A webhook holds at most 10,000 waiting events, dropping the oldest first. Drops
are counted on stderr. Only https URLs are accepted, and a webhook gets every type but `damage` and `chat` unless you
list its types.

Headers: `Content-Type: application/json`, `X-Game-Event-Id`, `X-Game-Timestamp` (unix seconds of this attempt) and
`X-Game-Signature: sha256=` followed by the hex HMAC-SHA256 of `<X-Game-Timestamp>.<raw body>` under the webhook's
secret. To check a delivery, compute the HMAC over the exact bytes received and compare it in constant time. Refuse a
timestamp more than a few minutes off. Ignore an event id you have seen before.

```js
const want = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.').update(rawBody).digest('hex')
const ok = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))
```

Several webhooks go in a mounted file (`-v ./webhooks.json:/config/webhooks.json:ro`):

```json
[{ "url": "https://example.com/game-events", "secretFile": "/run/secrets/game-events", "events": "*" },
 { "url": "https://example.org/kills", "secret": "…", "events": ["kill", "match.end"] }]
```

The secret is never printed, and stderr names a webhook only by its origin.

## Hook modules

Mount a directory at `/hooks` (`-v ./hooks:/hooks:ro`). Each `.js` or `.mjs` file directly in it is loaded, in name
order, as an ES module into the game page before the room opens. Its default export is called with the hooks:

```js
// hooks/welcome.mjs
export default function (hooks) {
  hooks.on('player.join', ({ player }) => hooks.tell(player.id, 'Welcome, ' + player.name))
  hooks.filter('chat', ({ text }) => /\bspoiler\b/i.test(text) ? false : undefined)
  hooks.on('kill', ({ killer, victim }) => {
    if (victim.kind === 'enemy' && victim.character === 'Superman') hooks.announce(killer.name + ' brought down Superman')
  })
}
```

- `on(type, fn)` calls `fn(data, { type, match })` for each event of a type, or of every type with `'*'`, and returns a
  function that removes it.
- `filter(kind, fn)` asks `fn(data, { type, match })` before the host takes something from a player:
  - `join`: a joining player, and a player's new name (`rename` is true);
  - `chat`: a chat line it would pass on;
  - `hit`: a hit it would deal.

  Return `false` to refuse, `{ name, character }`, `{ text }` or `{ damage }` to change it, and anything else to let it
  pass. A refused player is let go, a refused line goes nowhere, and a refused hit does no harm at all.
- `emit(type, data)` sends an event of your own, a lowercase dotted name such as `league.goal`, with at most 8 KB of
  JSON. Your other hooks, stdout and the webhooks get it like any event.
- `announce(text)`, `tell(id, text)` and `kick(id or name)` act on players. So do `command('/bots 4')` (any chat
  command, returning the lines it printed), `setLevel(name or number)`, `setFragLimit(n)`, `setMatchMinutes(n)`,
  `setEnemies(n)`, `restart()` and `broadcast(url)` (an https URL, or null to stop). Each returns false when refused.
- `players()` lists everyone in the game. `room()` describes the room, its code included.

Hooks run in the middle of the game's own work, so keep them quick. A hook that throws is skipped and counted, and the
game goes on. Whatever hooks send players is held to a player's own limits: a line is at most 160 characters, eight may go at
once, and after that one each quarter second. A module may `fetch()` other services, which CORS governs, or emit an
event and let a webhook carry it.

## Action API

It listens on `127.0.0.1:8080` inside the container, so with `--network host` it is the machine's own loopback, open to
any program on that machine. It is for programs: a request with an `Origin` header is refused. Bound anywhere else
(`ACTION_HOST=0.0.0.0`) it needs `Authorization: Bearer <ACTION_TOKEN>` on every request, and the server refuses to start
without a token. A token set on loopback is required there too.

| Request | Body | |
|---|---|---|
| `GET /health` | | 200 while the room is open (the image's health check) |
| `GET /status` | | the room: code, join link, level, limits, players, webhook queues |
| `GET /players` | | everyone in the game |
| `POST /ping` | | sends a `ping` event |
| `POST /announce` | `{"text"}` | a line to every player |
| `POST /tell` | `{"id", "text"}` | a line to one player |
| `POST /kick` | `{"id"}` or `{"name"}` | |
| `POST /command` | `{"line"}` | a chat command, such as `/bots 4`; answers the lines it printed |
| `POST /level` | `{"level"}` | |
| `POST /frags` | `{"frags"}` | |
| `POST /minutes` | `{"minutes"}` | |
| `POST /enemies` | `{"enemies"}` | |
| `POST /restart` | | |
| `POST /broadcast` | `{"url"}` | starts or switches the broadcast; `{"url": null}` stops it |

```sh
curl -s -X POST http://127.0.0.1:8080/announce -d '{"text":"Double points this round"}'
```
