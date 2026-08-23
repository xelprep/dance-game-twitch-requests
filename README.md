# StepMania Twitch Requests

The initial commit was 99.9% vibecoded with ChatGPT. Will human hands touch this further? Only time will tell.

A small local application that:

1. Recursively scans a local StepMania `Songs` directory.
2. Stores `.sm` and `.ssc` metadata in SQLite.
3. Provides a searchable web page and live request queue.
4. Connects a Twitch chat bot that accepts `!request <song>`.
5. Keeps the request queue in SQLite so it survives restarts.

## StepMania Twitch Requests — V2

This version adds a dedicated streamer control panel on a separate port.

## StepMania Twitch Requests — V3

Used genAI in VSCode to add an OAuth "Connect Twitch" flow and a simple control-panel UI to the control site so you can connect the bot from the browser instead of manually creating/managing tokens. At this point in the tool's lifecycle, I still haven't even bothered attempting to run this yet.

## Requirements

- Node.js 20+
- A local StepMania Songs directory
- A Twitch bot account/token

## Ports

Viewer site:

```text
http://STREAMING-PC:3000
```

Streamer control panel:

```text
http://STREAMING-PC:3001
```

Both servers listen on `0.0.0.0` by default, so another computer on your LAN can connect using the streaming PC's LAN IP.

Example:

```text
http://192.168.1.50:3001
```

Do not expose port 3001 to the public Internet. It is intended for your LAN.

## Streamer control features

The control panel provides:

- Live Now Playing display
- Play a specific queued request
- Play Next
- Complete current song
- Skip requests
- Move requests up/down
- Clear the queue
- Block a song
- Block a Twitch user
- Remove blacklist entries
- Rescan the StepMania Songs folder
- Live queue/stat updates

## Control-panel password

Set:

```text
CONTROL_PASSWORD=a-long-random-password
```

The control panel then uses HTTP Basic Authentication. The browser will ask for:

- Username: `streamer`
- Password: your `CONTROL_PASSWORD`

This is not encryption, so keep the control panel LAN-only. For a hostile/untrusted network, use HTTPS behind a reverse proxy/VPN instead.

## Install

```bash
npm install
```

Copy `.env.example` to `.env` and set:

```text
TWITCH_USERNAME=your_bot_username
TWITCH_OAUTH_TOKEN=oauth:...
TWITCH_CHANNEL=your_channel
SONGS_DIR=C:\Path\To\StepMania\Songs
```

Then:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Twitch command

Viewers use:

```text
!request song title
```

The bot searches title, subtitle, artist, and pack. If exactly one match is found, it is added to the queue.

Examples:

```text
!request Paranoia
!request Daft Punk
!request my favorite pack
```

If multiple songs match, the bot asks the viewer to be more specific.

## Queue rules

- `MAX_REQUESTS_PER_USER` limits how many queued requests a viewer can have.
- `QUEUE_LIMIT` caps the total queue.
- A song cannot be requested twice while already queued.

## Database

The SQLite database is:

```text
data/stepmania.db
```

It remains local to the streaming PC. No song audio is uploaded or served.

## Rescanning

The app scans at startup. If you add or remove songs while it is running, restart the app:

```bash
npm start
```

## Making the web page public

The Twitch bot itself does not require the website to be public. It receives requests directly from Twitch chat.

If you want viewers to browse the library, expose port 3000 through a secure tunnel or reverse proxy. Do not port-forward the Node process directly to the Internet without authentication/rate limiting.

## Streamer workflow

The intended workflow is:

1. Run this app on the same PC as StepMania.
2. Viewers type `!request <song>` in Twitch chat.
3. The bot adds the song to SQLite.
4. The queue page at `http://localhost:3000` shows the order.
5. The streamer selects/plays the next song in StepMania.
6. Marking queue items complete/skip can be accomplished on streamer-only control panel.

## Important

The app intentionally stores the StepMania file path locally and does not upload or serve the song audio files. This is a metadata/request queue, not a music distribution server.

## Control Panel limitation

The control panel does not directly press buttons inside StepMania. "Play" changes the request state to `playing`; the actual chart/song selection still happens in StepMania.
