# Zero Ping-Pong Triage

**A Dataverse triage pack for Azure SRE Agent.** It gives the agent read-only eyes on the Dataverse side of a
Dynamics 365 integration, plus a triage procedure, so every integration incident ends with one thing:
an **ownership verdict** — which plane broke, which component, the evidence from both sides, and who acts next.

> Status: proof of concept. Built and tested against one Developer environment. Not a supported product.

## Why

Azure SRE Agent sees Azure telemetry natively. It cannot see Dataverse. Integration incidents sit on the seam
between the two: the symptom shows up in Azure (a dead-letter queue grows, a Function fails, or traffic
silently drops to zero) while the cause is often in Dataverse (a plug-in regression, a disabled application
user, a service endpoint holding a stale key). The ticket then bounces between the Azure team and the CRM team.

## What is in the box

| Part | Path | What it is |
|---|---|---|
| Dataverse triage MCP server | `src/app/src/mcp` | Seven read-only tools over the Dataverse Web API, served over Streamable HTTP from an Azure Function (also runs over stdio) |
| Triage skill | `skills/dataverse-integration-triage/SKILL.md` | The procedure: facts from Azure, evidence from Dataverse, line up both change timelines, name one owner |
| Custom agent | `agent/dataverse-integration-triage.yaml` | A specialist the response plan routes integration alerts to |
| Plugin manifest | `plugin.json`, `.mcp.json` | Lets Azure SRE Agent install the skill from this repo URL |
| Sample integration | `src/app/src/functions` | ERP → Service Bus → Function → Dataverse contact, and Dataverse account → service endpoint → Service Bus → Function |
| Chaos kit | `scripts/chaos.mjs` | Injects known failures, and puts them back |
| Infrastructure | `infra/*.bicep` | The sample integration, and the SRE Agent with its connectors |

### The tools

| Tool | Answers |
|---|---|
| `dv_environment_summary` | Which environment am I looking at, and is plug-in tracing on? |
| `dv_failed_system_jobs` | Which outbound posts, webhooks and async plug-ins failed or are stuck retrying? |
| `dv_plugin_traces` | Which plug-in threw, with what exception, for which request? |
| `dv_service_endpoints` | Where does Dataverse post to, with which key name, and is it getting through? |
| `dv_application_users` | Is the caller's application user enabled, and which roles does it hold? |
| `dv_recent_changes` | What changed in Dataverse, and when? (solutions, assemblies, steps, endpoints, app users) |
| `dv_steps_on_table` | What custom logic runs when something writes to this table? |

All tools issue GET requests only. Key values and secrets are never returned.

## Failure scenarios in the chaos kit

| Command | What it breaks | What Azure shows | Where the cause is |
|---|---|---|---|
| `rotate-key` | Regenerates the Service Bus key that the Dataverse service endpoint uses | Nothing. Events just stop arriving | Dataverse system jobs retrying with `401 InvalidSignature` |
| `break-plugin` | Enables a plug-in step that throws on integration writes | Function failures, dead-lettered messages | Plug-in trace log, and the step change minutes earlier |
| `disable-user` | Disables the integration's application user | Function failures, dead-lettered messages | Application user state in Dataverse |
| `poison` | Sends contacts that reference an account Dataverse does not have | The same messages dead-letter | The data itself; no engineering defect |

Undo with `fix-key`, `fix-plugin`, `enable-user`, and clear the queue with `drain-dlq`.

## Set it up

You need an Azure subscription where you are Owner, a Dataverse environment where you are System Administrator,
Azure CLI, Power Platform CLI, Node 20+ and the .NET SDK.

1. **Two app registrations** in the tenant of the Dataverse environment: one for the sample integration, one for
   triage. Add both as application users. The demo uses the standard roles `Service Writer` + `Service Reader`
   for the integration and `Service Reader` for triage.
2. Copy `.env.example` to `.env.local` and fill it in. Add `MCP_API_KEY` with a long random value.
3. Deploy the sample integration and the MCP server:
   ```bash
   az deployment group create -g <rg> --template-file infra/main.bicep --parameters dataverseUrl=... dataverseTenantId=... integrationClientId=... integrationClientSecret=... triageClientId=... triageClientSecret=... mcpApiKey=...
   ```
   ```powershell
   ./scripts/deploy-app.ps1
   ```
4. Build the demo plug-in and prepare Dataverse (trace logging, service endpoint, plug-in steps):
   ```bash
   dotnet build dataverse/plugin -c Release
   ```
   ```bash
   node scripts/setup-dataverse.mjs
   ```
5. Create the agent and load the pack:
   ```bash
   az deployment group create -g <rg> --template-file infra/sre-agent.bicep --parameters integrationAppInsightsName=... logAnalyticsName=... mcpUrl=... mcpApiKey=...
   ```
   ```powershell
   ./scripts/configure-agent.ps1
   ```

If the Dataverse environment lives in a different tenant from the Azure subscription, sign the Azure CLI in to
that tenant in a second profile and point `ZPP_DATAVERSE_AZ_CONFIG_DIR` at it.

### Already have an agent?

In the SRE Agent portal go to **Build + setup → Extensions → Plugins → Install GitHub plugin**, enter this
repository, then add the `dataverse-triage` connector with your MCP URL and bearer key.

## Cost and safety notes

- Azure SRE Agent bills a fixed always-on charge for as long as the agent exists, plus usage. Delete the agent
  when you are done. New customers get the always-on charge waived for 30 days.
- The Log Analytics workspace has a daily cap of 0.2 GB.
- The agent is created with read-only access to one resource group. The Dataverse tools cannot write.
- The demo plug-in contains a deliberate bug. Do not register it anywhere that matters.

## Limits

- The server authenticates with a client secret so that it also works across tenants. In a single tenant, use a
  managed identity instead.
- Plug-in trace logging must be on for `dv_plugin_traces` to return anything.
- Successful system jobs are often auto-deleted by Dataverse, so success counts are a lower bound.
- Throttling (429) and expired-secret scenarios are described in the skill but not in the chaos kit yet.

## License

MIT
