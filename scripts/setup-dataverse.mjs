// One-time Dataverse setup for the demo. Idempotent: safe to run again.
//   1. Turns on plug-in trace logging (All).
//   2. Registers a Service Bus service endpoint + async step on account Create (outbound flow).
//   3. Registers the demo plug-in assembly + steps on contact Create/Update, left DISABLED.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dv, env, sbKey, repoRoot } from './lib.mjs';

const ENDPOINT = 'zpp-dataverse-events';
const ASSEMBLY = 'Zpp.Plugins';
const TYPE = 'Zpp.Plugins.ContactEnrichmentPlugin';

async function messageAndFilter(message, entity) {
  const m = await dv('GET', `sdkmessages?$select=sdkmessageid&$filter=name eq '${message}'`);
  const messageId = m.value[0].sdkmessageid;
  const f = await dv('GET', `sdkmessagefilters?$select=sdkmessagefilterid&$filter=_sdkmessageid_value eq ${messageId} and primaryobjecttypecode eq '${entity}'`);
  return { messageId, filterId: f.value[0].sdkmessagefilterid };
}

async function ensureStep(name, body) {
  const found = await dv('GET', `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid&$filter=name eq '${name}'`);
  if (found.value.length) { console.log(`  step exists: ${name}`); return found.value[0].sdkmessageprocessingstepid; }
  const created = await dv('POST', 'sdkmessageprocessingsteps', { name, supporteddeployment: 0, ...body });
  console.log(`  step created: ${name}`);
  return created.sdkmessageprocessingstepid;
}

// 1. Plug-in trace logging
const org = (await dv('GET', 'organizations?$select=organizationid,plugintracelogsetting')).value[0];
if (org.plugintracelogsetting !== 2) {
  await dv('PATCH', `organizations(${org.organizationid})`, { plugintracelogsetting: 2 });
  console.log('Plug-in trace logging set to All');
} else console.log('Plug-in trace logging already All');

// 2. Service endpoint + step
console.log('Service endpoint');
let ep = (await dv('GET', `serviceendpoints?$select=serviceendpointid&$filter=name eq '${ENDPOINT}'`)).value[0];
if (!ep) {
  ep = await dv('POST', 'serviceendpoints', {
    name: ENDPOINT,
    description: 'Zero Ping-Pong demo: account events to Azure Service Bus',
    namespaceformat: 2, // namespace address
    namespaceaddress: `sb://${env.SERVICEBUS_NAMESPACE}.servicebus.windows.net/`,
    path: 'dataverse-events',
    contract: 6, // persistent queue
    authtype: 2, // SAS key
    saskeyname: 'dataverse-send',
    saskey: sbKey('dataverse-send'),
    messageformat: 2, // JSON
    userclaim: 1, // none
    connectionmode: 1,
  });
  console.log(`  endpoint created: ${ENDPOINT}`);
} else console.log(`  endpoint exists: ${ENDPOINT}`);

const acc = await messageAndFilter('Create', 'account');
await ensureStep('zpp: post account Create to Service Bus', {
  mode: 1, // async
  stage: 40,
  rank: 1,
  asyncautodelete: false,
  'sdkmessageid@odata.bind': `/sdkmessages(${acc.messageId})`,
  'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${acc.filterId})`,
  'eventhandler_serviceendpoint@odata.bind': `/serviceendpoints(${ep.serviceendpointid})`,
});

// 3. Plug-in assembly, type and steps
console.log('Plug-in');
const dll = readFileSync(join(repoRoot, 'dataverse', 'plugin', 'bin', 'Release', 'net462', 'Zpp.Plugins.dll')).toString('base64');
let asm = (await dv('GET', `pluginassemblies?$select=pluginassemblyid&$filter=name eq '${ASSEMBLY}'`)).value[0];
if (!asm) {
  asm = await dv('POST', 'pluginassemblies', { name: ASSEMBLY, content: dll, isolationmode: 2, sourcetype: 0 });
  console.log('  assembly registered');
} else {
  await dv('PATCH', `pluginassemblies(${asm.pluginassemblyid})`, { content: dll });
  console.log('  assembly updated');
}
let type = (await dv('GET', `plugintypes?$select=plugintypeid&$filter=typename eq '${TYPE}'`)).value[0];
if (!type) {
  type = await dv('POST', 'plugintypes', {
    typename: TYPE, name: TYPE, friendlyname: 'Contact enrichment',
    'pluginassemblyid@odata.bind': `/pluginassemblies(${asm.pluginassemblyid})`,
  });
  console.log('  plug-in type registered');
}
for (const message of ['Create', 'Update']) {
  const c = await messageAndFilter(message, 'contact');
  const id = await ensureStep(`${TYPE}: ${message} of contact`, {
    mode: 0, // sync
    stage: 20, // pre-operation
    rank: 1,
    'sdkmessageid@odata.bind': `/sdkmessages(${c.messageId})`,
    'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${c.filterId})`,
    'eventhandler_plugintype@odata.bind': `/plugintypes(${type.plugintypeid})`,
  });
  await dv('PATCH', `sdkmessageprocessingsteps(${id})`, { statecode: 1, statuscode: 2 }); // healthy baseline = disabled
}
console.log('Done. Baseline: endpoint live, plug-in steps disabled.');
