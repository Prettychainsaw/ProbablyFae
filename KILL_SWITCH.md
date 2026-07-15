# Faye Kill Switch

Create `FAYE_KILL_SWITCH` in this folder to stop Faye from doing work.

PowerShell:

```powershell
Set-Content -Path .\FAYE_KILL_SWITCH -Value "stopping Faye because something is wrong"
```

What it does:

- clears queued tasks
- clears pending replies
- stops pulse reading
- aborts active model calls
- blocks direct-address replies
- blocks scheduled checks

Remove the file to let Faye work again:

```powershell
Remove-Item .\FAYE_KILL_SWITCH
```

The bot checks this file every five seconds while running.
