import { GATEWAY_TOOL_NAMES } from "@platypus/shared/contracts";

/**
 * The gateway is the only surface customer agents talk to. It implements the
 * GatewayTools contract from @platypus/shared/contracts over MCP.
 */
export const PACKAGE = "@platypus/gateway" as const;

export const implementedTools: readonly string[] = GATEWAY_TOOL_NAMES;
