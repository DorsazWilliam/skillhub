# SkillHub on Azure in one command: Entra app registration, then main.bicep (Container Apps, PostgreSQL, Blob Storage).
# Needs the Azure CLI, signed in (az login) with rights to create app registrations and resources.
#   ./deploy/azure/deploy.ps1 -ResourceGroup skillhub -Location westeurope -OwnerEmails you@acme.com
param(
  [Parameter(Mandatory = $true)] [string] $ResourceGroup,
  [Parameter(Mandatory = $true)] [string] $OwnerEmails,
  [string] $Location = 'westeurope',
  [string] $Name = 'skillhub',
  [string] $Image = 'ghcr.io/dorsazwilliam/skillhub:latest',
  [string] $AuthProviders = 'microsoft'
)
$ErrorActionPreference = 'Stop'

Write-Host 'Resource group' $ResourceGroup
az group create --name $ResourceGroup --location $Location --output none

Write-Host 'Entra app registration'
$tenant = az account show --query tenantId --output tsv
$appId = az ad app create --display-name "SkillHub ($Name)" --sign-in-audience AzureADMyOrg --query appId --output tsv
$secret = az ad app credential reset --id $appId --display-name skillhub --years 2 --query password --output tsv

Write-Host 'Deploying (about 10 minutes, PostgreSQL is the slow part)'
$out = az deployment group create --resource-group $ResourceGroup --template-file "$PSScriptRoot/main.bicep" `
  --parameters name=$Name image=$Image entraTenantId=$tenant entraClientId=$appId entraClientSecret=$secret ownerEmails=$OwnerEmails authProviders=$AuthProviders `
  --query properties.outputs --output json | ConvertFrom-Json

az ad app update --id $appId --web-redirect-uris $out.redirectUri.value --output none

Write-Host ''
Write-Host 'SkillHub is ready'
Write-Host '  Sign in:        ' $out.url.value
Write-Host '  MCP connector:  ' $out.mcpUrl.value
Write-Host '  Entra redirect: ' $out.redirectUri.value '(already registered)'
