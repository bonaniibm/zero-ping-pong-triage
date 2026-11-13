// Chaos kit: inject one known failure into the demo integration, or put it back.
// Usage: node scripts/chaos.mjs <command> [count]
import { dv, env, sbKey, sbSend, sbDrainDeadLetter, queueCounts, stamp, sleep } from './lib.mjs';

const PLUGIN_TYPE = 'Zpp.Plugins.ContactEnrichmentPlugin';
const ENDPOINT = 'zpp-dataverse-events';
const count = parseInt(process.argv[3] || '5', 10);

async function sendContacts(n, extra = {}) {
  const run = stamp();
  for (let i = 1; i <= n; i += 1) {
    await sbSend('erp-contacts', {
      externalId: `ERP-${run}-${i}`,
      firstName: 'Demo',
      lastName: `Contact ${run}-${i}`,
      email: `demo.${run}.${i}@example.com`,
      ...extra,
    });
  }
  console.log(`Sent ${n} contact message(s) to erp-contacts (run ${run})`);
}

async function createAccounts(n) {
  const run = stamp();
  for (let i = 1; i <= n; i += 1) await dv('POST', 'accounts', { name: `ZPP Demo Account ${run}-${i}` });
  console.log(`Created ${n} account(s) in Dataverse (run ${run})`);
}

async function setPluginSteps(enabled) {
  const steps = await dv('GET', `sdkmessageprocessingsteps?$select=name&$filter=startswith(name,'${PLUGIN_TYPE}')`);
  for (const s of steps.value) {
    await dv('PATCH', `sdkmessageprocessingsteps(${s.sdkmessageprocessingstepid})`, enabled ? { statecode: 0, statuscode: 1 } : { statecode: 1, statuscode: 2 });
    console.log(`${enabled ? 'Enabled' : 'Disabled'} step: ${s.name}`);
  }
}

async function setIntegrationUser(disabled) {
  const u = await dv('GET', `systemusers?$select=fullname&$filter=applicationid eq ${env.INTEGRATION_CLIENT_ID}`);
  await dv('PATCH', `systemusers(${u.value[0].systemuserid})`, { isdisabled: disabled });
  console.log(`${u.value[0].fullname} is now ${disabled ? 'DISABLED' : 'enabled'}`);
}

const commands = {
  // Healthy traffic in both directions.
  traffic: async () => { await sendContacts(count); await createAccounts(count); },

  // Scenario 1: Service Bus key regenerated, Dataverse endpoint still holds the old key.
  'rotate-key': async () => {
    sbKey('dataverse-send', true);
    console.log('Regenerated primary key of Service Bus rule dataverse-send. Dataverse was not told.');
    await createAccounts(count);
  },
  'fix-key': async () => {
    const ep = await dv('GET', `serviceendpoints?$select=name&$filter=name eq '${ENDPOINT}'`);
    await dv('PATCH', `serviceendpoints(${ep.value[0].serviceendpointid})`, { saskey: sbKey('dataverse-send') });
    console.log('Service endpoint updated with the current key.');
  },

  // Scenario 2: a "release" switches on a plug-in that breaks integration writes.
  'break-plugin': async () => { await setPluginSteps(true); await sendContacts(count); },
  'fix-plugin': async () => setPluginSteps(false),

  // Scenario 3: the integration's application user is disabled in Dataverse.
  'disable-user': async () => { await setIntegrationUser(true); await sleep(5000); await sendContacts(count); },
  'enable-user': async () => setIntegrationUser(false),

  // Scenario 6: poison data - contacts that reference an account Dataverse does not have.
  poison: async () => sendContacts(count, { accountNumber: `ERP-ACC-${stamp()}` }),

  status: async () => {
    for (const q of ['erp-contacts', 'dataverse-events']) console.log(q, queueCounts(q));
  },
  'drain-dlq': async () => console.log(`Removed ${await sbDrainDeadLetter('erp-contacts')} dead-lettered message(s) from erp-contacts`),
};

const cmd = commands[process.argv[2]];
if (!cmd) {
  console.log(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
await cmd();
