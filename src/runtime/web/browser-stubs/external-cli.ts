import { externalCliStreamBus } from '../../../core/agent/external-cli/streamBus'

export { externalCliStreamBus }

export async function runExternalAgent(): Promise<never> {
  throw new Error('External agent delegation is not available in web runtime.')
}

export async function killAllActiveExternalCli(): Promise<void> {}
