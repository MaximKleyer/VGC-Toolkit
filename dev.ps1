# Start the three dev servers, each in its own PowerShell window (Windows).
#   backend  : FastAPI on http://127.0.0.1:8000  (python -m uvicorn ... --reload)
#   sidecar  : Showdown simulator on http://127.0.0.1:8001  (node sim/server.mjs)
#   frontend : Vite dev server on http://localhost:5173  (proxies /api and /sim)
# Run from the project root after .\setup.ps1:  .\dev.ps1
$root = $PSScriptRoot
if (-not (Test-Path "$root\.venv\Scripts\python.exe")) { Write-Error "No .venv found. Run .\setup.ps1 first."; exit 1 }

function Start-Window($title, $command) {
  Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "`$host.UI.RawUI.WindowTitle = '$title'; Set-Location '$root'; $command"
}

Start-Window "vgc backend :8000"  ".\.venv\Scripts\python.exe -m uvicorn vgc_toolkit.main:app --reload"
Start-Window "vgc sidecar :8001"  "Set-Location sim; npm start"
Start-Window "vgc frontend :5173" "Set-Location frontend; npm run dev"

Write-Host "Started backend (8000), sidecar (8001) and frontend (5173). Open http://localhost:5173" -ForegroundColor Green
Write-Host "Close the three windows (or Ctrl+C in each) to stop."
