/**
 * Protocol Milestone A
 *
 * A deliberately small, immutable kernel for the two raw force protocols
 * already validated by this repository. Scientific calculations and event
 * detection stay in calc/cmj.ts, calc/imtp.ts, and calc/curve.ts; this module
 * declares their input and downstream capabilities and delegates execution.
 */

import { CMJ_METHOD_VERSION, CmjResult, computeCmj } from "../calc/cmj";
import {
  IMTP_FORCE_POINTS_MS,
  IMTP_METHOD_VERSION,
  ImtpResult,
  computeImtp,
} from "../calc/imtp";
import {
  CmjEventMarkers,
  ImtpEventMarkers,
  cmjEventMarkers,
  imtpEventMarkers,
} from "../calc/curve";
import { ForceTimeSeries } from "../calc/signal";

export const BUILTIN_PROTOCOL_IDS = {
  cmj: "tracelab.cmj",
  imtp: "tracelab.imtp",
} as const;

export type BuiltinProtocolId = (typeof BUILTIN_PROTOCOL_IDS)[keyof typeof BUILTIN_PROTOCOL_IDS];
export type BuiltinProtocolTestType = keyof typeof BUILTIN_PROTOCOL_IDS;
export type ProtocolSetupVariant = "standard";

export interface ProtocolRef {
  id: BuiltinProtocolId;
  version: 1;
}

export interface ProtocolIssue {
  code: string;
  severity: "error" | "warning";
  blocksApproval: boolean;
  message: string;
}

export interface ProtocolSessionInput {
  athleteId: string;
  sessionDate: string;
  setupVariant?: string;
  setupMetadata?: Record<string, unknown>;
}

export interface TestProtocolContract {
  id: BuiltinProtocolId;
  version: 1;
  testType: BuiltinProtocolTestType;
  label: string;
  status: "published";
  calculationVersion: string;
  defaultSetupVariant: ProtocolSetupVariant;
  setupVariants: readonly {
    key: ProtocolSetupVariant;
    label: string;
    requiredMetadata: readonly string[];
  }[];
  source: {
    requiredChannels: readonly {
      key: "force";
      label: string;
      unit: "N";
    }[];
    optionalPairedChannels: readonly {
      keys: readonly ["left", "right"];
      label: string;
      unit: "N";
    }[];
    samplingRate: {
      required: true;
      rule: "positive_finite_hz";
    };
  };
  requiredSessionMetadata: readonly ("athleteId" | "sessionDate")[];
  attemptValidation: {
    calculationOwnsEventDetection: true;
    blockingIssueCodes: readonly string[];
    warningIssueCodes: readonly string[];
  };
  metrics: {
    officialMetricKeys: readonly string[];
    sidedMetricKeys: readonly string[];
  };
  eventMarkers:
    | {
        supported: true;
        kind: "cmj";
        keys: readonly ["movementStartMs", "takeoffMs"];
      }
    | {
        supported: true;
        kind: "imtp";
        keys: readonly ["onsetMs", "peakForceMs"];
      };
  capabilities: {
    visualization: {
      forceTimeCurve: true;
      alignmentEvent: "movement_start" | "force_onset";
    };
    monitoring: {
      eligible: true;
      metricKeys: readonly string[];
    };
    teamAnalysis: {
      eligible: true;
      metricKeys: readonly string[];
    };
    agent: {
      eligible: true;
      metricKeys: readonly string[];
      forceTimeCurve: true;
    };
    reprocessing: {
      rawWaveformRequired: true;
    };
  };
}

const CMJ_METRICS = [
  "cmj_jump_height",
  "cmj_mrsi",
  "cmj_time_to_takeoff",
  "cmj_ecc_braking_impulse",
  "cmj_peak_propulsive_force",
] as const;

const IMTP_FORCE_METRICS = IMTP_FORCE_POINTS_MS.flatMap((ms) => [
  `imtp_force_at_${ms}ms`,
  `imtp_force_at_${ms}ms_rel`,
]);

const IMTP_METRICS = [
  "imtp_peak_force",
  "imtp_relative_force",
  "imtp_time_to_peak_force",
  ...IMTP_FORCE_METRICS,
  "imtp_rfd_0_50",
  "imtp_rfd_50_150",
  "imtp_rfd_150_250",
] as const;

const IMTP_TEAM_METRICS = [
  "imtp_peak_force",
  "imtp_relative_force",
  "imtp_time_to_peak_force",
  ...IMTP_FORCE_METRICS,
] as const;

export const CMJ_PROTOCOL_V1: TestProtocolContract = {
  id: BUILTIN_PROTOCOL_IDS.cmj,
  version: 1,
  testType: "cmj",
  label: "Countermovement Jump",
  status: "published",
  calculationVersion: CMJ_METHOD_VERSION,
  defaultSetupVariant: "standard",
  setupVariants: [{ key: "standard", label: "Existing validated CMJ setup", requiredMetadata: [] }],
  source: {
    requiredChannels: [{ key: "force", label: "Total vertical force", unit: "N" }],
    optionalPairedChannels: [{ keys: ["left", "right"], label: "Left and right vertical force", unit: "N" }],
    samplingRate: { required: true, rule: "positive_finite_hz" },
  },
  requiredSessionMetadata: ["athleteId", "sessionDate"],
  attemptValidation: {
    calculationOwnsEventDetection: true,
    blockingIssueCodes: [
      "cmj_movement_start_not_detected",
      "cmj_takeoff_not_detected",
      "cmj_non_positive_takeoff_velocity",
      "cmj_braking_end_not_found",
    ],
    warningIssueCodes: ["cmj_long_time_to_takeoff"],
  },
  metrics: {
    officialMetricKeys: CMJ_METRICS,
    sidedMetricKeys: ["cmj_ecc_braking_impulse", "cmj_peak_propulsive_force"],
  },
  eventMarkers: {
    supported: true,
    kind: "cmj",
    keys: ["movementStartMs", "takeoffMs"],
  },
  capabilities: {
    visualization: { forceTimeCurve: true, alignmentEvent: "movement_start" },
    monitoring: { eligible: true, metricKeys: CMJ_METRICS },
    teamAnalysis: { eligible: true, metricKeys: CMJ_METRICS },
    agent: { eligible: true, metricKeys: CMJ_METRICS, forceTimeCurve: true },
    reprocessing: { rawWaveformRequired: true },
  },
};

export const IMTP_PROTOCOL_V1: TestProtocolContract = {
  id: BUILTIN_PROTOCOL_IDS.imtp,
  version: 1,
  testType: "imtp",
  label: "Isometric Mid-Thigh Pull",
  status: "published",
  calculationVersion: IMTP_METHOD_VERSION,
  defaultSetupVariant: "standard",
  setupVariants: [{ key: "standard", label: "Existing validated IMTP setup", requiredMetadata: [] }],
  source: {
    requiredChannels: [{ key: "force", label: "Total vertical force", unit: "N" }],
    optionalPairedChannels: [{ keys: ["left", "right"], label: "Left and right vertical force", unit: "N" }],
    samplingRate: { required: true, rule: "positive_finite_hz" },
  },
  requiredSessionMetadata: ["athleteId", "sessionDate"],
  attemptValidation: {
    calculationOwnsEventDetection: true,
    blockingIssueCodes: ["imtp_onset_not_detected"],
    warningIssueCodes: ["imtp_rfd_window_unavailable", "imtp_force_point_unavailable"],
  },
  metrics: {
    officialMetricKeys: IMTP_METRICS,
    sidedMetricKeys: [
      "imtp_peak_force",
      ...IMTP_FORCE_POINTS_MS.map((ms) => `imtp_force_at_${ms}ms`),
    ],
  },
  eventMarkers: {
    supported: true,
    kind: "imtp",
    keys: ["onsetMs", "peakForceMs"],
  },
  capabilities: {
    visualization: { forceTimeCurve: true, alignmentEvent: "force_onset" },
    monitoring: { eligible: true, metricKeys: IMTP_METRICS },
    teamAnalysis: { eligible: true, metricKeys: IMTP_TEAM_METRICS },
    agent: { eligible: true, metricKeys: IMTP_METRICS, forceTimeCurve: true },
    reprocessing: { rawWaveformRequired: true },
  },
};

export const BUILTIN_PROTOCOLS = [CMJ_PROTOCOL_V1, IMTP_PROTOCOL_V1] as const;

export function getProtocol(id: string, version: number): TestProtocolContract | null {
  return BUILTIN_PROTOCOLS.find((p) => p.id === id && p.version === version) ?? null;
}

export function protocolForTestType(testType: string): TestProtocolContract | null {
  return BUILTIN_PROTOCOLS.find((p) => p.testType === testType) ?? null;
}

export function currentProtocolRef(testType: string): ProtocolRef | null {
  const protocol = protocolForTestType(testType);
  return protocol ? { id: protocol.id, version: protocol.version } : null;
}

export function discoverProtocolCapabilities(id: string, version: number): TestProtocolContract | null {
  return getProtocol(id, version);
}

function channelIssues(series: ForceTimeSeries): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  if (!Number.isFinite(series.hz) || series.hz <= 0) {
    issues.push({
      code: "invalid_sampling_rate",
      severity: "error",
      blocksApproval: true,
      message: "Sampling rate must be a positive finite value in Hz.",
    });
  }
  if (!Array.isArray(series.force) || series.force.length === 0) {
    issues.push({
      code: "missing_total_force",
      severity: "error",
      blocksApproval: true,
      message: "The required total vertical-force channel is missing.",
    });
  } else if (series.force.some((value) => !Number.isFinite(value))) {
    issues.push({
      code: "non_numeric_total_force",
      severity: "error",
      blocksApproval: true,
      message: "The total vertical-force channel contains a non-numeric value.",
    });
  }
  if ((series.left && !series.right) || (!series.left && series.right)) {
    issues.push({
      code: "incomplete_bilateral_channels",
      severity: "error",
      blocksApproval: true,
      message: "Left and right force channels must be supplied together.",
    });
  }
  if (series.left && series.right) {
    if (series.left.length !== series.force.length || series.right.length !== series.force.length) {
      issues.push({
        code: "channel_length_mismatch",
        severity: "error",
        blocksApproval: true,
        message: "Total, left, and right force channels must contain the same number of samples.",
      });
    }
    if (series.left.some((value) => !Number.isFinite(value)) || series.right.some((value) => !Number.isFinite(value))) {
      issues.push({
        code: "non_numeric_bilateral_force",
        severity: "error",
        blocksApproval: true,
        message: "A left or right force channel contains a non-numeric value.",
      });
    }
  }
  return issues;
}

export function validateProtocolSession(
  protocol: TestProtocolContract,
  session: ProtocolSessionInput
): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  if (!session.athleteId) {
    issues.push({
      code: "missing_athlete",
      severity: "error",
      blocksApproval: true,
      message: "Athlete identity is required.",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(session.sessionDate)) {
    issues.push({
      code: "invalid_session_date",
      severity: "error",
      blocksApproval: true,
      message: "Session date must be an ISO calendar date.",
    });
  }
  const setupVariant = session.setupVariant ?? protocol.defaultSetupVariant;
  const setup = protocol.setupVariants.find((candidate) => candidate.key === setupVariant);
  if (!setup) {
    issues.push({
      code: "unsupported_setup_variant",
      severity: "error",
      blocksApproval: true,
      message: `Setup variant '${setupVariant}' is not supported by ${protocol.id}@${protocol.version}.`,
    });
  } else {
    for (const key of setup.requiredMetadata) {
      if (session.setupMetadata?.[key] == null) {
        issues.push({
          code: "missing_setup_metadata",
          severity: "error",
          blocksApproval: true,
          message: `Setup metadata '${key}' is required for variant '${setupVariant}'.`,
        });
      }
    }
  }
  return issues;
}

export function validateProtocolAttempt(
  _protocol: TestProtocolContract,
  series: ForceTimeSeries
): ProtocolIssue[] {
  return channelIssues(series);
}

export type ProtocolCalculation =
  | {
      testType: "cmj";
      protocol: TestProtocolContract;
      result: CmjResult;
      markers: CmjEventMarkers;
    }
  | {
      testType: "imtp";
      protocol: TestProtocolContract;
      result: ImtpResult;
      markers: ImtpEventMarkers;
    };

/**
 * Delegates to the unchanged approved calculators. The wrapper owns protocol
 * selection and structural source validation only; it does not reproduce or
 * alter any sports-science calculation.
 */
export function calculateProtocolAttempt(
  protocol: TestProtocolContract,
  series: ForceTimeSeries
): ProtocolCalculation {
  const issues = validateProtocolAttempt(protocol, series).filter((issue) => issue.blocksApproval);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));
  if (protocol.id === BUILTIN_PROTOCOL_IDS.cmj && protocol.version === 1) {
    const result = computeCmj(series);
    return {
      testType: "cmj",
      protocol: CMJ_PROTOCOL_V1,
      result,
      markers: cmjEventMarkers(result, series.hz),
    };
  }
  if (protocol.id === BUILTIN_PROTOCOL_IDS.imtp && protocol.version === 1) {
    const result = computeImtp(series);
    return {
      testType: "imtp",
      protocol: IMTP_PROTOCOL_V1,
      result,
      markers: imtpEventMarkers(result, series.hz),
    };
  }
  throw new Error(`No approved calculation is registered for ${protocol.id}@${protocol.version}.`);
}
