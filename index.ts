import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEvaluateTool } from "./src/tool.ts";
import { createRankTool, createClassifyTool } from "./src/decisions.ts";
import { createSearchTool } from "./src/search.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createEvaluateTool());
  pi.registerTool(createRankTool());
  pi.registerTool(createClassifyTool());
  pi.registerTool(createSearchTool());
}
