# ProbablyFae

Experimental local Discord companion bot.

This repository currently contains the working Faye prototype and planning notes
for a future installer/runtime control app.

Current goals:

- run against a local Ollama model
- keep user-provided knowledge in a bot-owned local folder
- reply in Discord when addressed
- perform scheduled room checks
- support long-running reading/tasks
- provide a hard local kill switch
- eventually ship an installer with model selection, Discord setup, and a local control app

Do not commit `.env`, runtime logs, state files, or private knowledge/books.

## Alpha Installer

Build the small Windows bootstrap installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap\build-bootstrap.ps1
```

The generated file is:

```text
dist\ProbablyFae-Bootstrap.exe
```

The bootstrapper downloads `latest.json` from GitHub, then downloads and runs
the current installer payload from the release listed there.

Build the current bundled installer payload:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\build-installer.ps1
```

The generated file is:

```text
dist\ProbablyFae-Setup.exe
```

This is still an alpha installer. It installs the current Faye-shaped prototype,
prompts for Discord/Ollama settings, creates local shortcuts, and opens the
Discord bot invite URL if a client ID is provided.
