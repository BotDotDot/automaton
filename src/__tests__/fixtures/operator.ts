/** A valid local-mode operator config for tests. */
export const VALID_OPERATOR = {
  botId: "alpha",
  identityAddress: "0x1111111111111111111111111111111111111111",
  creatorAddress: "0x2222222222222222222222222222222222222222",
  genesisPrompt: "Test bot. No internet. Explore and keep notes.",
  simBalanceCents: 2000,
  ollama: {
    baseUrl: "http://ollama-gw:11434",
    model: "qwen3:8b",
    lowComputeModel: "qwen3:4b",
    numCtx: 16384,
    maxTokensPerTurn: 2048,
    think: false,
  },
};
