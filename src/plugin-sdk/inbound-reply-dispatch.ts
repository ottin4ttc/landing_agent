/**
 * @deprecated Use `openclaw/plugin-sdk/channel-inbound` for inbound runners and
 * dispatch predicates. Use `openclaw/plugin-sdk/channel-outbound` for message
 * delivery helpers.
 */

export {
  buildChannelMessageReplyDispatchBase,
  buildInboundReplyDispatchBase,
  deliverDurableInboundReplyPayload,
  deliverInboundReplyWithMessageSendContext,
  dispatchChannelInboundReply,
  dispatchChannelMessageReplyWithBase,
  dispatchInboundReplyWithBase,
  dispatchReplyFromConfigWithSettledDispatcher,
  hasFinalChannelMessageReplyDispatch,
  hasFinalInboundReplyDispatch,
  hasVisibleChannelMessageReplyDispatch,
  hasVisibleInboundReplyDispatch,
  recordChannelBotPairLoopAndCheckSuppression,
  recordChannelMessageReplyDispatch,
  recordDroppedChannelInboundHistory,
  recordDroppedChannelTurnHistory,
  recordInboundSessionAndDispatchReply,
  resolveChannelMessageReplyDispatchCounts,
  resolveInboundReplyDispatchCounts,
  runChannelInboundEvent,
  runInboundReplyTurn,
  runPreparedInboundReply,
  runPreparedInboundReplyTurn,
} from "../channels/message/inbound-reply-dispatch.js";
export type {
  AssembledInboundReply,
  ChannelInboundDroppedHistoryOptions,
  ChannelInboundEventRunnerParams,
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  DurableInboundReplyDeliveryParams,
  InboundReplyDispatchResult,
  InboundReplyRecordOptions,
  PreparedInboundReply,
} from "../channels/message/inbound-reply-dispatch.js";
export type { ChannelBotLoopProtectionFacts } from "../channels/turn/kernel.js";
