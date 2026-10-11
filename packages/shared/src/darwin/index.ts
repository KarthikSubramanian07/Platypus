/**
 * Darwin (darwin.so), the search engine customer agents use to find other agents.
 * Platypus asks Darwin first whether an agent-native route already exists; when
 * it does not, Platypus calls or texts the business itself.
 */
export * from "./schema";
export * from "./client";
export * from "./lookup";
export * from "./fake";
export * from "./env";
export * from "./mcp";
