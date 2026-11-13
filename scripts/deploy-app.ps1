# Packages src/app and deploys it to the Function app named in .env.local.
# Works in Windows PowerShell 5.1 and PowerShell 7. Needs Azure CLI and Node.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
Get-Content (Join-Path $repo '.env.local') | ForEach-Object { $k, $v = $_ -split '=', 2; if ($k) { $cfg[$k] = $v } }

$app = Join-Path $repo 'src\app'
Push-Location $app
npm install --omit=dev --no-audit --no-fund | Out-Null
Pop-Location

$zip = Join-Path $env:TEMP 'zpp-app.zip'
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$app\host.json", "$app\package.json", "$app\src", "$app\node_modules" -DestinationPath $zip

az functionapp deployment source config-zip --subscription $cfg.AZURE_SUBSCRIPTION_ID -g $cfg.RESOURCE_GROUP -n $cfg.FUNCTION_APP --src $zip --query "{complete:complete}" -o json
Remove-Item $zip
