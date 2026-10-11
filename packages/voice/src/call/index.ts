/**
 * The phone side's calling API: the outbound instruction, the call service
 * (OwnerChannels.startOnboardingCall, Dial event handling, kill switch, replay),
 * the Dial client, the FakeDial adapter and transcript mining.
 */
export {
  buildOutboundInstruction,
  centsToWords,
  cleanPromptText,
  CONSENT_QUESTION,
  DISCLOSURE,
  MAX_INSTRUCTION_CHARS,
  numberToWords,
  OutboundInstructionParams,
  speakPhoneNumber,
  TEMPLATE_VERSION,
  TEXT_NUMBER_QUESTION,
  type OutboundInstruction,
} from "./instruction";
export {
  CallPlacementError,
  CallRefusedError,
  createCallService,
  DEMO_MAX_CALL_SECONDS,
  MAX_CALL_SECONDS,
  type CallRefusal,
  type CallService,
  type CallServiceOptions,
} from "./service";
export { checkDisclosure, findBookingAgreement, tokenSimilarity, verifyQuote, type DisclosureCheck, type QuoteCheck } from "./checks";
export { describeWindow, localIso } from "./time";
export {
  createDialCalls,
  DIAL_BASE_URL,
  DialApiError,
  DialConflictError,
  DialInsufficientCreditError,
  DialNetworkError,
  DialRateLimitError,
  DialUnsupportedRegionError,
  type DialCalls,
  type DialCallsOptions,
  type PlaceCallInput,
  type PlaceCallOptions,
  type StopCallResult,
} from "../dial/client";
export { createFakeDialCalls } from "../dial/fake-adapter";
export { isLiveState, type WireCall } from "../dial/wire";
export { mineTranscript, type MineOptions, type MineResult } from "../mining/mine";
export { MINING_MODEL, mineWithClaude, type AnthropicLike } from "../mining/claude";
export { FINDING_KINDS, type Finding, type FindingKind } from "../mining/types";
export type { Friction } from "../mining/deterministic";
