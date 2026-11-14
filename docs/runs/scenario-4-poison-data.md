
**Agent** (+0s)

[HTTP_TRIGGER_EXECUTION]{"taskId":"f564ec15-88d8-4ce4-b364-aff08db8562d","taskName":"ask-dataverse-integration-triage","description":"A person reports a Dynamics 365 integration problem and asks who needs to act.","agentPrompt":"\n\n[HTTP_TRIGGER_PAYLOAD]{\u0022reportedAtUtc\u0022:\u00222026-11-14T05:06:26Z\u0022,\u0022reportedBy\u0022:\u0022CRM support desk\u0022,\u0022report\u0022:\u0022Some contacts sent from the ERP since about 05:05 UTC today are not appearing in Dynamics 365, while others sent around the same time arrived fine. Please find out what is wrong and who needs to act.\u0022}[/HTTP_TRIGGER_PAYLOAD]","agent":null,"executionTime":"2026-11-14T05:06:28.8331621Z","executionId":"c0898bd0-eaf6-46c6-85ee-ab98d5b12b05","status":"Active","threadMode":"NewThread","modelTier":null,"agentInstructions":"\u003Csystem_notice\u003EThis is an AUTOMATED http trigger execution triggered by infrastructure. Do NOT autonomously attempt to schedule future runs, set up monitoring loops, or create wait states - the infrastructure handles recurring executions automatically. Simply execute the agentPrompt and complete your response. However, if the user explicitly requests additional actions, you may fulfill those requests.\u003C/system_notice\u003E"}[/HTTP_TRIGGER_EXECUTION]


**Agent** (+4s)

I’ll trace the ERP-to-Dynamics path around 05:05 UTC, compare successful and missing contacts, and check both Azure and Dataverse for correlated failures. This is read-only; I won’t change or replay records. I’ll verify the owning side before recommending action.


**Agent** (+11s)

Tool Search: "app.?insights.*query|monitor.*resource.*log.*query|PerformDgrepSearch" (0 tools)

- `+12s` MCP Tool: Dv Environment Summary (Completed)
- `+12s` Memory Search: Found 1 relevant results
- `+16s` MCP Tool: Dv Plugin Traces (Completed)
- `+16s` MCP Tool: Dv Failed System Jobs (Completed)
- `+17s` MCP Tool: Dv Steps On Table (Completed)
- `+18s` MCP Tool: Monitor Activitylog List (Completed)

**Agent** (+41s)

The Azure trace now points to a record-specific failure: three contacts reference the same parent account, and all three messages are dead-lettered after retries. Other contacts succeeded just before the failures. I’m checking Dataverse changes and the exact failure path before assigning ownership.

- `+42s` MCP Tool: Dv Plugin Traces (Completed)
- `+42s` MCP Tool: Dv Recent Changes (Completed)

**Agent** (+45s)

Tool Search: "dataverse.*(query|record|account)|servicebus.*(peek|dead.?letter)" (0 tools)


**Agent** (+77s)

**OWNERSHIP VERDICT**  
Owner:        ERP business/data owners  
Plane:        Data  
Confidence:   High — all three failed contacts reference the same account that the sync could not find; other contacts succeeded.

What broke:   The ERP contact sync rejected contacts referencing parent account `ERP-ACC-20261114050457` because it could not find that account in Dataverse.  
Started:      November 14, 2026, 05:05:04 UTC  
Impact:       Three contacts failed across nine attempts and are in the `erp-contacts` dead-letter queue. Two earlier contacts synced successfully.

Evidence - Azure:
- `ContactSyncFailed` traces identify the three contact IDs and the missing-parent error; the queue shows three dead-lettered messages and no active backlog.
Evidence - Dataverse:
- Plug-in tracing is enabled, but the Dataverse checks found no recent plug-in exceptions or failed system jobs. The contact-enrichment steps are disabled.
Trigger:      The contacts arrived with an unresolved parent-account reference. Why that account is missing was not established; no Azure write was found near the failure.

Next action:  ERP data owners should verify the intended parent account, create or correct it if appropriate, then coordinate a **controlled replay** of the three dead-lettered contacts. No records were changed or replayed.  
Not the cause: A blanket sync outage is unlikely because other contacts succeeded; the checks found no implicated plug-in failure or Azure configuration write at onset.
