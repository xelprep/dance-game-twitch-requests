# Dance Game Twitch Requests

Dance Game Twitch Requests adds a searchable song library and Twitch chat request queue to a local dance game.

It recursively reads `.sm` and `.ssc` simfiles, stores song and chart metadata in a local SQLite database, accepts requests from Twitch chat or authenticated interfaces, and shows the live queue on a webpage or in OBS. It does not copy or upload song audio or write to the dance game's Songs folder.

## What you can do

- Search your local dance-game song library.
- Let Twitch viewers request a chart with chat commands.
- Manage the queue from an authenticated streamer control panel.
- Optionally allow a public website or moderator interface.
- Add a live request queue and Twitch chat mirror as OBS browser sources.
- Generate a StepMania `.crs` course from the current queue.
- Keep requests and settings across restarts.

The control panel changes the app's queue state. It does not launch or select a song inside the dance game.

## Quick start

### Option 1: Download a release

This is the simplest option if you do not plan to edit or build the source.

1. Open the project's [Releases page](../../releases).
2. Download the zip for your operating system and CPU:
   - macOS: Apple Silicon or Intel
   - Windows: x64 or ARM64
   - Linux: x64 or ARM64
3. Unzip the download.
4. Start the application:
   - **macOS:** double-click `Dance Game Twitch Requests.app`.
   - **Windows:** double-click `dance-game-twitch-requests.exe`.
   - **Linux:** run `./install.sh`, or run `chmod +x dance-game-twitch-requests && ./dance-game-twitch-requests`.

No Node.js installation is required for a release build.

### Option 2: Run from source

Source installs require Node.js 26 or newer.

```bash
git clone https://github.com/xelprep/dance-game-twitch-requests.git
cd dance-game-twitch-requests
npm install
npm start
```

On first run, the application opens an interactive setup wizard.

## Initial setup

Before starting, have your main dance-game Songs directory ready. It should contain pack folders and song folders with `.sm` or `.ssc` files.

The setup wizard asks for:

- The main Songs directory.
- An optional additional Songs directory.
- An optional directory for generated StepMania courses.
- A streamer display name.
- A strong control-panel password, entered twice.

The remaining settings are optional and can be configured later.

To rerun setup from source:

```bash
npm run setup
```

For a release binary:

```bash
# macOS
Dance\ Game\ Twitch\ Requests.app/Contents/MacOS/dance-game-twitch-requests --setup

# Windows
dance-game-twitch-requests.exe --setup

# Linux
./dance-game-twitch-requests --setup
```

Setup settings and generated files are stored separately from the application files. The default data location is:

```text
~/.dance-game-requests/
```

This includes the SQLite database, `.env` file, artwork cache, TLS certificates, Twitch credentials, and generated courses.

## Connect Twitch

1. Open the Twitch Developer Console and register an application.
2. Set the OAuth Redirect URL to:

   ```text
   https://localhost:3001/twitch-callback.html
   ```

3. Set the application category to **Chat Bot** and use a confidential client type.
4. Record the Client ID and generate a Client Secret.
5. Start the application and open `https://localhost:3001`.
6. Accept the local certificate warning if your browser displays one.
7. Sign in with the control-panel username and password chosen during setup.
8. Open the **Twitch** section, enter the Client ID, Client Secret, and channel name, then choose **Connect Twitch**.

You can authorize the streamer account or a separate bot account. A dedicated bot account is usually cleaner because bot messages come from a separate identity.

Twitch credentials are refreshed and stored locally. Reconnect if a previously authorized account did not receive newer requested permissions.

## Daily usage

### Start the application

Source:

```bash
npm start
```

Release: use the downloaded app or executable.

The app normally starts these local addresses:

| Page                   | Address                  |
| ---------------------- | ------------------------ |
| Viewer site            | `https://localhost:3000` |
| Streamer control panel | `https://localhost:3001` |

Both addresses use a local self-signed HTTPS certificate by default. Your browser will ask you to accept the certificate on first use.

### Manage requests

Open the streamer control panel to:

- View now-playing and queued songs.
- Search for songs and add requests.
- Play a queued request or play the next request.
- Move, complete, or skip requests.
- Clear the queue.
- Rescan the Songs directory.
- Block songs or Twitch users.
- Generate a StepMania course.
- Configure request limits and Twitch behavior.

The control panel uses HTTP Basic Authentication:

- Username: the streamer display name configured during setup.
- Password: the control-panel password.

### Twitch chat commands

Viewers discover songs with:

- `!search <title>` — show up to five matching songs.
- `!requestid <songID> <single|double> <difficulty> <meter>` — request a chart, for example `!requestid 42 single Expert 12`.
- `!queue` — show up to five queued songs.
- `!help` — show command instructions.

The default command prefix is `!`. The command names can be changed during setup or in the `.env` file.

### OBS browser sources

Add these addresses to OBS as browser sources:

```text
https://localhost:3000/overlay.html
https://localhost:3000/chatOverlay.html
```

- `overlay.html` shows the live request queue.
- `chatOverlay.html` shows live Twitch chat with Twitch username colors.

If OBS browser sources are unable to accept the local certificate, public HTTP can be enabled for trusted local use. Do not expose an HTTP public endpoint directly to the Internet.

## Rescan and add songs

The app scans the configured Songs directories at startup. After adding or removing songs while the app is running, choose **Rescan Songs** in the control panel or restart the app.

To skip a startup rescan when an existing database is known to be usable:

```bash
npm start -- --no-scan
```

For a release binary, pass `--no-scan` directly:

```bash
dance-game-twitch-requests.exe --no-scan
```

## Advanced usage

### Network settings

Open **Configuration → Network** in the control panel to change the public bind address and ports.

- Default public port: `3000`
- Default control port: `3001`
- Default bind address: `0.0.0.0`

Use `127.0.0.1` to limit access to the streaming PC. Use `0.0.0.0` to allow access from the local network. Saving network settings does not restart the servers; choose **Restart Server** to apply them.

Do not expose control port `3001` directly to the public Internet.

### Request constraints

Open **Configuration → Request Constraints** to temporarily restrict requests by:

- Style
- Pack
- Meter
- BPM
- Duration
- DDR Official status

Charts blocked by an active constraint are unavailable to viewers and in authenticated interfaces.

### Public website and web requests

The Twitch bot does not require a public website for use (although it is a nice feature to use) but external public access can be enabled via a HTTP tunnel or reverse proxy, or port forwarding if you are comfortable with that. Configuration of these options is beyond the scope of this document but a Cloudflare tunnel is a relatively simple and free option to look into.

Set `PUBLIC_URL` to the externally reachable address of the viewer site when offering it to viewers or using temporary moderator nominations:

```text
PUBLIC_URL=https://requests.example.com
```

The viewer site can be exposed only through a trusted HTTPS tunnel or reverse proxy. Do not open the application ports directly on a firewall without authentication and rate limiting.

For trusted local OBS-only use, HTTPS can be disabled:

```text
PUBLIC_HTTPS=false
```

The control panel always remains HTTPS.

### Scanner settings

`SCANNER_THREADS` controls the scanner and optional artwork worker concurrency:

```text
SCANNER_THREADS=-1
```

- `-1` uses all available CPU threads.
- A positive number limits concurrency, for example `SCANNER_THREADS=2`.

Song artwork is disabled by default. Enable it in the control panel's Settings, then choose **Build artwork**. Generated WebP thumbnails are cached under `~/.dance-game-requests/artwork-cache/`.

### Multiple Songs directories

An optional additional Songs directory can be configured in setup or manually:

```text
ADDITIONAL_SONGS_DIR=C:\Path\To\MoreSongs
```

Matching packs are merged. Duplicate songs are added once using the copy with the most charts, while charts that exist only in another copy are retained.

### Generated courses

Set a course destination:

```text
COURSES_DIR=C:\Path\To\StepMania\Courses
```

Generated courses are written in a `Generated Courses` subfolder. The queue that will be used for course generation must contain only one style: either all Single charts or all Double charts.

### Moderator access

The control panel can enable a separate public moderator page for queue management and song requests. Permanent moderators receive a username and password.

The moderator page is located at:

```text
https://localhost:3000/requestModerator.html
```

When `PUBLIC_URL` is a publicly reachable address, the control panel can nominate recent Twitch chat users as temporary moderators. Temporary moderators receive credentials or a one-click link through Twitch whispers.

For a stricter restart behavior, enable secure startup mode:

```text
SECURE_MODE=true
```

This clears saved permanent moderator accounts whenever the app starts.

## Updating

### Release builds

When a standalone binary is launched from a terminal, it checks for a newer compatible GitHub release and asks before updating:

```text
Update to <version>? [Y/n]
```

To check and update without the prompt:

```text
dance-game-twitch-requests.exe --update
```

Use the matching form for macOS or Linux. The updater replaces the standalone executable or macOS application copy and restarts it.

### Source installs

Stop the running app, then update the repository:

```bash
git pull
npm install
npm start
```

Your database and `.env` remain in the data root, so source updates do not normally remove them.

## Configuration file

The effective `.env` file is stored in the data root:

```text
~/.dance-game-requests/.env
```

The setup wizard preserves unrelated values and comments. You can edit this file manually, but restart the app after changing it.

To move the data root, create a text file named `data_dir.ini` in the application folder (the project folder for a source install). For example, it can contain:

```text
~/Documents/Dance Game Requests
```

The code does not create or require `~/Documents/Dance Game Requests` specifically; `~/Documents/Dance Game Requests` is only an example path. Replace it with any existing parent location and desired folder name. The parent folder must already exist, and the app must be allowed to create and write the new data folder.

A bare path and an `APP_DATA_DIR=path` line are both accepted. For example:

```text
APP_DATA_DIR=/Users/your-name/RequestData
```

For a standalone macOS app, create `data_dir.ini` next to `Dance Game Twitch Requests.app`, rather than inside the app bundle. For other standalone builds, place it next to the executable.

When `data_dir.ini` is absent, the `APP_DATA_DIR` environment variable is also accepted. Otherwise, the app uses `~/.dance-game-requests`.

## Command-line flags

Source:

```bash
npm start -- --no-scan
npm start -- --help
npm start -- --version
```

Standalone binary:

```text
--no-scan  Skip startup scanning when an existing database is usable
--setup    Run setup and exit
--update   Check for and install a standalone release
--help     Print available options
--version  Print the application version
```

## Troubleshooting

### The control panel password is rejected

Rerun setup and enter a new password:

```bash
npm run setup
```

For a standalone binary, use `--setup`.

### A port is already in use

Change the public or control port in **Configuration → Network**, then choose **Restart Server**. The startup log also identifies the conflicting port.

### Twitch is not joining chat

- Confirm that the Client ID and Client Secret belong to the same Twitch application.
- Confirm that the OAuth redirect is `https://localhost:3001/twitch-callback.html`.
- Reconnect from the control panel after changing credentials.
- Check the channel name and application status in the **Twitch** section.

### The public page or OBS source shows a certificate warning

This is expected for the first use of the automatically generated local certificate. Accept or trust the certificate for local use. HTTP can be enabled for trusted local OBS sources, but it is not suitable for a public Internet endpoint.

### Existing songs are missing

Verify `SONGS_DIR` points to the directory containing StepMania pack folders, then choose **Rescan Songs**. The scanner requires `.sm` or `.ssc` simfiles.

## Development

Run the automated tests and formatting checks:

```bash
npm run format
npm test
```

The test suite covers scanner parsing, chart hashes, queue behavior, authentication, whisper reply parsing, and startup smoke checks.

Watch mode:

```bash
npm run test:watch
```

## License

See [LICENSE](LICENSE).
