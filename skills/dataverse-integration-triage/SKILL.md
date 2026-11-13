---
name: dataverse-integration-triage
description: Use for any incident, alert or question about an integration between Azure components (Functions, Service Bus, Logic Apps, API Management) and Dataverse / Dynamics 365 - dead-lettered messages, failed sync, 400/401/403/429 from Dataverse, or Dataverse events that stopped arriving in Azure. Decides which side owns the fault and who must act.
---

# Dataverse integration triage

An integration incident has two planes. Azure telemetry shows you the symptom. The cause is often on the
Dataverse side, where Azure tools cannot see. Your job is to end the ping-pong between the Azure team and
the CRM team: look at both planes, then name one owner with evidence.

Never name an owner from one plane alone. Never stop at "Dataverse returned an error".

## Step 1 - Fix the facts from Azure

Use the built-in Azure tools (Application Insights, Log Analytics, Service Bus metrics, activity log).

1. Which flow is affected, and in which direction?
   - **Inbound** (Azure writes to Dataverse): look for failed Function executions and dead-lettered messages.
   - **Outbound** (Dataverse posts to Azure): look for a drop in received messages. Silence is a symptom.
     No error in Azure does not mean healthy.
2. When did it start? Get the first failure time to the minute. Everything later is compared against it.
3. What exactly did Dataverse answer? Pull the HTTP status, the error text and the Dataverse request id
   from the caller's logs. In the sample integration these are in the `ContactSyncFailed` trace lines
   (`httpStatus`, `dataverseRequestId`, `category`, `message`).
4. What changed in Azure near the start time? Check the activity log for the resource group: deployments,
   app setting changes, **Service Bus key regeneration** ("Regenerate Keys" on an authorization rule).

## Step 2 - Look at the Dataverse plane

Call `dv_environment_summary` first. If plug-in trace logging is Off, say so; absence of traces then proves nothing.

Pick tools by what Azure showed:

| Azure shows | Call | You are looking for |
|---|---|---|
| Caller gets 400/500, text mentions ISV code, plug-in or business process error | `dv_plugin_traces` (filter by entity or request id), then `dv_steps_on_table` | The plug-in class, the exception, and whether the step is new or was just enabled |
| Caller gets 401/403, or "user is disabled", "missing privilege" | `dv_application_users` with the caller's client id | Disabled application user, missing role, recent modification |
| Token request itself fails (AADSTS errors) before reaching Dataverse | none needed | This is identity: expired secret or wrong tenant. Dataverse is not involved |
| Events from Dataverse stopped arriving, Azure shows no errors | `dv_service_endpoints`, then `dv_failed_system_jobs` | Jobs failing or waiting to retry, the error text (for example 401 InvalidSignature), time of the last success |
| Only some messages fail, the same ones repeatedly | `dv_plugin_traces` to rule plug-ins out | If Dataverse logic is clean, it is a data problem in the message itself |
| Anything that started suddenly | `dv_recent_changes` | A Dataverse change within minutes of the first failure |

Always finish with `dv_recent_changes`. Line up three timestamps: first failure, the closest Azure change,
the closest Dataverse change. The change nearest before the first failure is your lead suspect.

## Step 3 - Decide the owner

| Finding | Owner | Typical next action |
|---|---|---|
| Plug-in or step throws; step created, enabled or assembly updated shortly before the failures | **CRM development team** | Disable or roll back the step, fix the plug-in |
| Application user disabled or role removed | **CRM platform / admin team** | Re-enable the user or restore the role, find out why it changed |
| Dataverse cannot authenticate to Service Bus after a key was regenerated in Azure | **Azure integration team** owns the change, **CRM admin** applies the fix | Update the SAS key on the service endpoint, agree a rotation runbook |
| Entra secret or certificate expired | **Identity / integration team** | Rotate the credential, update the app setting |
| Message references data Dataverse does not have (missing parent, bad option value, duplicate key) | **Business / data owners of the source system** | Fix or resubmit the data; this is not an engineering defect |
| Dataverse returns 429 with Retry-After | **Integration team** | Reduce concurrency, honour Retry-After, spread load across users |
| Azure code throws before calling Dataverse, or a deployment broke it | **Azure integration team** | Roll back or fix the deployment |

If the evidence does not separate two candidates, say so and name the one check that would.

## Step 4 - Report the ownership verdict

Use exactly this structure. Keep it short enough to read on a phone.

```
OWNERSHIP VERDICT
Owner:        <one team>
Plane:        <Azure | Dataverse | Identity | Data>
Confidence:   <High | Medium | Low> - <one line why>

What broke:   <one sentence, plain words>
Started:      <UTC time of first failure>
Impact:       <which flow, how many messages or records, still ongoing or not>

Evidence - Azure:
- <fact with timestamp and where it came from>
Evidence - Dataverse:
- <fact with timestamp and which dv_ tool returned it>
Trigger:      <the change that caused it, who made it and when, or "not found">

Next action:  <one concrete step for the owner>
Not the cause: <what you checked and ruled out, so nobody re-checks it>
```

## Rules

- The Dataverse tools are read-only. Do not attempt to fix Dataverse; recommend the fix.
- Do not replay dead-lettered messages or change Azure resources unless a person approves.
- Quote identifiers exactly (request ids, step names, plug-in type names). The owning team will search for them.
- Never print secrets or key values.
