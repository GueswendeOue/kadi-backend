"use strict";

const { BRAIN_MODES } = require("./kadiBrainConfig");
const { evaluateBrainMvpPolicy } = require("./kadiBrainPolicy");
const { buildBrainCandidateDecision } = require("./kadiBrainCandidate");
const { evaluateBrainConversationEligibility } = require("./kadiBrainEligibility");
const { evaluateBrainActivationAllowlist } = require("./kadiBrainAllowlist");
const { adaptBrainDecisionToDraft } = require("./kadiBrainDraftAdapter");

const BRAIN_ORCHESTRATOR_STATUSES = Object.freeze({
  ADAPTED: "adapted", NO_CHANGE: "no_change", REJECTED: "rejected",
  INVALID: "invalid",
});
const BRAIN_ORCHESTRATOR_STAGES = Object.freeze({
  INPUT: "input", POLICY: "policy", CANDIDATE: "candidate",
  ELIGIBILITY: "eligibility", ACTIVATION: "activation",
  DRAFT_ADAPTER: "draft_adapter", COMPLETE: "complete",
});
const BRAIN_ORCHESTRATOR_REASONS = Object.freeze({
  PIPELINE_ADAPTED: "pipeline_adapted",
  PIPELINE_NO_CHANGE: "pipeline_no_change",
  INVALID_INPUT: "invalid_input",
  INVALID_MODE: "invalid_mode",
  MODE_CONTEXT_MISMATCH: "mode_context_mismatch",
  POLICY_REJECTED: "policy_rejected",
  POLICY_BRAIN_MISMATCH: "policy_brain_mismatch",
  CANDIDATE_REJECTED: "candidate_rejected",
  ELIGIBILITY_REJECTED: "eligibility_rejected",
  ACTIVATION_REJECTED: "activation_rejected",
  DRAFT_ADAPTER_REJECTED: "draft_adapter_rejected",
  POLICY_CANDIDATE_MISMATCH: "policy_candidate_mismatch",
  DECISION_CHAIN_MISMATCH: "decision_chain_mismatch",
  INVALID_TERMINAL_RESULT: "invalid_terminal_result",
});
const BRAIN_ORCHESTRATOR_NEXT_ACTIONS = Object.freeze({
  NONE: "none", ASK_MISSING_FIELDS: "ask_missing_fields",
  DETERMINISTIC_NORMALIZATION: "deterministic_normalization",
  DETERMINISTIC_CONFIRMATION: "deterministic_confirmation",
});
const BRAIN_ORCHESTRATOR_FUTURE_STEPS = Object.freeze({
  NONE: "NONE", STEP_8_MISSING_FIELDS: "STEP_8_MISSING_FIELDS",
  STEP_9_NORMALIZATION: "STEP_9_NORMALIZATION",
  STEP_10_CONFIRMATION: "STEP_10_CONFIRMATION",
});

const REQUIRED_FIELDS = [
  "brainResult", "mode", "text", "isLocalCommand", "isAdminCommand",
  "conversationContext", "activationContext", "currentDraft",
];
const EXACT_MODES = new Set(Object.values(BRAIN_MODES));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyDecisions() {
  return {
    policy: null, candidate: null, eligibility: null, activation: null,
    draftAdapter: null,
  };
}

function metadata(depth, normalization = false, finance = false) {
  return {
    reachedPolicy: depth >= 1,
    reachedCandidate: depth >= 2,
    reachedEligibility: depth >= 3,
    reachedActivation: depth >= 4,
    reachedDraftAdapter: depth >= 5,
    pipelineDepth: depth,
    requiresDeterministicNormalization: normalization,
    requiresDeterministicFinance: finance,
  };
}

function result({ status, reason, stoppedAt, decisions = emptyDecisions(),
  candidateId = null, draft = null,
  nextAction = BRAIN_ORCHESTRATOR_NEXT_ACTIONS.NONE,
  futureStep = BRAIN_ORCHESTRATOR_FUTURE_STEPS.NONE, depth = 0,
  normalization = false, finance = false }) {
  return {
    status,
    completed: status === BRAIN_ORCHESTRATOR_STATUSES.ADAPTED
      || status === BRAIN_ORCHESTRATOR_STATUSES.NO_CHANGE,
    reason,
    stoppedAt,
    candidateId,
    decisions: { ...decisions },
    draft,
    nextAction,
    futureStep,
    metadata: metadata(depth, normalization, finance),
  };
}

function invalidInput(reason) {
  return result({
    status: BRAIN_ORCHESTRATOR_STATUSES.INVALID,
    reason,
    stoppedAt: BRAIN_ORCHESTRATOR_STAGES.INPUT,
  });
}

function stop(status, reason, stoppedAt, depth, decisions, candidateId = null) {
  return result({ status, reason, stoppedAt, depth, decisions, candidateId });
}

function chooseAction(candidate, adapted) {
  if (candidate.intent === "clarify"
      || (Array.isArray(candidate.missingFields)
        && candidate.missingFields.length > 0)) {
    return [BRAIN_ORCHESTRATOR_NEXT_ACTIONS.ASK_MISSING_FIELDS,
      BRAIN_ORCHESTRATOR_FUTURE_STEPS.STEP_8_MISSING_FIELDS];
  }
  if (candidate.intent === "confirm_document") {
    return [BRAIN_ORCHESTRATOR_NEXT_ACTIONS.DETERMINISTIC_CONFIRMATION,
      BRAIN_ORCHESTRATOR_FUTURE_STEPS.STEP_10_CONFIRMATION];
  }
  if (adapted) {
    return [BRAIN_ORCHESTRATOR_NEXT_ACTIONS.DETERMINISTIC_NORMALIZATION,
      BRAIN_ORCHESTRATOR_FUTURE_STEPS.STEP_9_NORMALIZATION];
  }
  return [BRAIN_ORCHESTRATOR_NEXT_ACTIONS.NONE,
    BRAIN_ORCHESTRATOR_FUTURE_STEPS.NONE];
}

function orchestrateBrainDocumentPipeline(input) {
  if (!isPlainObject(input)
      || !REQUIRED_FIELDS.every((field) => Object.hasOwn(input, field))
      || typeof input.text !== "string"
      || typeof input.isLocalCommand !== "boolean"
      || typeof input.isAdminCommand !== "boolean"
      || !isPlainObject(input.conversationContext)
      || !isPlainObject(input.activationContext)
      || (input.currentDraft !== null && !isPlainObject(input.currentDraft))) {
    return invalidInput(BRAIN_ORCHESTRATOR_REASONS.INVALID_INPUT);
  }
  if (!EXACT_MODES.has(input.mode)) {
    return invalidInput(BRAIN_ORCHESTRATOR_REASONS.INVALID_MODE);
  }
  if (input.activationContext.mode !== input.mode) {
    return invalidInput(BRAIN_ORCHESTRATOR_REASONS.MODE_CONTEXT_MISMATCH);
  }

  const decisions = emptyDecisions();
  const rawIntent = input.brainResult?.intent?.name;
  const rawDocumentType = input.brainResult?.document?.documentType;
  decisions.policy = evaluateBrainMvpPolicy({
    mode: input.mode, text: input.text,
    isLocalCommand: input.isLocalCommand,
    isAdminCommand: input.isAdminCommand,
    intent: rawIntent, documentType: rawDocumentType,
  });
  if (decisions.policy.eligible !== true) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.REJECTED,
      BRAIN_ORCHESTRATOR_REASONS.POLICY_REJECTED,
      BRAIN_ORCHESTRATOR_STAGES.POLICY, 1, decisions);
  }
  if (rawDocumentType !== null && rawDocumentType !== undefined
      && decisions.policy.documentType !== rawDocumentType) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.INVALID,
      BRAIN_ORCHESTRATOR_REASONS.POLICY_BRAIN_MISMATCH,
      BRAIN_ORCHESTRATOR_STAGES.POLICY, 1, decisions);
  }

  decisions.candidate = buildBrainCandidateDecision({
    mode: input.mode, text: input.text,
    isLocalCommand: input.isLocalCommand,
    isAdminCommand: input.isAdminCommand,
    brainResult: input.brainResult,
  });
  const candidate = decisions.candidate;
  if (candidate.status !== "candidate" || candidate.eligible !== true
      || candidate.reason !== "candidate_ready") {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.REJECTED,
      BRAIN_ORCHESTRATOR_REASONS.CANDIDATE_REJECTED,
      BRAIN_ORCHESTRATOR_STAGES.CANDIDATE, 2, decisions,
      candidate.candidateId ?? null);
  }
  if (candidate.policyReason !== decisions.policy.reason
      || candidate.mode !== decisions.policy.mode
      || candidate.intent !== decisions.policy.intent
      || candidate.documentType !== decisions.policy.documentType) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.INVALID,
      BRAIN_ORCHESTRATOR_REASONS.POLICY_CANDIDATE_MISMATCH,
      BRAIN_ORCHESTRATOR_STAGES.CANDIDATE, 2, decisions,
      candidate.candidateId);
  }

  decisions.eligibility = evaluateBrainConversationEligibility({
    candidateDecision: candidate,
    conversationContext: input.conversationContext,
  });
  const eligibility = decisions.eligibility;
  if (eligibility.status !== "eligible" || eligibility.eligible !== true
      || eligibility.reason !== "conversation_eligible") {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.REJECTED,
      BRAIN_ORCHESTRATOR_REASONS.ELIGIBILITY_REJECTED,
      BRAIN_ORCHESTRATOR_STAGES.ELIGIBILITY, 3, decisions,
      candidate.candidateId);
  }
  if (eligibility.candidateId !== candidate.candidateId) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.INVALID,
      BRAIN_ORCHESTRATOR_REASONS.DECISION_CHAIN_MISMATCH,
      BRAIN_ORCHESTRATOR_STAGES.ELIGIBILITY, 3, decisions,
      candidate.candidateId);
  }

  decisions.activation = evaluateBrainActivationAllowlist({
    eligibilityDecision: eligibility,
    activationContext: input.activationContext,
  });
  const activation = decisions.activation;
  if (activation.status !== "allowed" || activation.allowed !== true
      || activation.reason !== "activation_allowed") {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.REJECTED,
      BRAIN_ORCHESTRATOR_REASONS.ACTIVATION_REJECTED,
      BRAIN_ORCHESTRATOR_STAGES.ACTIVATION, 4, decisions,
      candidate.candidateId);
  }
  if (activation.candidateId !== candidate.candidateId) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.INVALID,
      BRAIN_ORCHESTRATOR_REASONS.DECISION_CHAIN_MISMATCH,
      BRAIN_ORCHESTRATOR_STAGES.ACTIVATION, 4, decisions,
      candidate.candidateId);
  }

  decisions.draftAdapter = adaptBrainDecisionToDraft({
    activationDecision: activation, eligibilityDecision: eligibility,
    candidateDecision: candidate, brainResult: input.brainResult,
    currentDraft: input.currentDraft,
  });
  const adapter = decisions.draftAdapter;
  if (adapter.candidateId !== candidate.candidateId) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.INVALID,
      BRAIN_ORCHESTRATOR_REASONS.DECISION_CHAIN_MISMATCH,
      BRAIN_ORCHESTRATOR_STAGES.DRAFT_ADAPTER, 5, decisions,
      candidate.candidateId);
  }
  if (adapter.status === "rejected") {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.REJECTED,
      BRAIN_ORCHESTRATOR_REASONS.DRAFT_ADAPTER_REJECTED,
      BRAIN_ORCHESTRATOR_STAGES.DRAFT_ADAPTER, 5, decisions,
      candidate.candidateId);
  }

  const adapted = adapter.status === "adapted" && adapter.adapted === true
    && adapter.reason === "draft_adapted" && isPlainObject(adapter.draft);
  const noChange = adapter.status === "no_change" && adapter.adapted === false
    && adapter.reason === "no_draft_change" && adapter.draft === null;
  if (!adapted && !noChange) {
    return stop(BRAIN_ORCHESTRATOR_STATUSES.INVALID,
      BRAIN_ORCHESTRATOR_REASONS.INVALID_TERMINAL_RESULT,
      BRAIN_ORCHESTRATOR_STAGES.DRAFT_ADAPTER, 5, decisions,
      candidate.candidateId);
  }

  const [nextAction, futureStep] = chooseAction(candidate, adapted);
  return result({
    status: adapted ? BRAIN_ORCHESTRATOR_STATUSES.ADAPTED
      : BRAIN_ORCHESTRATOR_STATUSES.NO_CHANGE,
    reason: adapted ? BRAIN_ORCHESTRATOR_REASONS.PIPELINE_ADAPTED
      : BRAIN_ORCHESTRATOR_REASONS.PIPELINE_NO_CHANGE,
    stoppedAt: BRAIN_ORCHESTRATOR_STAGES.COMPLETE,
    decisions, candidateId: candidate.candidateId,
    draft: adapted ? adapter.draft : null,
    nextAction, futureStep, depth: 5,
    normalization: adapter.metadata.requiresDeterministicNormalization,
    finance: adapter.metadata.requiresDeterministicFinance,
  });
}

module.exports = {
  BRAIN_ORCHESTRATOR_STATUSES,
  BRAIN_ORCHESTRATOR_STAGES,
  BRAIN_ORCHESTRATOR_REASONS,
  BRAIN_ORCHESTRATOR_NEXT_ACTIONS,
  BRAIN_ORCHESTRATOR_FUTURE_STEPS,
  orchestrateBrainDocumentPipeline,
};
