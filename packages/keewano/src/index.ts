import { EVENT_ACTORS } from "@platypus/shared/events";

/**
 * The keewano package forwards typed, text-free events from the Platypus event
 * log to Keewano and answers plain-English questions about them.
 */
export const PACKAGE = "@platypus/keewano" as const;

export const forwardedActors: readonly string[] = EVENT_ACTORS;
