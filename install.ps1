# keyflip installer for Windows (PowerShell).
#   From a clone:  .\install.ps1
#   Via web:       irm https://raw.githubusercontent.com/hakkisagdic/keyflip/main/install.ps1 | iex   (public repo)
$ErrorActionPreference = 'Stop'

$Owner  = if ($env:KEYFLIP_OWNER) { $env:KEYFLIP_OWNER } else { 'hakkisagdic' }
$Repo   = if ($env:KEYFLIP_REPO)  { $env:KEYFLIP_REPO }  else { 'keyflip' }
$GitUrl = "https://github.com/$Owner/$Repo.git"

function Need($cmd) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is required. Please install it and re-run." } }
Need node
Need npm

# Locate a local checkout (script dir) vs. running piped from the web.
$selfDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json'))) { $selfDir = $PSScriptRoot }

if ($selfDir) {
  Write-Host "Installing keyflip from $selfDir ..."
  Push-Location $selfDir
  try { npm install --global . } finally { Pop-Location }
} else {
  Write-Host "Installing keyflip globally via npm ..."
  npm install --global "git+$GitUrl"
}

$ccs = (Get-Command keyflip -ErrorAction SilentlyContinue)
if ($ccs) { Write-Host "  * CLI -> $($ccs.Source)" }

# Create a Start Menu + Desktop shortcut that opens the menu in a console.
try {
  $ws = New-Object -ComObject WScript.Shell
  $targets = @(
    [IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Keyflip.lnk'),
    [IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Keyflip.lnk')
  )
  foreach ($lnkPath in $targets) {
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = "$env:SystemRoot\System32\cmd.exe"
    $lnk.Arguments  = '/k keyflip menu'
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,44"
    $lnk.Description = 'Switch between Claude Code accounts'
    $lnk.Save()
  }
  Write-Host "  * Shortcut -> Start Menu & Desktop: 'Keyflip'"
} catch {
  Write-Host "  (could not create shortcut: $($_.Exception.Message))"
}

Write-Host ""
Write-Host "Installed."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1) In Claude, log in to your first account, then run:   keyflip add"
Write-Host "  2) Claude /login to your other account, then run:        keyflip add"
Write-Host "  3) Switch anytime: run 'keyflip' or open the 'Keyflip' shortcut."
Write-Host ""
Write-Host "Open a new terminal so the 'keyflip' command is on your PATH."
