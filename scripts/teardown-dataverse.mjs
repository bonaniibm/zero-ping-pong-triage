// Removes everything setup-dataverse.mjs and the chaos kit created in Dataverse:
// steps, plug-in type and assembly, the service endpoint, their system jobs, the demo records,
// and turns plug-in trace logging back off. Application users are disabled (Dataverse does not
// allow deleting them through the Web API).
import { dv, env } from './lib.mjs';

const TYPE = 'Zpp.Plugins.ContactEnrichmentPlugin';
const tryDelete = async (path, label) => {
  try { await dv('DELETE', path); return true; } catch (e) { console.log(`  could not delete ${label}: ${e.message.slice(0, 160)}`); return false; }
};
async function deleteAll(set, idField, filter, label) {
  let n = 0;
  for (;;) {
    const rows = (await dv('GET', `${set}?$select=${idField}&$filter=${filter}&$top=200`)).value;
    if (!rows.length) break;
    let ok = 0;
    for (const r of rows) if (await tryDelete(`${set}(${r[idField]})`, label)) ok += 1;
    n += ok;
    if (!ok) break;
  }
  console.log(`${label}: deleted ${n}`);
}

const steps = (await dv('GET', `sdkmessageprocessingsteps?$select=name&$filter=startswith(name,'zpp:') or startswith(name,'${TYPE}')`)).value;
for (const s of steps) {
  await deleteAll('asyncoperations', 'asyncoperationid', `_owningextensionid_value eq ${s.sdkmessageprocessingstepid}`, `system jobs of "${s.name}"`);
  if (await tryDelete(`sdkmessageprocessingsteps(${s.sdkmessageprocessingstepid})`, s.name)) console.log(`step deleted: ${s.name}`);
}
await deleteAll('plugintypes', 'plugintypeid', `typename eq '${TYPE}'`, 'plug-in type');
await deleteAll('pluginassemblies', 'pluginassemblyid', "name eq 'Zpp.Plugins'", 'plug-in assembly');
await deleteAll('serviceendpoints', 'serviceendpointid', "name eq 'zpp-dataverse-events'", 'service endpoint');
await deleteAll('plugintracelogs', 'plugintracelogid', `startswith(typename,'${TYPE}')`, 'plug-in trace logs');
await deleteAll('contacts', 'contactid', "startswith(emailaddress1,'demo.') and endswith(emailaddress1,'@example.com') and startswith(description,'Synced from ERP')", 'demo contacts');
await deleteAll('accounts', 'accountid', "startswith(name,'ZPP Demo Account ')", 'demo accounts');

const org = (await dv('GET', 'organizations?$select=organizationid')).value[0];
await dv('PATCH', `organizations(${org.organizationid})`, { plugintracelogsetting: 0 });
console.log('plug-in trace logging: Off');

for (const id of [env.INTEGRATION_CLIENT_ID, env.TRIAGE_CLIENT_ID]) {
  const u = (await dv('GET', `systemusers?$select=fullname&$filter=applicationid eq ${id}`)).value[0];
  if (u) { await dv('PATCH', `systemusers(${u.systemuserid})`, { isdisabled: true }); console.log(`application user disabled: ${u.fullname}`); }
}
