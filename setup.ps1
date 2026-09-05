# One-time setup on a fresh machine (Windows PowerShell).
#   Prerequisites: Git, Python 3.12+ (https://python.org), Node.js LTS (https://nodejs.org).
#   Run from the project root:  .\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== Python virtualenv + backend dependencies" -ForegroundColor Cyan
if (-not (Test-Path ".venv")) { py -3 -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt

Write-Host "== Frontend (Vite + React) dependencies" -ForegroundColor Cyan
Push-Location frontend
npm install
Pop-Location

Write-Host "== Showdown simulator sidecar dependencies (pokemon-showdown, ~180 MB)" -ForegroundColor Cyan
Push-Location sim
npm install
Pop-Location

Write-Host "== Backend tests" -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m pytest -q tests

Write-Host "`nDone. Start everything with .\dev.ps1 and open http://localhost:5173" -ForegroundColor Green
