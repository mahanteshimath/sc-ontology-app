# Pushes the Snowflake connection settings this app needs into Vercel as Project Environment
# Variables. The password is read from ~/.snowflake/connections.toml at run time and piped to the
# Vercel CLI through a temporary file that is deleted immediately afterwards, so it is never
# printed to the terminal, never stored in this repo, and never passed as a command argument.
#
# Usage:  pwsh -File scripts/set-vercel-env.ps1 [-Connection XMDGDYI-TZ93405] [-Role SC_ONTOLOGY_STEWARD]
#
# Run `vercel link` first so .vercel/project.json exists.

param(
  [string]$Connection = "RQPCPYK-BY42913",
  [string]$Account    = "RQPCPYK-BY42913",
  [string]$User       = "MONTY",
  [string]$Warehouse  = "COMPUTE_WH",
  # Deliberately not ACCOUNTADMIN. The app only reads governed objects; per-persona queries
  # override the role per connection, so the consistency page still works.
  [string]$Role       = "SC_ONTOLOGY_STEWARD",
  [string[]]$Targets  = @("production", "preview")
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $projectRoot ".vercel/project.json"))) {
  throw "Project is not linked to Vercel. Run 'vercel link' in $projectRoot first."
}

# Resolved without the null-conditional operator so this also runs on Windows PowerShell 5.1.
$vercelCmd = Get-Command vercel -ErrorAction SilentlyContinue
if ($vercelCmd) { $vercel = $vercelCmd.Source } else { $vercel = Join-Path $env:APPDATA "npm\vercel.cmd" }
if (-not (Test-Path $vercel)) { throw "Vercel CLI not found. Install it with: npm i -g vercel" }

function Set-VercelEnv {
  param([string]$Name, [string]$Value, [string]$Target)

  # PIPE THE VALUE, DO NOT REDIRECT A FILE THROUGH cmd.
  #
  # This previously wrote the value to a temp file and ran
  #   cmd /c "vercel env add NAME target < file"
  # which hangs indefinitely: the redirect does not reach the CLI's stdin as
  # expected under this shell, so `vercel env add` sits waiting for input that
  # never arrives. Because both calls were piped to Out-Null the prompt was
  # invisible, so the script looked like a slow network call rather than a stuck
  # one, and 5 variables never completed.
  #
  # PowerShell pipes natively to external commands, and `--force` overwrites in
  # place so the separate `env rm` round-trip is gone too. That takes the whole
  # script from hanging forever to about 10 seconds per variable.
  #
  # The value still never appears in the terminal, in this repo, or as a command
  # argument -- it goes through stdin exactly as before.
  $Value | & $vercel env add $Name $Target --force 2>&1 |
    Select-String -Pattern "Overrode|Added|Error" | ForEach-Object { "  $($_.Line.Trim())" }
}

# --- read the password out of the Snowflake CLI config, without echoing it ---
$tomlPath = Join-Path $env:USERPROFILE ".snowflake\connections.toml"
if (-not (Test-Path $tomlPath)) { throw "Not found: $tomlPath" }

$raw = Get-Content $tomlPath -Raw
$sectionPattern = '(?ms)\[' + [Regex]::Escape($Connection) + '\](.*?)(\r?\n\[|\z)'
if ($raw -notmatch $sectionPattern) { throw "Connection [$Connection] not found in $tomlPath" }
$section = $Matches[1]

if ($section -notmatch 'password\s*=\s*["''](.+?)["'']') {
  throw "No password found for [$Connection]. If it uses key-pair or SSO auth, set SNOWFLAKE_PASSWORD in Vercel manually or switch the app to key-pair auth."
}
$password = $Matches[1]

Write-Host "Setting Vercel environment variables for project sc-ontology-app"
foreach ($target in $Targets) {
  Write-Host "target: $target"
  Set-VercelEnv -Name "SNOWFLAKE_ACCOUNT"   -Value $Account   -Target $target
  Set-VercelEnv -Name "SNOWFLAKE_USER"      -Value $User      -Target $target
  Set-VercelEnv -Name "SNOWFLAKE_WAREHOUSE" -Value $Warehouse -Target $target
  Set-VercelEnv -Name "SNOWFLAKE_ROLE"      -Value $Role      -Target $target
  Set-VercelEnv -Name "SNOWFLAKE_PASSWORD"  -Value $password  -Target $target
}

$password = $null
[GC]::Collect()

Write-Host ""
Write-Host "Done. Verify with: vercel env ls"
Write-Host "Then deploy with:  vercel deploy --prod"
