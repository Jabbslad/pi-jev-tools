import type { Usage } from "@earendil-works/pi-ai";
import { APIError, TypeSafeClient, type Questions, type SystemOneRequest, type TypeSafeClientConfig } from "@typesafe-ai/sdk";

export const clientConfig: TypeSafeClientConfig = {
  baseURL: "https://api.typesafe.ai",
  defaultModel: "jev-latest",
  logLevel: "off",
  timeout: 10_000,
  retry: { maxRetries: 2 },
};
export type ClientFactory = () => TypeSafeClient;
export const defaultClient: ClientFactory = () => new TypeSafeClient(clientConfig);

// One deadline covers all batches and retry delays. No network work at load time.
export async function evaluateRequests<Q extends Questions>(
  requests: SystemOneRequest<Q>[], signal?: AbortSignal,
  createClient: ClientFactory = defaultClient, deadlineMs = 30_000,
) {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const usage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  try {
    const client = createClient();
    const responses = [];
    for (const request of requests) {
      requestSignal.throwIfAborted();
      const response = await client.systemOne({ ...request, model: request.model ?? "jev-latest" }, { signal: requestSignal });
      responses.push(response);
      usage.input += response.usage.input_tokens;
      usage.output += response.usage.output_tokens;
    }
    usage.totalTokens = usage.input + usage.output;
    usage.cost.input = usage.input * 0.042 / 1_000_000;
    usage.cost.total = usage.cost.input;
    return { responses, usage };
  } catch (error) {
    if (signal?.aborted) throw new Error("TypeSafe evaluation cancelled.");
    if (deadline.signal.aborted) throw new Error("TypeSafe evaluation exceeded its total request deadline.");
    if (error instanceof APIError) {
      const hints: Record<number, string> = {
        401: "Check TYPESAFE_API_KEY.",
        403: "The API key does not have access to this resource.",
        422: "The API rejected the state, model, or question schema; check the documented context limits.",
        429: "Rate limited after retries; try again later.",
        529: "TypeSafe is overloaded after retries; try again later.",
      };
      // Never echo HTTP bodies, which can contain supplied private state.
      throw new Error(`TypeSafe HTTP ${error.status}. ${hints[error.status] ?? "The evaluation request failed."}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
