// Shared helpers for the setup and chaos scripts. No npm dependencies.
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = join(repoRoot, '.env.local');
  if (!existsSync(file)) throw new Error('Missing .env.local at the repo root. Copy .env.example and fill it in.');
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  env.DATAVERSE_URL = env.DATAVERSE_URL.replace(/\/+$/, '');
  return env;
}

export const env = loadEnv();

// Runs the Azure CLI. `forDataverse` uses a separate CLI profile when the Dataverse
// tenant is not the tenant of the Azure subscription (ZPP_DATAVERSE_AZ_CONFIG_DIR).
export function az(args, { forDataverse = false } = {}) {
  const childEnv = { ...process.env };
  if (forDataverse && process.env.ZPP_DATAVERSE_AZ_CONFIG_DIR) childEnv.AZURE_CONFIG_DIR = process.env.ZPP_DATAVERSE_AZ_CONFIG_DIR;
  return execSync(`az ${args}`, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const azScope = () => `--subscription ${env.AZURE_SUBSCRIPTION_ID} --resource-group ${env.RESOURCE_GROUP}`;

let cachedToken;
export function dvToken() {
  cachedToken ??= az(`account get-access-token --resource ${env.DATAVERSE_URL} --tenant ${env.DATAVERSE_TENANT_ID} --query accessToken -o tsv`, { forDataverse: true });
  return cachedToken;
}

// Dataverse Web API as the signed-in admin user.
export async function dv(method, path, body) {
  const res = await fetch(`${env.DATAVERSE_URL}/api/data/v9.2/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${dvToken()}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'odata-version': '4.0',
      prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Dataverse ${method} ${path.split('?')[0]} -> ${res.status}: ${json?.error?.message || text.slice(0, 400)}`);
  return json;
}

export function sbKey(rule, renew = false) {
  const verb = renew ? 'keys renew --key PrimaryKey' : 'keys list';
  return az(`servicebus namespace authorization-rule ${verb} ${azScope()} --namespace-name ${env.SERVICEBUS_NAMESPACE} --name ${rule} --query primaryKey -o tsv`);
}

function sasToken(uri, keyName, key) {
  const sr = encodeURIComponent(uri);
  const se = Math.floor(Date.now() / 1000) + 3600;
  const sig = encodeURIComponent(createHmac('sha256', key).update(`${sr}\n${se}`).digest('base64'));
  return `SharedAccessSignature sr=${sr}&sig=${sig}&se=${se}&skn=${keyName}`;
}

let appKey;
function sbAuth(uri) {
  appKey ??= sbKey('integration-app');
  return sasToken(uri, 'integration-app', appKey);
}

export async function sbSend(queue, payload) {
  const uri = `https://${env.SERVICEBUS_NAMESPACE}.servicebus.windows.net/${queue}`;
  const res = await fetch(`${uri}/messages`, {
    method: 'POST',
    headers: { authorization: sbAuth(uri), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Service Bus send to ${queue} -> ${res.status} ${await res.text()}`);
}

// Receive-and-delete from the dead-letter queue until it is empty.
export async function sbDrainDeadLetter(queue) {
  const uri = `https://${env.SERVICEBUS_NAMESPACE}.servicebus.windows.net/${queue}/$DeadLetterQueue`;
  let n = 0;
  for (;;) {
    const res = await fetch(`${uri}/messages/head?timeout=2`, { method: 'DELETE', headers: { authorization: sbAuth(uri) } });
    if (res.status !== 200) break;
    n += 1;
  }
  return n;
}

export function queueCounts(queue) {
  const out = az(`servicebus queue show ${azScope()} --namespace-name ${env.SERVICEBUS_NAMESPACE} --name ${queue} --query countDetails -o json`);
  const c = JSON.parse(out);
  return { active: c.activeMessageCount, deadLetter: c.deadLetterMessageCount };
}

export const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
