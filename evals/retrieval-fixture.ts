import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Expectations are authored from fixture source, not from model outputs.
export const retrievalCases = [
  { id: "retry", query: "Where does the active client honor Retry-After, and what is the maximum retry delay?",
    terms: ["retry", "after"], relevant: ["src/net/retry-policy.ts", "docs/operations/retries.md"],
    facts: ["retry-after", "60000|60 seconds|60-second"] },
  { id: "refresh", query: "What prevents simultaneous access token refresh requests in the active client, and where is it called?",
    terms: ["refresh", "token"], relevant: ["src/auth/token-refresh.ts", "src/api/request.ts"],
    facts: ["inflightrefresh", "src/api/request.ts"] },
  { id: "rollback", query: "Which command verifies the snapshot before a production rollback, and whose approval is required?",
    terms: ["snapshot", "rollback"], relevant: ["docs/deploy/rollback.md", "docs/deploy/snapshots.md"],
    facts: ["snapshot verify", "release.owner"] },
  { id: "port", query: "What is the active server port configuration precedence, and which default is used?",
    terms: ["port", "config"], relevant: ["src/config/load.ts", "docs/configuration.md"],
    facts: ["8080", "server_port", "file"] },
] as const;

export async function createRetrievalFixture(root: string) {
  const files: Record<string, string> = {
    "src/net/retry-policy.ts": [
      "// Active HTTP client retry policy; this is production code.",
      "export function retryDelay(response, attempt, now = Date.now()) {",
      "  const header = response.headers.get('Retry-After');",
      "  const seconds = Number(header);",
      "  const dateDelay = Date.parse(header) - now;",
      "  const specified = header === null ? NaN : (Number.isFinite(seconds) ? seconds * 1000 : dateDelay);",
      "  const fallback = 250 * 2 ** attempt;",
      "  return Math.min(60000, Math.max(0, Number.isFinite(specified) ? specified : fallback));",
      "}",
    ].join("\n"),
    "docs/operations/retries.md": "# Active retry policy\nThe HTTP client uses src/net/retry-policy.ts.\nRetry-After accepts seconds or an HTTP date.\nThe maximum delay is 60 seconds. Missing or invalid Retry-After uses exponential backoff.\n",
    "src/auth/token-refresh.ts": "// Active access token refresh: concurrent callers share one promise.\nlet inFlightRefresh = null;\nexport function refreshAccessToken() {\n  if (!inFlightRefresh) {\n    inFlightRefresh = exchangeRefreshToken().finally(() => { inFlightRefresh = null; });\n  }\n  return inFlightRefresh;\n}\n",
    "src/api/request.ts": "import { refreshAccessToken } from '../auth/token-refresh';\n// Active API request wrapper.\nexport async function request(send) {\n  const response = await send();\n  if (response.status !== 401) return response;\n  await refreshAccessToken();\n  return send(); // Retry the original request once with the refreshed token.\n}\n",
    "docs/deploy/rollback.md": "# Production rollback procedure\nThis is the current production procedure, not an example.\nObtain release-owner approval before any production rollback.\nVerify the snapshot using the command documented in docs/deploy/snapshots.md.\nIf verification fails, stop. Never automatically roll back database migrations.\n",
    "docs/deploy/snapshots.md": "# Production snapshot validation\nBefore rollback, run `snapshot verify --id <snapshot-id>`.\nThe verify command checks integrity and schema compatibility.\nIt must succeed before the approved rollback proceeds.\nExporting a snapshot is not verification.\n",
    "src/config/load.ts": "// Active server port config. Validated inputs are supplied to this function.\nexport function serverPort(env, fileConfig) {\n  return env.SERVER_PORT ?? fileConfig.port ?? 8080;\n}\n",
    "docs/configuration.md": "# Current server configuration\nPort precedence: SERVER_PORT environment variable, then port from the config file, then default 8080.\nDeployment validates values before src/config/load.ts is called.\nThe historical examples are not the active configuration.\n",
  };
  // Lexical matches with enough content to make reading every match expensive.
  for (let i = 0; i < 36; i++) {
    const topic = ["retry", "refresh", "rollback", "port"][i % 4];
    files[`examples/archive/${topic}-${String(i).padStart(2, "0")}.md`] = [
      `# Historical ${topic} training example ${i}`,
      "These archived examples do not define current production behavior.",
      "Retry-After, retry delay, token refresh, snapshot rollback, and port config appear in the training vocabulary.",
      "The old example uses a 5-second delay, an independent token refresh on each request, an unverified snapshot export, and port 3000.",
      ...Array.from({ length: 6 }, (_, j) => `Exercise ${j}: compare a hypothetical retry policy, token refresh interaction, snapshot rollback discussion, and port config checklist. This is descriptive training material, not an implementation or current operational instruction.`),
    ].join("\n");
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return Object.keys(files);
}
