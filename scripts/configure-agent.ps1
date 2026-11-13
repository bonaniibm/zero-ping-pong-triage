# Loads the triage pack into an Azure SRE Agent through its data plane:
#   skill  -> custom agent -> Azure Monitor as incident platform -> response plan.
# Idempotent. Works in Windows PowerShell 5.1 and PowerShell 7. Needs Azure CLI.
param(
  [string]$AgentName = 'zpp-sre-agent',
  [string]$ConnectorName = 'dataverse-triage'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
Get-Content (Join-Path $repo '.env.local') | ForEach-Object { $k, $v = $_ -split '=', 2; if ($k) { $cfg[$k] = $v } }

$arm = "https://management.azure.com/subscriptions/$($cfg.AZURE_SUBSCRIPTION_ID)/resourceGroups/$($cfg.RESOURCE_GROUP)/providers/Microsoft.App/agents/$AgentName"
$api = '2025-05-01-preview'
$endpoint = az rest --method get --url "$($arm)?api-version=$api" --query properties.agentEndpoint -o tsv
$token = az account get-access-token --resource https://azuresre.dev --subscription $cfg.AZURE_SUBSCRIPTION_ID --query accessToken -o tsv
if (-not $endpoint -or -not $token) { throw 'Could not resolve the agent endpoint or a data-plane token.' }
$headers = @{ Authorization = "Bearer $token" }

function Put-Extended([string]$Kind, [string]$Name, [string]$Type, $Properties) {
  $json = @{ name = $Name; type = $Type; tags = @(); properties = $Properties } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $null = Invoke-RestMethod -Uri "$endpoint/api/v2/extendedAgent/$Kind/$([uri]::EscapeDataString($Name))" -Method Put -Headers $headers -Body $bytes -ContentType 'application/json' -TimeoutSec 60
  Write-Host "ok  $Kind/$Name"
}

$dvTools = 'dv_environment_summary', 'dv_failed_system_jobs', 'dv_plugin_traces', 'dv_service_endpoints',
           'dv_application_users', 'dv_recent_changes', 'dv_steps_on_table' | ForEach-Object { "$($ConnectorName)_$_" }
$azTools = 'RunAzCliReadCommands', 'QueryAppInsightsUsingAppId', 'QueryLogAnalyticsByWorkspaceId', 'SearchMemory'

# 1. Skill (strip the YAML front matter; name and description travel as properties)
$skillName = 'dataverse-integration-triage'
$raw = [IO.File]::ReadAllText((Join-Path $repo "skills\$skillName\SKILL.md"))
$m = [regex]::Match($raw, '(?s)^---\s*\r?\n(.*?)\r?\n---\s*\r?\n(.*)$')
$description = [regex]::Match($m.Groups[1].Value, '(?m)^description:\s*(.+)$').Groups[1].Value.Trim()
Put-Extended 'skills' $skillName 'Skill' @{
  name = $skillName; description = $description; tools = @($azTools[0..2] + $dvTools)
  skillContent = $m.Groups[2].Value; additionalFiles = @()
}

# 2. Custom agent
$agentId = 'dataverse-integration-triage'
$instructions = @'
You triage incidents on integrations between Azure components and Dataverse (Dynamics 365).
Follow the dataverse-integration-triage skill step by step: establish the facts from Azure
telemetry, inspect the Dataverse plane with the dataverse-triage tools, line up the change
timelines of both planes, and finish with the OWNERSHIP VERDICT block exactly as the skill
defines it. Never name an owner from one plane alone. You only diagnose: do not change Azure
resources or replay messages unless a person approves.
'@
Put-Extended 'agents' $agentId 'ExtendedAgent' @{
  instructions = $instructions
  handoffDescription = 'Triages incidents on integrations between Azure and Dataverse / Dynamics 365 and names the owning team.'
  handoffs = @(); tools = @($azTools + $dvTools); agentType = 'Autonomous'; temperature = 0.2
  enableSkills = $true; allowedSkills = @($skillName)
}

# 3. Azure Monitor as the incident platform (alerts in the agent's resource groups become incidents)
$tmp = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($tmp, '{"properties":{"incidentManagementConfiguration":{"type":"AzMonitor","connectionName":"azmonitor"}}}')
az rest --method patch --url "$($arm)?api-version=$api" --body "@$tmp" --headers 'Content-Type=application/json' -o none
Remove-Item $tmp
Write-Host 'ok  incident platform = Azure Monitor (waiting 20s for it to initialise)'
Start-Sleep -Seconds 20

# 4. Response plan: every alert severity in scope goes to the triage agent
Put-Extended 'incidentFilters' 'dataverse-integration-alerts' 'IncidentFilter' @{
  incidentPlatform = 'AzMonitor'; isEnabled = $true; priorities = @('Sev0', 'Sev1', 'Sev2', 'Sev3')
  handlingAgent = $agentId; agentMode = 'Autonomous'; maxAutomatedInvestigationAttempts = 1
}

Write-Host "Portal: https://sre.azure.com/#/agent/$($cfg.AZURE_SUBSCRIPTION_ID)/$($cfg.RESOURCE_GROUP)/$AgentName"
