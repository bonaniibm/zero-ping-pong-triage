// Sample Dataverse integration + Dataverse triage MCP server.
// Scope: one resource group. Everything is consumption or basic tier.

@description('Short lowercase prefix for resource names.')
@minLength(3)
@maxLength(8)
param prefix string = 'zpp'

param location string = resourceGroup().location

@description('Dataverse environment URL, for example https://contoso.crm.dynamics.com')
param dataverseUrl string

@description('Entra tenant that owns the Dataverse environment.')
param dataverseTenantId string

@description('Client id of the app registration the sample integration uses to write to Dataverse.')
param integrationClientId string
@secure()
param integrationClientSecret string

@description('Client id of the app registration the triage MCP server uses to read from Dataverse.')
param triageClientId string
@secure()
param triageClientSecret string

@description('Bearer token that callers of the triage MCP endpoint must present. Use a long random value.')
@secure()
param mcpApiKey string

var suffix = uniqueString(resourceGroup().id)
var sbName = '${prefix}-sb-${suffix}'
var funcName = '${prefix}-func-${suffix}'
var storageName = toLower('${prefix}st${suffix}')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-log-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    // Hard stop so a logging mistake cannot drain a subscription credit.
    workspaceCapping: { dailyQuotaGb: json('0.2') }
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appi-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: sbName
  location: location
  sku: { name: 'Basic', tier: 'Basic' }
}

resource qInbound 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'erp-contacts'
  properties: {
    maxDeliveryCount: 3
    lockDuration: 'PT30S'
  }
}

resource qOutbound 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'dataverse-events'
  properties: {
    maxDeliveryCount: 5
  }
}

// Used by the Function app and by the test/chaos scripts.
resource ruleApp 'Microsoft.ServiceBus/namespaces/AuthorizationRules@2022-10-01-preview' = {
  parent: sb
  name: 'integration-app'
  properties: { rights: [ 'Listen', 'Send' ] }
}

// Used only by the Dataverse service endpoint. Chaos scenario 1 regenerates this key.
resource ruleDataverse 'Microsoft.ServiceBus/namespaces/AuthorizationRules@2022-10-01-preview' = {
  parent: sb
  name: 'dataverse-send'
  properties: { rights: [ 'Send' ] }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${prefix}-plan-${suffix}'
  location: location
  sku: { name: 'Y1', tier: 'Dynamic' }
}

var storageConn = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'

resource func 'Microsoft.Web/sites@2023-12-01' = {
  name: funcName
  location: location
  kind: 'functionapp'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConn }
        { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING', value: storageConn }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower(funcName) }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appi.properties.ConnectionString }
        { name: 'SERVICEBUS_CONNECTION', value: ruleApp.listKeys().primaryConnectionString }
        { name: 'DATAVERSE_URL', value: dataverseUrl }
        { name: 'DATAVERSE_TENANT_ID', value: dataverseTenantId }
        { name: 'INTEGRATION_CLIENT_ID', value: integrationClientId }
        { name: 'INTEGRATION_CLIENT_SECRET', value: integrationClientSecret }
        { name: 'TRIAGE_CLIENT_ID', value: triageClientId }
        { name: 'TRIAGE_CLIENT_SECRET', value: triageClientSecret }
        { name: 'MCP_API_KEY', value: mcpApiKey }
      ]
    }
  }
}

// The incident signal: anything dead-lettered on the inbound queue.
resource dlqAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-erp-contacts-dead-letter'
  location: 'global'
  properties: {
    description: 'Dataverse integration: messages are dead-lettering on the erp-contacts queue (ERP to Dataverse contact sync).'
    severity: 2
    enabled: true
    scopes: [ sb.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'deadLettered'
          metricNamespace: 'Microsoft.ServiceBus/namespaces'
          metricName: 'DeadletteredMessages'
          dimensions: [ { name: 'EntityName', operator: 'Include', values: [ 'erp-contacts' ] } ]
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Maximum'
        }
      ]
    }
  }
  dependsOn: [ qInbound ]
}

output functionAppName string = func.name
output serviceBusNamespace string = sb.name
output appInsightsName string = appi.name
output mcpUrl string = 'https://${func.properties.defaultHostName}/api/mcp'
