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
