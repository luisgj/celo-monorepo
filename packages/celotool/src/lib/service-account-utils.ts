import { execCmdAndParseJson, execCmdWithExitOnFailure } from './cmd-utils'
import { switchToGCPProject, switchToProjectFromEnv } from './utils'

// createServiceAccountIfNotExists creates a service account with the given name
// if it does not exist. Returns if the account was created.
export async function createServiceAccountIfNotExists(name: string, gcloudProject?: string) {
  if (gcloudProject !== undefined) {
    await switchToGCPProject(gcloudProject)
  } else {
    await switchToProjectFromEnv()
  }
  // TODO: add permissions for cloudsql editor to service account
  const serviceAccounts = await execCmdAndParseJson(
    `gcloud iam service-accounts list --quiet --format json`
  )
  const serviceAccountExists = serviceAccounts.some((account: any) => account.displayName === name)
  if (!serviceAccountExists) {
    await execCmdWithExitOnFailure(
      `gcloud iam service-accounts create ${name} --display-name="${name}"`
    )
  }
  return !serviceAccountExists
}

// getServiceAccountEmail returns the email of the service account with the
// given name
export async function getServiceAccountEmail(serviceAccountName: string) {
  const [output] = await execCmdWithExitOnFailure(
    `gcloud iam service-accounts list --filter="displayName<=${serviceAccountName} AND displayName>=${serviceAccountName}" --format='value[terminator=""](email)'`
  )
  return output
}

export function getServiceAccountKey(serviceAccountEmail: string, keyPath: string) {
  return execCmdWithExitOnFailure(
    `gcloud iam service-accounts keys create ${keyPath} --iam-account ${serviceAccountEmail}`
  )
}
