// SkillHub on Azure: Container Apps + PostgreSQL Flexible Server + Blob Storage (managed identity, no keys) + Log Analytics.
// Use deploy.ps1, which also creates the Entra app registration, or deploy this file with your own (docs/SELF_HOSTING.md).

@description('Short name for the resources (letters, digits, hyphens)')
@minLength(3)
@maxLength(16)
param name string = 'skillhub'

param location string = resourceGroup().location

@description('Container image')
param image string = 'ghcr.io/dorsazwilliam/skillhub:latest'

@description('Entra ID tenant (directory) id')
param entraTenantId string

@description('Entra ID application (client) id')
param entraClientId string

@secure()
@description('Entra ID client secret')
param entraClientSecret string

@description('Comma-separated emails that become owners on first sign-in')
param ownerEmails string

@description('Sign-in methods: microsoft, google, oidc, email (docs/SIGN_IN.md)')
param authProviders string = 'microsoft'

@description('Optional custom domain already pointed at the app. Empty: the Container Apps address.')
param customDomain string = ''

@secure()
param sessionSecret string = '${newGuid()}${newGuid()}'

@secure()
param postgresPassword string = '${newGuid()}Aa1!'

var suffix = uniqueString(resourceGroup().id)
var appName = '${name}-app'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-identity'
  location: location
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${replace(name, '-', '')}${suffix}', 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'skillhub'
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, blobDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${name}-pg-${suffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'skillhub'
    administratorLoginPassword: postgresPassword
    storage: { storageSizeGB: 32 }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'skillhub'
}

// Only Azure services (the app) may connect.
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

var baseUrl = empty(customDomain) ? 'https://${appName}.${env.properties.defaultDomain}' : 'https://${customDomain}'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      secrets: [
        { name: 'session-secret', value: sessionSecret }
        { name: 'entra-client-secret', value: entraClientSecret }
        { name: 'database-url', value: 'postgres://skillhub:${uriComponent(postgresPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/skillhub?sslmode=require' }
      ]
    }
    template: {
      containers: [
        {
          name: 'skillhub'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'BASE_URL', value: baseUrl }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
            { name: 'OWNER_EMAILS', value: ownerEmails }
            { name: 'AUTH_PROVIDERS', value: authProviders }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'STORAGE', value: 'azure' }
            { name: 'AZURE_STORAGE_ACCOUNT', value: storage.name }
            { name: 'AZURE_STORAGE_CONTAINER', value: 'skillhub' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/livez', port: 8080 }
              periodSeconds: 20
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    blobRole
    container
    pgDatabase
    pgFirewall
  ]
}

output url string = baseUrl
output redirectUri string = '${baseUrl}/auth/callback'
output mcpUrl string = '${baseUrl}/mcp'
