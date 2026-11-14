
**Request** (+0s)

@dataverse-integration-triage: Sales operations report that accounts created in Dynamics 365 since about 14:53 UTC today are not reaching the ERP. Accounts created before that arrived fine. Nobody has seen an error. Find out what is wrong and who needs to act.


**Agent** (+2s)

I’ll trace the account delivery path from Azure telemetry, check Dataverse’s outbound jobs and endpoints, then compare changes around 14:53 UTC before assigning ownership.


**Agent** (+9s)

The reported start is roughly one minute ago, so I’m checking the live Service Bus path and resource-group changes without treating the lack of Azure errors as proof of health.

- `+11s` Memory Search: Found 0 relevant results

**Agent** (+31s)

The resource group contains Service Bus and an ERP-facing Function. The activity results so far show agent setup but no Service Bus change, so I’m narrowing the Azure check to queue activity and integration logs.


**Agent** (+46s)

The Service Bus authorization rule `dataverse-send` had keys regenerated at 14:27 and 14:31 UTC. I’m checking whether arrivals fell afterward and whether the ERP Function received anything, before comparing that lead with Dataverse failures.


**Agent** (+61s)

Azure shows intermittent arrivals on `dataverse-events`, including two at 14:54 UTC, so the key rotation alone does not explain a complete stop. I’m checking Dataverse’s account-specific endpoint and job failures to isolate the affected flow.

- `+64s` MCP Tool: Dv Environment Summary (Completed)
- `+67s` MCP Tool: Dv Failed System Jobs (Completed)
- `+67s` MCP Tool: Dv Service Endpoints (Completed)

**Agent** (+70s)

Dataverse now shows three account-create delivery jobs failing at 14:53:49–14:53:51 UTC with Service Bus `401 InvalidSignature`; the same step last succeeded at 14:53:18. I’m checking the Dataverse change timeline and the authorization rule to confirm what invalidated its token.

- `+70s` MCP Tool: Dv Recent Changes (Completed)

**Agent** (+78s)

The Dataverse endpoint was edited at 14:34:45, after both Service Bus key regenerations, yet it later reports `InvalidSignature` for account creates. I’m making one last scoped Azure check to distinguish this from a downstream Function or ERP failure.


**Agent** (+85s)

The Function processed two account events at 14:53:27, just before Dataverse’s first failed send at 14:53:49. That places the break upstream of the Function; I’m checking whether retries or later account deliveries have recovered before reporting impact and ownership.

- `+85s` MCP Tool: Dv Failed System Jobs (Completed)

**Agent** (+95s)

OWNERSHIP VERDICT  
Owner:        Azure integration team  
Plane:        Azure  
Confidence:   High - Dataverse’s account-delivery jobs receive `401 InvalidSignature` after the Service Bus send keys were regenerated.

What broke:   Dataverse can no longer authenticate when posting new account events to Service Bus.  
Started:      November 13, 2026, 14:53:49 UTC  
Impact:       Three account-create jobs were waiting to retry at 14:56 UTC; recovery was not confirmed.

Evidence - Azure:
- The `dataverse-send` authorization-rule keys were regenerated at 14:27:02 and 14:31:00 UTC. The Function successfully processed two earlier account events at 14:53:27.
Evidence - Dataverse:
- `dv_service_endpoints` shows the account-create step uses `dataverse-send`, last succeeded at 14:53:18, then failed at 14:53:49.
- `dv_failed_system_jobs` shows three retries blocked by `401 InvalidSignature`; `dv_recent_changes` shows the endpoint was edited at 14:34:45.
Trigger:      Service Bus key regeneration by <azure-admin> at 14:27 and 14:31 UTC; the precise reason the subsequent endpoint edit did not prevent failure is unconfirmed.

Next action:  Azure integration team should coordinate with the CRM admin to set the Dataverse endpoint to the current `dataverse-send` credential, then verify retries and ERP delivery. Do not replay messages before confirming their retry state.  
Not the cause: A downstream Function failure—the last confirmed account events were processed successfully before Dataverse began rejecting sends.
