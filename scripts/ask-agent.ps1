# Hands a problem report to the triage agent through an HTTP trigger and prints the thread id.
# This is the route a "Ask SRE Agent" button in Dynamics 365 would take (through a small relay
# that holds an Azure identity). Creates the trigger on first use.
#   ./scripts/ask-agent.ps1 -Message "Contacts from the ERP stopped appearing in Dynamics 365 around 09:10 UTC"
param(
  [Parameter(Mandatory)][string]$Message,
  [string]$ReportedBy = 'CRM support desk',
  [string]$AgentName = 'zpp-sre-agent',
  [string]$HandlingAgent = 'dataverse-integration-triage',
  [string]$Prompt = 'A person has reported a problem with an integration between Azure and Dataverse (Dynamics 365). The report is in the JSON payload. Follow the dataverse-integration-triage skill and finish with the OWNERSHIP VERDICT.'
)
$TriggerName = "ask-$HandlingAgent"
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
Get-Content (Join-Path $repo '.env.local') | ForEach-Object { $k, $v = $_ -split '=', 2; if ($k) { $cfg[$k] = $v } }
$arm = "https://management.azure.com/subscriptions/$($cfg.AZURE_SUBSCRIPTION_ID)/resourceGroups/$($cfg.RESOURCE_GROUP)/providers/Microsoft.App/agents/$AgentName"
$endpoint = az rest --method get --url "$($arm)?api-version=2025-05-01-preview" --query properties.agentEndpoint -o tsv
$token = az account get-access-token --resource https://azuresre.dev --subscription $cfg.AZURE_SUBSCRIPTION_ID --query accessToken -o tsv
$headers = @{ Authorization = "Bearer $token" }

$existing = Invoke-RestMethod -Uri "$endpoint/api/v1/httpTriggers" -Headers $headers -TimeoutSec 60
$list = if ($existing.value) { $existing.value } else { $existing }
$trigger = $list | Where-Object { $_.name -eq $TriggerName } | Select-Object -First 1
if (-not $trigger) {
  $spec = @{
    name          = $TriggerName
    description   = 'A person reports a Dynamics 365 integration problem and asks who needs to act.'
    prompt        = $Prompt
    handlingAgent = $HandlingAgent
    agentMode     = 'autonomous'
  } | ConvertTo-Json -Compress
  $trigger = Invoke-RestMethod -Uri "$endpoint/api/v1/httptriggers/create" -Method Post -Headers $headers -Body $spec -ContentType 'application/json' -TimeoutSec 60
  Write-Host "created trigger $TriggerName"
}
$id = if ($trigger.id) { $trigger.id } else { $trigger.triggerId }
$payload = @{ report = $Message; reportedBy = $ReportedBy; reportedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } | ConvertTo-Json -Compress
$run = Invoke-RestMethod -Uri "$endpoint/api/v1/httptriggers/trigger/$id" -Method Post -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -ContentType 'application/json' -TimeoutSec 60
Write-Host "thread: $($run.threadId)"
$run.threadId
