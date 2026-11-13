// Dataverse triage tools. Every tool is read-only: the client below only issues GET requests.
const { client } = require('../lib/dataverse');

const dv = () => client('TRIAGE');
const since = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const cut = (s, n = 600) => (s && s.length > n ? `${s.slice(0, n)}… [truncated ${s.length - n} chars]` : s || null);
const fv = (row, field) => row[`${field}@OData.Community.Display.V1.FormattedValue`] ?? row[field];
const guid = (s) => {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(s))) throw new Error(`Not a GUID: ${s}`);
  return s;
};
const int = (v, dflt, max) => Math.min(Math.max(parseInt(v ?? dflt, 10) || dflt, 1), max);

function groupBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] = (out[k] || 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

// A system job is "failing" when it has failed outright (31) or is suspended waiting to retry
// after an error (10 + errorcode). Dataverse retries outbound posts for a long time before
// it gives up, so during a live outage most jobs are in the second state.
const FAILING = '(statuscode eq 31 or (statuscode eq 10 and errorcode ne null))';

const tools = [
  {
    name: 'dv_environment_summary',
    description:
      'Start here. Returns the Dataverse environment the triage server is connected to, the identity it runs as, and whether plug-in trace logging is on (if it is Off, dv_plugin_traces will return nothing).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const d = dv();
      const [who, org] = await Promise.all([
        d.get('WhoAmI'),
        d.get('organizations?$select=name,plugintracelogsetting,isauditenabled'),
      ]);
      const o = org.value[0];
      return {
        environmentUrl: d.url,
        organizationName: o.name,
        triageUserId: who.UserId,
        pluginTraceLogSetting: fv(o, 'plugintracelogsetting'),
        auditEnabled: o.isauditenabled,
        note: 'All tools on this server are read-only.',
      };
    },
  },
  {
    name: 'dv_failed_system_jobs',
    description:
      'Dataverse system jobs (asyncoperation) that failed, or that hit an error and are waiting to retry, in a time window. This is where failures of OUTBOUND integration land: service endpoint posts to Azure Service Bus, webhooks and async plug-ins. Azure sees nothing when these fail, so check here whenever Azure-side traffic from Dataverse drops or stops. Returns a grouped summary plus the most recent failures with their error text, owning step id, correlation id and request id.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceMinutes: { type: 'integer', description: 'Look-back window in minutes. Default 120.' },
        top: { type: 'integer', description: 'Max failures to return in detail. Default 10, max 50.' },
      },
    },
    handler: async (a) => {
      const minutes = int(a.sinceMinutes, 120, 10080);
      const top = int(a.top, 10, 50);
      const res = await dv().get(
        `asyncoperations?$select=name,operationtype,statuscode,message,friendlymessage,errorcode,createdon,completedon,correlationid,requestid,retrycount,_owningextensionid_value,primaryentitytype,messagename` +
          `&$filter=${FAILING} and createdon ge ${since(minutes)}&$orderby=createdon desc&$top=200`,
      );
      const rows = res.value;
      return {
        windowMinutes: minutes,
        failingCount: rows.length,
        countIsCapped: rows.length === 200,
        byStatus: groupBy(rows, (r) => (r.statuscode === 31 ? 'Failed' : 'Waiting to retry after an error')),
        byJobName: groupBy(rows, (r) => r.name || '(unnamed)').slice(0, 10),
        firstFailureInWindow: rows.length ? rows[rows.length - 1].createdon : null,
        lastFailure: rows.length ? rows[0].createdon : null,
        failures: rows.slice(0, top).map((r) => ({
          name: r.name,
          type: fv(r, 'operationtype'),
          entity: r.primaryentitytype,
          messageName: r.messagename,
          createdOn: r.createdon,
          status: r.statuscode === 31 ? 'Failed' : 'Waiting to retry after an error',
          retryCount: r.retrycount,
          errorCode: r.errorcode,
          error: cut(r.friendlymessage || r.message, 900),
          owningStepId: r._owningextensionid_value,
          correlationId: r.correlationid,
          requestId: r.requestid,
        })),
      };
    },
  },
  {
    name: 'dv_plugin_traces',
    description:
      'Plug-in trace log entries in a time window. Use when Azure callers get HTTP 400/500 from Dataverse ("ISV code aborted", "unexpected error from ISV code", business process errors): the plug-in class, the exception and the stack trace are only visible here. Filter by table, by a Dataverse request id or correlation id taken from Azure logs, or to exceptions only.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceMinutes: { type: 'integer', description: 'Look-back window in minutes. Default 120.' },
        onlyExceptions: { type: 'boolean', description: 'Only entries that have exception details. Default true.' },
        entity: { type: 'string', description: 'Logical table name, for example contact.' },
        requestId: { type: 'string', description: 'Dataverse request id (x-ms-service-request-id) from the caller logs.' },
        correlationId: { type: 'string', description: 'Dataverse correlation id.' },
        top: { type: 'integer', description: 'Max entries. Default 5, max 25.' },
      },
    },
    handler: async (a) => {
      const minutes = int(a.sinceMinutes, 120, 10080);
      const top = int(a.top, 5, 25);
      const f = [`createdon ge ${since(minutes)}`];
      if (a.onlyExceptions !== false) f.push('exceptiondetails ne null');
      if (a.entity) f.push(`primaryentity eq '${String(a.entity).replace(/[^a-z0-9_]/gi, '')}'`);
      if (a.requestId) f.push(`requestid eq ${guid(a.requestId)}`);
      if (a.correlationId) f.push(`correlationid eq ${guid(a.correlationId)}`);
      const res = await dv().get(
        `plugintracelogs?$select=typename,messagename,primaryentity,exceptiondetails,messageblock,performanceexecutionstarttime,performanceexecutionduration,correlationid,requestid,depth,mode,createdon,pluginstepid` +
          `&$filter=${f.join(' and ')}&$orderby=createdon desc&$top=100`,
      );
      const rows = res.value;
      return {
        windowMinutes: minutes,
        matchCount: rows.length,
        countIsCapped: rows.length === 100,
        byPluginType: groupBy(rows, (r) => `${r.typename} | ${r.messagename} of ${r.primaryentity}`).slice(0, 10),
        firstInWindow: rows.length ? rows[rows.length - 1].createdon : null,
        last: rows.length ? rows[0].createdon : null,
        traces: rows.slice(0, top).map((r) => ({
          pluginType: r.typename,
          message: r.messagename,
          entity: r.primaryentity,
          mode: fv(r, 'mode'),
          depth: r.depth,
          createdOn: r.createdon,
          durationMs: r.performanceexecutionduration,
          trace: cut(r.messageblock, 500),
          exception: cut(r.exceptiondetails, 1200),
          stepId: r.pluginstepid,
          correlationId: r.correlationid,
          requestId: r.requestid,
        })),
        hint: rows.length ? undefined : 'No traces. Check pluginTraceLogSetting in dv_environment_summary before concluding that no plug-in failed.',
      };
    },
  },
  {
    name: 'dv_service_endpoints',
    description:
      'Health of OUTBOUND endpoints registered in Dataverse (Azure Service Bus queues/topics, Event Hubs, webhooks): where each one points, which SAS key NAME it authenticates with, when it was last modified, the steps bound to it and whether they are enabled, and how many system jobs for those steps are failing (failed, or waiting to retry after an error) versus succeeding. Use to confirm or rule out "Dataverse cannot deliver to Azure", for example after a Service Bus key rotation. Key values are never returned.',
    inputSchema: {
      type: 'object',
      properties: { sinceMinutes: { type: 'integer', description: 'Window for the failed-job count. Default 120.' } },
    },
    handler: async (a) => {
      const minutes = int(a.sinceMinutes, 120, 10080);
      const d = dv();
      const eps = await d.get(
        'serviceendpoints?$select=name,namespaceaddress,path,contract,authtype,saskeyname,messageformat,url,modifiedon,createdon,_modifiedby_value',
      );
      const out = [];
      for (const ep of eps.value) {
        if (fv(ep, 'contract') === 'Managed Data Lake') continue; // platform-owned, not an integration endpoint
        const steps = await d.get(
          `sdkmessageprocessingsteps?$select=name,statecode,mode,stage,modifiedon&$filter=_eventhandler_value eq ${ep.serviceendpointid}`,
        );
        const stepInfo = [];
        for (const s of steps.value) {
          const [failed, ok] = await Promise.all([
            d.get(`asyncoperations?$select=createdon,friendlymessage,message&$filter=_owningextensionid_value eq ${s.sdkmessageprocessingstepid} and ${FAILING} and createdon ge ${since(minutes)}&$orderby=createdon desc&$top=50`),
            d.get(`asyncoperations?$select=createdon&$filter=_owningextensionid_value eq ${s.sdkmessageprocessingstepid} and statuscode eq 30 and createdon ge ${since(minutes)}&$orderby=createdon desc&$top=50`),
          ]);
          stepInfo.push({
            stepId: s.sdkmessageprocessingstepid,
            name: s.name,
            state: fv(s, 'statecode'),
            mode: fv(s, 'mode'),
            modifiedOn: s.modifiedon,
            failingJobsInWindow: failed.value.length,
            succeededJobsInWindow: ok.value.length,
            lastSuccess: ok.value[0]?.createdon || null,
            firstFailureInWindow: failed.value.length ? failed.value[failed.value.length - 1].createdon : null,
            lastFailure: failed.value[0]?.createdon || null,
            lastFailureError: cut(failed.value[0]?.friendlymessage || failed.value[0]?.message, 700),
          });
        }
        out.push({
          name: ep.name,
          contract: fv(ep, 'contract'),
          target: ep.url || `${ep.namespaceaddress || ''} path=${ep.path || ''}`,
          authType: fv(ep, 'authtype'),
          sasKeyName: ep.saskeyname,
          endpointModifiedOn: ep.modifiedon,
          modifiedBy: fv(ep, '_modifiedby_value'),
          steps: stepInfo,
        });
      }
      return {
        windowMinutes: minutes,
        endpoints: out,
        note: 'Successful system jobs may be auto-deleted, so a zero success count alone is not evidence of failure; failures are kept.',
      };
    },
  },
  {
    name: 'dv_application_users',
    description:
      'Application users (service principals) in Dataverse with their enabled/disabled state, security roles and last-modified time. Use when an Azure caller gets 401 or 403 from Dataverse: a disabled application user or a removed role is a Dataverse-side cause that no Azure log shows. Optionally filter by the Entra application (client) id the caller uses.',
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string', description: 'Entra application (client) id to look up.' } },
    },
    handler: async (a) => {
      const f = a.applicationId ? `applicationid eq ${guid(a.applicationId)}` : 'applicationid ne null';
      const res = await dv().get(
        `systemusers?$select=fullname,applicationid,isdisabled,modifiedon,createdon,_modifiedby_value&$filter=${f}&$expand=systemuserroles_association($select=name)&$orderby=modifiedon desc&$top=50`,
      );
      return {
        count: res.value.length,
        users: res.value.map((u) => ({
          name: u.fullname,
          applicationId: u.applicationid,
          systemUserId: u.systemuserid,
          disabled: u.isdisabled,
          roles: (u.systemuserroles_association || []).map((r) => r.name),
          modifiedOn: u.modifiedon,
          modifiedBy: fv(u, '_modifiedby_value'),
        })),
        hint: a.applicationId && !res.value.length ? 'No application user exists in this environment for that application id.' : undefined,
      };
    },
  },
  {
    name: 'dv_recent_changes',
    description:
      'Change timeline for the Dataverse side: solutions installed or updated, plug-in assemblies changed, plug-in steps created/modified/enabled/disabled, service endpoints edited and application users modified within a window. Use it the way you would use the Azure activity log: line the timestamps up against the moment the failures started.',
    inputSchema: {
      type: 'object',
      properties: { sinceHours: { type: 'integer', description: 'Look-back window in hours. Default 24, max 168.' } },
    },
    handler: async (a) => {
      const hours = int(a.sinceHours, 24, 168);
      const t = since(hours * 60);
      const d = dv();
      const [sol, asm, steps, eps, users] = await Promise.all([
        d.get(`solutions?$select=uniquename,friendlyname,version,ismanaged,installedon,modifiedon&$filter=modifiedon ge ${t} and isvisible eq true&$orderby=modifiedon desc&$top=25`),
        d.get(`pluginassemblies?$select=name,version,modifiedon,createdon,_modifiedby_value&$filter=modifiedon ge ${t}&$orderby=modifiedon desc&$top=25`),
        d.get(`sdkmessageprocessingsteps?$select=name,statecode,stage,mode,modifiedon,createdon,_modifiedby_value&$filter=modifiedon ge ${t} and ishidden/Value eq false&$orderby=modifiedon desc&$top=25`),
        d.get(`serviceendpoints?$select=name,modifiedon,_modifiedby_value&$filter=modifiedon ge ${t}&$orderby=modifiedon desc`),
        d.get(`systemusers?$select=fullname,isdisabled,modifiedon,_modifiedby_value&$filter=modifiedon ge ${t} and applicationid ne null&$orderby=modifiedon desc&$top=25`),
      ]);
      const events = [
        ...sol.value.map((s) => ({ at: s.modifiedon, kind: 'solution', what: `${s.friendlyname} (${s.uniquename}) v${s.version}${s.ismanaged ? ' managed' : ' unmanaged'}` })),
        ...asm.value.map((p) => ({ at: p.modifiedon, kind: 'plug-in assembly', what: `${p.name} v${p.version}`, by: fv(p, '_modifiedby_value') })),
        ...steps.value.map((s) => ({ at: s.modifiedon, kind: 'plug-in step', what: `${s.name} — now ${fv(s, 'statecode')}${s.createdon === s.modifiedon ? ' (created)' : ' (modified)'}`, by: fv(s, '_modifiedby_value'), stepId: s.sdkmessageprocessingstepid })),
        ...eps.value.map((e) => ({ at: e.modifiedon, kind: 'service endpoint', what: e.name, by: fv(e, '_modifiedby_value') })),
        ...users.value.map((u) => ({ at: u.modifiedon, kind: 'application user', what: `${u.fullname} — now ${u.isdisabled ? 'DISABLED' : 'enabled'}`, by: fv(u, '_modifiedby_value') })),
      ].sort((x, y) => (x.at < y.at ? 1 : -1));
      return { windowHours: hours, changeCount: events.length, changes: events };
    },
  },
  {
    name: 'dv_steps_on_table',
    description:
      'Lists the custom plug-in and service-endpoint steps registered on a Dataverse table (for example contact), with message, stage, sync/async mode, enabled state and last-modified time. Use to answer "what custom logic runs when the integration writes to this table, and did any of it change?".',
    inputSchema: {
      type: 'object',
      properties: { entity: { type: 'string', description: 'Logical table name, for example contact or account.' } },
      required: ['entity'],
    },
    handler: async (a) => {
      const entity = String(a.entity || '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
      if (!entity) throw new Error('entity is required');
      const d = dv();
      const filters = await d.get(`sdkmessagefilters?$select=sdkmessagefilterid&$filter=primaryobjecttypecode eq '${entity}'&$expand=sdkmessageid($select=name)`);
      const byId = new Map(filters.value.map((f) => [f.sdkmessagefilterid, f.sdkmessageid?.name]));
      const steps = await d.get(
        'sdkmessageprocessingsteps?$select=name,statecode,stage,mode,rank,modifiedon,_sdkmessagefilterid_value,_eventhandler_value&$filter=ishidden/Value eq false and iscustomizable/Value eq true and _sdkmessagefilterid_value ne null&$top=500',
      );
      const rows = steps.value.filter((s) => byId.has(s._sdkmessagefilterid_value));
      return {
        entity,
        stepCount: rows.length,
        steps: rows.map((s) => ({
          stepId: s.sdkmessageprocessingstepid,
          name: s.name,
          message: byId.get(s._sdkmessagefilterid_value),
          stage: fv(s, 'stage'),
          mode: fv(s, 'mode'),
          state: fv(s, 'statecode'),
          handler: fv(s, '_eventhandler_value'),
          modifiedOn: s.modifiedon,
        })),
      };
    },
  },
];

module.exports = { tools };
