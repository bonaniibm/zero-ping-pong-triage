
**Agent** (+0s)

```incident-alert
{"alertId":"a269df73-fc30-446c-b753-347f2c53f000","alertRule":"zpp-erp-contacts-dead-letter","description":"Dataverse integration: messages are dead-lettering on the erp-contacts queue (ERP to Dataverse contact sync).","monitoredResource":"zpp-sb-mktn5z7pjty4o","severity":"Sev2","monitorCondition":"Fired","monitorService":"Platform","firedAt":"11/14/2026 04:34:26 \u002B00:00","subscription":"<subscription-id>","resourceGroup":"rg-zero-ping-pong","portalUrl":"https://ms.portal.azure.com/#view/Microsoft_Azure_Monitoring_Alerts/AlertDetails.ReactView/alertId~/%2Fsubscriptions%2F<subscription-id>%2Fresourcegroups%2Frg-zero-ping-pong%2Fproviders%2Fmicrosoft.servicebus%2Fnamespaces%2Fzpp-sb-mktn5z7pjty4o%2Fproviders%2FMicrosoft.AlertsManagement%2Falerts%2Fa269df73-fc30-446c-b753-347f2c53f000/invokedFrom/CopyLinkFeature"}
```


**Agent** (+0s)

Alert received ✅

Initiating investigation to assess the situation and identify potential causes 🛠️


**Agent** (+8s)

I’ll check queue counts and Azure caller logs, compare Azure and Dataverse changes around the first failure, then report an evidence-based owner. I’ll use read-only checks; no replay or resource change is planned, so no rollback is needed.


**Agent** (+12s)

I’m checking queue depth, the telemetry workspace, and resource-group changes around the alert, alongside any prior integration guidance.

- `+13s` Memory Search: Found 0 relevant results

**Agent** (+27s)

The queue has four dead-lettered messages, and the activity log shows key *reads*, not rotations. I’m checking caller failures to identify the first error and its Dataverse response.

- `+30s` MCP Tool: Dv Environment Summary (Completed)

**Agent** (+35s)

The Dataverse environment has plug-in tracing enabled. I’m querying the contact-sync traces and exceptions next so the investigation can follow the actual failing request.


**Agent** (+39s)

The telemetry source has data in the window. I’m narrowing it to contact-sync failures and request IDs; the broad trace sample included unrelated Service Bus receiver activity.


**Agent** (+42s)

The first failed contact-sync executions began at 04:30 UTC; four contacts received Dataverse HTTP 400 responses and exhausted three deliveries each. I’m matching those request IDs to plug-in traces and checking the contact steps.

- `+44s` MCP Tool: Dv Plugin Traces (Completed)
- `+44s` MCP Tool: Dv Plugin Traces (Completed)
- `+46s` MCP Tool: Dv Steps On Table (Completed)

**Agent** (+48s)

The failing request ID matches a `ContactEnrichmentPlugin` exception in Dataverse, and its Create step was modified seconds before the failures. I’m checking the Dataverse change record to confirm what changed and who made it.

- `+48s` MCP Tool: Dv Recent Changes (Completed)

**Agent** (+56s)

The Dataverse change record confirms the Create step was modified by Bonani Paul Chaudhury at 04:30:13 UTC, just before the failures. I’m verifying the current queue impact and checking whether this agent can post the finding to the incident.


**Agent** (+56s)

Read file: config/tools.json


**Agent** (+56s)

Read file: config/README.md


**Agent** (+62s)

Four messages remain in the dead-letter queue. The grouped verification query failed, so I’m using a simpler count check; I also found no incident-posting capability in the available tools, so I can’t verify delivery to the incident.


**Agent** (+72s)

Incident update **not posted**: no incident-posting capability is available in this session. This chat response is not an incident update. No messages were replayed and no resources were changed.

OWNERSHIP VERDICT  
Owner:        CRM development team  
Plane:        Dataverse  
Confidence:   High - caller request IDs match exceptions in a contact plug-in step modified immediately before the failures.

What broke:   `Zpp.Plugins.ContactEnrichmentPlugin` throws a null-reference error during contact creation.  
Started:      November 14, 2026, 04:30 UTC  
Impact:       ERP-to-Dataverse contact sync; four records remain dead-lettered after three delivery attempts each. Whether new records are still failing is unverified.

Evidence - Azure:
- Contact sync succeeded at 04:29:32 UTC, then logged Dataverse HTTP 400 failures at 04:30:21 UTC, including request ID `8ae7dd24-2ead-4a90-b147-582cf797d956`. The `erp-contacts` queue has four dead-lettered messages.
Evidence - Dataverse:
- `dv_plugin_traces` matched that request ID to a null-reference exception in the synchronous Create step `8c4988a4-6ddf-f111-84e9-000d3a36761f`.
- `dv_recent_changes` shows that step was modified and enabled at 04:30:13 UTC by Bonani Paul Chaudhury.
Trigger:      The Create step modification at 04:30:13 UTC is the leading trigger; the precise code defect is not visible in the trace.

Next action:  CRM development team should inspect and fix or roll back that Create step before coordinating any dead-letter replay.  
Not the cause: Azure activity showed Service Bus key reads, not a key rotation; the failing calls reached Dataverse.
