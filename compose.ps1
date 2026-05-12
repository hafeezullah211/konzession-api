# Run from konzession-api: .\compose.ps1 up -d --build
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
docker compose @args
