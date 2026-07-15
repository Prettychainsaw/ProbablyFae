# Bot Installer Plan

Goal: make this bot setup repeatable for Faye-like bots without hardcoding Faye-specific identity, channels, or behavior.

## Installer Inputs

- Bot display name.
- Starting personality text, written by the user.
- Discord bot token.
- Discord application/client ID.
- Discord channel ID to join/watch.
- Optional trigger role ID.
- Knowledge folder location, defaulting to `knowledge`.
- Model preference:
  - fast/local default, based on what the machine can run
  - slower/better local option, such as a larger Gemma/Qwen model if available
  - manual override

## Name Generator

The installer should offer three generated names and a fourth option:

- name choice 1
- name choice 2
- name choice 3
- none of these

If the user chooses `none of these`, generate three more. Also allow typing a custom name.

The generated name should be used consistently for:

- bot identity prompt
- personality file name/header
- default notes
- Discord intro
- logs/status messages where appropriate

## Knowledge Folder

Create a bot-owned knowledge folder with read/write access:

- `knowledge/books`
- `knowledge/notes`
- `knowledge/users`
- `knowledge/channel-sessions`
- `knowledge/personality-reverts`

The bot should be allowed to write its own notes/personality/user profiles inside this folder. User source files should usually be copied into the folder, not edited in place.

## Model Setup

The installer should detect:

- whether Ollama is installed
- whether `ollama.exe` is on PATH or in the default local install path
- available RAM/VRAM where possible
- currently installed Ollama models

Preferred behavior:

- If Ollama is missing, offer to install Ollama first.
- After Ollama is available, list recommended engines/models.
- If the current known-good model is installed, offer it first.
- If a slower/better model is viable, offer it as the quality option.
- If the machine is resource-limited, show a clearly marked fallback option that is not recommended for quality but is likely to run.
- If no model is installed, run `ollama pull <model>`.
- Write `FAYE_MODEL` or generic `BOT_MODEL` to `.env`.

The current Faye setup uses a local Ollama model, so no OpenAI quota should be required for normal replies.

Recommended model list should be generated from the target machine, but roughly:

- quality: Gemma 12B local model, if the machine can tolerate it
- balanced: current known-good local model used by Faye
- fallback: smaller model for low-resource machines, clearly marked as less coherent

Do not hide the tradeoff. The installer should say that larger models may answer much more slowly but usually produce better replies.

## Runtime Control App

Once the bot is installed, provide a small local control app/window.

Required controls:

- Bot status: running, stopped, starting, errored, kill-switch active
- Kill switch: immediately create the kill-switch file and stop all bot work
- Clear kill switch / resume: remove the kill-switch file and allow work again
- Restart bot
- Check for updates
- Show current model
- Show watched channel IDs
- Open logs folder

The kill switch should be the most obvious control in the app.

The check-for-updates control should:

- check the installed bot code/package version
- check whether the recommended model list changed
- check whether Ollama is installed and reachable
- optionally check for newer recommended Ollama models
- report what it would change before changing anything

The app should not require Discord, Ollama, or the bot to be healthy before the kill switch works. The kill switch is just a local file operation and must remain available even when everything else is broken.

## Update Source

Canonical GitHub repository:

- `https://github.com/Prettychainsaw/ProbablyFae`

The installer should live in this repository. The runtime control app should use
this repository as the default update source for bot code and installer updates.

Recommended release/update layout:

- GitHub Releases for packaged installer/runtime builds.
- A small update manifest, such as `latest.json`, for the control app to check.
- Release notes that explain bot behavior changes, migration steps, and model recommendation changes.
- A stable branch for tested releases.

The update checker should show what changed and require user approval before applying updates. It should not silently replace bot code.

The runtime control app should expose two separate update checks:

1. Bot/app updates
   - checks `Prettychainsaw/ProbablyFae`
   - looks for new installer/runtime releases
   - shows release notes and migration warnings
   - applies only after user approval

2. Chat model updates
   - checks local Ollama availability
   - lists installed local models
   - checks current recommended model list from the repo/update manifest
   - optionally checks Ollama/library availability for newer recommended models
   - offers install/pull of recommended models after user approval

These should be separate buttons or clearly separate sections. A user may want
new bot code without changing models, or a new model without changing bot code.

## Versioning And Migrations

Use explicit app/runtime versions, such as:

- `0.0.1`
- `0.0.2`
- `0.0.3`

Do not rely on "latest overwrites everything" for installed bots. Installed
bots may have local state, knowledge, personality files, pending tasks, model
choices, and user-edited config. Updates need to move that state deliberately.

Recommended approach:

- Each release includes a version number.
- Each install stores its current version in a local config file.
- The repo publishes an update manifest listing the next valid update step for each supported installed version.
- Each version may include a migration script for moving from the previous version.
- Updates apply one valid step, then check the manifest again from the newly installed version.

Example:

```text
installed: 0.0.1
latest:    0.0.4

ask manifest:
what should 0.0.1 download? -> 0.0.2

apply:
0.0.1 -> 0.0.2

ask manifest again:
what should 0.0.2 download? -> 0.0.3

apply:
0.0.2 -> 0.0.3

ask manifest again:
what should 0.0.3 download? -> 0.0.4

apply:
0.0.3 -> 0.0.4
```

The updater should not decide its own skipped path. It should repeatedly ask:
"I am version X; what is my next download?" The manifest may answer with the
next patch version, a minor-version jump, a major-version jump, or "no supported
automatic update path."

The update manifest should include enough information for the control app to
decide the path:

```json
{
  "latest": "0.0.4",
  "next": {
    "0.0.1": {
      "to": "0.0.2",
      "downloadUrl": "https://github.com/Prettychainsaw/ProbablyFae/releases/download/v0.0.2/ProbablyFae-Setup.exe",
      "migration": "migrations/0.0.1-to-0.0.2.js",
      "requiresRestart": true,
      "notes": "Adds kill switch support."
    },
    "0.0.2": {
      "to": "0.0.3",
      "downloadUrl": "https://github.com/Prettychainsaw/ProbablyFae/releases/download/v0.0.3/ProbablyFae-Setup.exe",
      "migration": "migrations/0.0.2-to-0.0.3.js",
      "requiresRestart": true,
      "notes": "Fixes idle behavior."
    },
    "0.0.3": {
      "to": "0.1.0",
      "downloadUrl": "https://github.com/Prettychainsaw/ProbablyFae/releases/download/v0.1.0/ProbablyFae-Setup.exe",
      "migration": "migrations/0.0.3-to-0.1.0.js",
      "requiresRestart": true,
      "notes": "First minor release."
    }
  }
}
```

If the installed version is too old or the migration path is missing, the
control app should stop and tell the user to install manually or ask for help.

Before applying code updates:

- set the kill switch
- stop the running bot process
- back up config, knowledge notes, personality files, state, and logs
- apply each migration in order
- restart only after the full update path succeeds

Model updates are separate. A model update may download a new Ollama model and
change the configured model, but it should not run app migrations unless the app
itself is also being updated.

## Discord Setup

The installer can create/open the OAuth invite URL, but the user must complete Discord's authorization page.

Required bot permissions:

- View Channel
- Send Messages
- Read Message History
- Add Reactions

Recommended if using role-trigger behavior:

- Mention Roles only if the server/channel setup needs it.

The installer should open the authorization URL in the browser and tell the user to approve the bot joining the selected server. It should not pretend it can click through Discord's consent page automatically.

The installer should ask the user for the initial target channel ID.

## First Address Behavior

When the bot is first addressed in Discord, it should introduce itself once.

The intro should be generated from:

- bot name
- starting personality
- room/channel context
- what the user said

Example shape:

```text
Hey. I'm <name>. I'm here for <personality-driven purpose>, and apparently to make this room less boring.
```

Do not hardcode Faye's tone into the installer. The intro must come from the selected personality.

## Scalable Idle Rules

Do not hardcode Faye-specific checks.

Generic low-chat behavior:

- After one hour of no human messages, the bot may post only if the last visible speaker was not this bot.
- If the bot itself was the last visible speaker, skip the one-hour post.
- After three hours of total room silence, the bot may ask a discussion question.

Future multi-bot option:

- Skip low-chat posts if the last speaker was this bot or a configured peer bot in the same deployment group.

## Safety

Every installed bot needs a hard kill switch.

For Faye this is:

```powershell
Set-Content -Path .\FAYE_KILL_SWITCH -Value "stopping because something is wrong"
```

For a generic installer this should become:

```powershell
Set-Content -Path .\<BOT_NAME>_KILL_SWITCH -Value "stopping because something is wrong"
```

The kill switch must:

- clear queued tasks
- clear pending replies
- stop pulse reading
- abort active model calls
- block direct replies
- block scheduled checks

## Generated Files

The installer should create:

- `.env`
- `bot.js`
- `package.json`
- `knowledge/`
- `knowledge/notes/<bot>-personality.md`
- `knowledge/notes/<bot>-notes.md`
- `knowledge/notes/<bot>-mental-state.md`
- `KILL_SWITCH.md`
- `START_BOT.ps1`
- optional `INSTALLER_SUMMARY.md`

## Open Questions

- Whether each bot gets one Discord channel by default or multiple channels.
- Whether trigger roles should be created manually or documented only.
- Whether personality self-editing is enabled by default or offered as an advanced option.
- Whether web search is enabled by default or opt-in.
