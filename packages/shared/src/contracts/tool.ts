import type { z } from "zod";

export interface ToolSpec<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  description: string;
  input: I;
  output: O;
}

export const defineTools = <T extends Record<string, ToolSpec>>(tools: T): T => tools;

/** Turns a tool registry into the interface an implementation must satisfy. */
export type ToolImplementation<T extends Record<string, ToolSpec>, Ctx> = {
  [K in keyof T]: (input: z.infer<T[K]["input"]>, ctx: Ctx) => Promise<z.infer<T[K]["output"]>>;
};
