/**
 * Darwin (darwin.so), the search engine customer agents use to find other agents.
 * Platypus asks Darwin first whether an agent-native route already exists; when
 * it does not, Platypus calls or texts the business itself.
 * Test doubles (ScriptedDarwin, recorded fixtures) live in @platypus/shared/testing.
 */
export * from "./schema";
export * from "./client";
export * from "./lookup";
export * from "./env";
export * from "./mcp";
