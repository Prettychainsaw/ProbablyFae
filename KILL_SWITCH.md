# Bot Kill Switch

Create `<BOT_SLUG>_KILL_SWITCH` in this folder to stop the bot from doing work.
For a bot named `Faye`, the default file is `FAYE_KILL_SWITCH`.

PowerShell:

```powershell
$slug = "YOUR_BOT_SLUG"
Set-Content -LiteralPath ".\$($slug.ToUpper())_KILL_SWITCH" -Value "stopping because something is wrong"
```

What it does:

- clears queued tasks
- clears pending replies
- stops pulse reading
- aborts active model calls
- blocks direct-address replies
- blocks scheduled checks

Remove the file to let the bot work again:

```powershell
$slug = "YOUR_BOT_SLUG"
Remove-Item -LiteralPath ".\$($slug.ToUpper())_KILL_SWITCH"
```

The bot checks this file every five seconds while running.
