/**
 * Conway client for local mode.
 *
 * exec / readFile / writeFile keep working (they run inside the bot's own
 * container when there is no sandbox id). The credit balance is the
 * operator's placeholder until the bank's SimLedger exists (step 4).
 * Everything that would talk to Conway's API throws instead.
 */

import type { ConwayClient } from "../types.js";

export const LOCAL_MODE_UNAVAILABLE = "not available in local mode (no Conway, no internet)";

export function createLocalConwayClient(base: ConwayClient, simBalanceCents: number): ConwayClient {
  const unavailable = (what: string) => async (): Promise<never> => {
    throw new Error(`${what}: ${LOCAL_MODE_UNAVAILABLE}`);
  };
  const client: ConwayClient = {
    exec: (command, timeout) => base.exec(command, timeout),
    writeFile: (path, content) => base.writeFile(path, content),
    readFile: (path) => base.readFile(path),
    getCreditsBalance: async () => simBalanceCents,
    exposePort: unavailable("exposePort"),
    removePort: unavailable("removePort"),
    createSandbox: unavailable("createSandbox"),
    deleteSandbox: unavailable("deleteSandbox"),
    listSandboxes: unavailable("listSandboxes"),
    getCreditsPricing: unavailable("getCreditsPricing"),
    transferCredits: unavailable("transferCredits"),
    registerAutomaton: unavailable("registerAutomaton"),
    searchDomains: unavailable("searchDomains"),
    registerDomain: unavailable("registerDomain"),
    listDnsRecords: unavailable("listDnsRecords"),
    addDnsRecord: unavailable("addDnsRecord"),
    deleteDnsRecord: unavailable("deleteDnsRecord"),
    listModels: unavailable("listModels"),
    createScopedClient: () => {
      throw new Error(`createScopedClient: ${LOCAL_MODE_UNAVAILABLE}`);
    },
  };
  return client;
}
