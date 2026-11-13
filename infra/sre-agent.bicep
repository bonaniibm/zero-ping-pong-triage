// Azure SRE Agent for the demo, scoped to this resource group, with two connectors:
// Application Insights of the sample integration and the Dataverse triage MCP server.
// Skills, the custom agent and the response plan are applied afterwards by scripts/configure-agent.ps1
// (they are data-plane objects).

param agentName string = 'zpp-sre-agent'
param location string = resourceGroup().location

@description('Name of the Application Insights resource of the sample integration (same resource group).')
param integrationAppInsightsName string

@description('Name of the Log Analytics workspace to reuse for the agent telemetry (same resource group).')
param logAnalyticsName string

@description('URL of the Dataverse triage MCP endpoint.')
param mcpUrl string
@secure()
param mcpApiKey string

@description('Monthly Azure Agent Unit ceiling. Keeps a demo from surprising you.')
param monthlyAgentUnitLimit int = 3500

param modelProvider string = 'MicrosoftFoundry'
param modelName string = 'Automatic'

var roles = {
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  monitoringReader: '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
  logAnalyticsReader: '73c42c96-874c-492b-b04d-ab87d138a893'
  sreAgentAdministrator: 'e79298df-d852-4c6d-84f9-5d13249d1e55'
}
var readRoles = [ roles.reader, roles.monitoringReader, roles.logAnalyticsReader ]

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource integrationAppi 'Microsoft.Insights/components@2020-02-02' existing = {
  name: integrationAppInsightsName
}

resource agentAppi 'Microsoft.Insights/components@2020-02-02' = {
  name: '${agentName}-appi'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Request_Source: 'SreAgent'
    WorkspaceResourceId: logs.id
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${agentName}-id'
  location: location
}

resource uamiRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in readRoles: {
  name: guid(resourceGroup().id, identity.id, r)
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', r)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

#disable-next-line BCP081
resource agent 'Microsoft.App/agents@2025-05-01-preview' = {
  name: agentName
  location: location
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    knowledgeGraphConfiguration: {
      identity: identity.id
      managedResources: [ resourceGroup().id ]
    }
    actionConfiguration: {
      accessLevel: 'Low' // read-only on Azure
      identity: identity.id
      mode: 'Review'
    }
    logConfiguration: {
      applicationInsightsConfiguration: {
        appId: agentAppi.properties.AppId
        connectionString: agentAppi.properties.ConnectionString
        applicationInsightsResourceId: agentAppi.id
      }
    }
    upgradeChannel: 'Stable'
    monthlyAgentUnitLimit: monthlyAgentUnitLimit
    defaultModel: {
      provider: modelProvider
      name: modelName
    }
    experimentalSettings: {
      EnableWorkspaceTools: true
      EnableHttpTriggers: true
      EnableV2AgentLoop: true
    }
  }
  dependsOn: [ uamiRoles ]
}

resource smiRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in readRoles: {
  name: guid(resourceGroup().id, agent.id, r)
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', r)
    principalId: agent.identity.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource adminRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(agent.id, deployer().objectId, roles.sreAgentAdministrator)
  scope: agent
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', roles.sreAgentAdministrator)
    principalId: deployer().objectId
    principalType: 'User'
  }
}

#disable-next-line BCP081
resource appiConnector 'Microsoft.App/agents/connectors@2025-05-01-preview' = {
  parent: agent
  name: 'app-insights'
  properties: {
    dataConnectorType: 'AppInsights'
    dataSource: integrationAppi.id
    extendedProperties: {
      armResourceId: integrationAppi.id
      resource: { name: integrationAppi.name }
      appId: integrationAppi.properties.AppId
    }
    identity: 'system'
  }
  dependsOn: [ smiRoles ]
}

#disable-next-line BCP081
resource mcpConnector 'Microsoft.App/agents/connectors@2025-05-01-preview' = {
  parent: agent
  name: 'dataverse-triage'
  properties: {
    dataConnectorType: 'Mcp'
    dataSource: 'placeholder'
    extendedProperties: {
      type: 'http'
      endpoint: mcpUrl
      authType: 'BearerToken'
      bearerToken: mcpApiKey
    }
    identity: 'system'
  }
  dependsOn: [ appiConnector ]
}

output agentPortalUrl string = 'https://sre.azure.com/#/agent/${subscription().subscriptionId}/${resourceGroup().name}/${agentName}'
output agentEndpoint string = 'https://${agentName}.${location}.azuresre.ai'
