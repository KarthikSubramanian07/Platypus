import { CLASSIFICATION_CLASSES } from "@platypus/shared/contracts";

/**
 * The text package receives owner replies, understands them, and sends owner
 * messages on TEXT_CHANNEL. STOP, HELP and PAUSE are handled before any model call.
 */
export const PACKAGE = "@platypus/text" as const;

export const replyClasses: readonly string[] = CLASSIFICATION_CLASSES;
