# Lists the agent's chat threads, or exports one thread as a readable Markdown transcript.
#   ./scripts/export-thread.ps1                      -> list threads
#   ./scripts/export-thread.ps1 -ThreadId <id> -Out docs/runs/x.md
param([string]$AgentName = 'zpp-sre-agent', [string]$ThreadId, [string]$Out)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
Get-Content (Join-Path $repo '.env.local') | ForEach-Object { $k, $v = $_ -split '=', 2; if ($k) { $cfg[$k] = $v } }
$arm = "https://management.azure.com/subscriptions/$($cfg.AZURE_SUBSCRIPTION_ID)/resourceGroups/$($cfg.RESOURCE_GROUP)/providers/Microsoft.App/agents/$AgentName"
$endpoint = az rest --method get --url "$($arm)?api-version=2025-05-01-preview" --query properties.agentEndpoint -o tsv
$token = az account get-access-token --resource https://azuresre.dev --subscription $cfg.AZURE_SUBSCRIPTION_ID --query accessToken -o tsv
$headers = @{ Authorization = "Bearer $token" }

function Get-Json([string]$path) {
  $r = Invoke-WebRequest -Uri "$endpoint/$path" -Headers $headers -UseBasicParsing -TimeoutSec 60
  [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json
}

if (-not $ThreadId) {
  (Get-Json 'api/v1/threads').value | Sort-Object { $_.startMessage.timeStamp } | ForEach-Object {
    '{0}  {1}  {2}' -f $_.id, ([datetime]$_.startMessage.timeStamp).ToUniversalTime().ToString('MM-dd HH:mm'), $_.title
  }
  return
}

$messages = (Get-Json "api/v1/threads/$ThreadId/messages").value
$start = ([datetime]$messages[0].timeStamp).ToUniversalTime()
$lines = New-Object System.Collections.Generic.List[string]
foreach ($m in $messages) {
  $text = "$($m.text)".Trim()
  if (-not $text -or $m.messageType -in 'Reasoning', 'TrajectoryInsight') { continue }
  $offset = [int](([datetime]$m.timeStamp).ToUniversalTime() - $start).TotalSeconds
  $who = if ($m.author.role -eq 'User') { 'Request' } else { 'Agent' }
  if ($text -match '^(MCP Tool|Memory Search)') { $lines.Add("- ``+${offset}s`` $text") }
  else { $lines.Add(''); $lines.Add("**$who** (+${offset}s)"); $lines.Add(''); $lines.Add($text); $lines.Add('') }
}
$md = ($lines -join "`n")
if ($Out) { [IO.File]::WriteAllText((Join-Path $repo $Out), $md, (New-Object Text.UTF8Encoding $false)); Write-Host "wrote $Out" } else { $md }
