import { describe, expect, it } from "vitest";
import { getDb } from "../db/db";
import { generateCmjTrace, generateImtpTrace } from "../calc/synthetic";
import { computeCmj } from "../calc/cmj";
import { computeImtp } from "../calc/imtp";
import { cmjEventMarkers, imtpEventMarkers } from "../calc/curve";
import {
  BUILTIN_PROTOCOL_IDS,
  BUILTIN_PROTOCOLS,
  CMJ_PROTOCOL_V1,
  IMTP_PROTOCOL_V1,
  calculateProtocolAttempt,
  currentProtocolRef,
  discoverProtocolCapabilities,
  getProtocol,
  protocolForTestType,
  validateProtocolAttempt,
  validateProtocolSession,
} from "./registry";
import {
  protocolContractHash,
  ensureBuiltinProtocolCatalog,
} from "./persistence";
import {
  runImportBatch,
  syntheticSignalAdapter,
  validateCanonical,
} from "../pipeline/adapters";

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

describe("Protocol Milestone A identity and discovery", () => {
  it("exposes only immutable CMJ and IMTP version 1 contracts", () => {
    expect(BUILTIN_PROTOCOLS.map((protocol) => [protocol.id, protocol.version])).toEqual([
      [BUILTIN_PROTOCOL_IDS.cmj, 1],
      [BUILTIN_PROTOCOL_IDS.imtp, 1],
    ]);
    expect(currentProtocolRef("cmj")).toEqual({ id: "tracelab.cmj", version: 1 });
    expect(currentProtocolRef("imtp")).toEqual({ id: "tracelab.imtp", version: 1 });
    expect(currentProtocolRef("drop_jump")).toBeNull();
    expect(getProtocol("tracelab.cmj", 2)).toBeNull();
    expect(protocolForTestType("drop_jump")).toBeNull();
  });

  it("replays the exact versioned capability snapshot and calculation version", () => {
    const cmj = discoverProtocolCapabilities("tracelab.cmj", 1)!;
    const imtp = discoverProtocolCapabilities("tracelab.imtp", 1)!;
    expect(cmj).toBe(CMJ_PROTOCOL_V1);
    expect(imtp).toBe(IMTP_PROTOCOL_V1);
    expect(cmj.calculationVersion).toBe("1.0.0");
    expect(imtp.calculationVersion).toBe("1.0.0");
    expect(cmj.source.requiredChannels.map((channel) => channel.key)).toEqual(["force"]);
    expect(imtp.eventMarkers).toEqual({
      supported: true,
      kind: "imtp",
      keys: ["onsetMs", "peakForceMs"],
    });
    expect(cmj.capabilities).toMatchObject({
      visualization: { forceTimeCurve: true, alignmentEvent: "movement_start" },
      monitoring: { eligible: true },
      teamAnalysis: { eligible: true },
      agent: { eligible: true, forceTimeCurve: true },
      reprocessing: { rawWaveformRequired: true },
    });
  });

  it("persists and verifies the immutable catalog idempotently", () => {
    const db = getDb();
    ensureBuiltinProtocolCatalog(db);
    ensureBuiltinProtocolCatalog(db);
    const rows = db
      .prepare(
        `SELECT protocol_id, version, calculation_version, contract_hash
         FROM test_protocol_version ORDER BY protocol_id`
      )
      .all() as unknown as {
        protocol_id: string;
        version: number;
        calculation_version: string;
        contract_hash: string;
      }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.protocol_id)).toEqual(["tracelab.cmj", "tracelab.imtp"]);
    expect(rows.every((row) => row.version === 1 && row.calculation_version === "1.0.0")).toBe(true);
    expect(rows.find((row) => row.protocol_id === "tracelab.cmj")?.contract_hash).toBe(
      protocolContractHash(CMJ_PROTOCOL_V1)
    );
  });
});

describe("Protocol Milestone A validation boundary", () => {
  it("requires existing session identity/date metadata and rejects unsupported setup variants", () => {
    expect(
      validateProtocolSession(CMJ_PROTOCOL_V1, {
        athleteId: "",
        sessionDate: "07/28/2026",
        setupVariant: "loaded",
      }).map((issue) => issue.code)
    ).toEqual(["missing_athlete", "invalid_session_date", "unsupported_setup_variant"]);
    expect(
      validateProtocolSession(CMJ_PROTOCOL_V1, {
        athleteId: "athlete",
        sessionDate: "2026-07-28",
      })
    ).toEqual([]);
  });

  it("requires total force, positive sampling rate, and complete matched side channels", () => {
    expect(
      validateProtocolAttempt(CMJ_PROTOCOL_V1, {
        hz: 0,
        force: [],
        left: [1],
      }).map((issue) => issue.code)
    ).toEqual(["invalid_sampling_rate", "missing_total_force", "incomplete_bilateral_channels"]);
    expect(
      validateProtocolAttempt(IMTP_PROTOCOL_V1, {
        hz: 1000,
        force: [1, 2],
        left: [0.5],
        right: [0.5, 1],
      }).map((issue) => issue.code)
    ).toEqual(["channel_length_mismatch"]);
  });

  it("blocks direct canonical/API attempts to mismatch protocol, version, setup, or metric", () => {
    const db = getDb();
    const athlete = db
      .prepare(`SELECT id, facility_id FROM athlete ORDER BY rowid LIMIT 1`)
      .get() as { id: string; facility_id: string };
    const result = validateCanonical(
      {
        sessions: [
          {
            athleteId: athlete.id,
            testType: "cmj",
            protocolId: "tracelab.imtp",
            protocolVersion: 2,
            setupVariant: "loaded",
            sessionDate: "2026-07-28",
            trials: [
              {
                trialNumber: 1,
                metrics: [
                  { metricType: "imtp_peak_force", side: "bilateral", value: 2000 },
                ],
              },
            ],
          },
        ],
      },
      athlete.facility_id
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/does not match test type/);
    expect(result.errors.join(" ")).toMatch(/version 2 is not registered/);
    expect(result.errors.join(" ")).toMatch(/unsupported_setup_variant/);
    expect(result.errors.join(" ")).toMatch(/Metric 'imtp_peak_force' is not declared/);
  });
});

describe("Protocol Milestone A golden masters", () => {
  it("CMJ wrapper preserves the approved result and event markers exactly", () => {
    const trace = generateCmjTrace({
      massKg: 78,
      takeoffVelocity: 2.6,
      depthFactor: 1,
      leftShare: 0.42,
      seed: 77,
    });
    const direct = computeCmj(trace);
    const wrapped = calculateProtocolAttempt(CMJ_PROTOCOL_V1, trace);
    expect(wrapped.testType).toBe("cmj");
    expect(wrapped.result).toEqual(direct);
    expect(wrapped.markers).toEqual(cmjEventMarkers(direct, trace.hz));
    expect({
      methodVersion: direct.methodVersion,
      jumpHeightCm: round6(direct.jumpHeightCm),
      mrsi: round6(direct.mrsi),
      eccBrakingImpulseNs: round6(direct.eccBrakingImpulseNs),
      peakPropulsiveForceN: round6(direct.peakPropulsiveForceN),
      timeToTakeoffMs: round6(direct.timeToTakeoffS * 1000),
      markers: wrapped.markers,
    }).toEqual({
      methodVersion: "1.0.0",
      jumpHeightCm: 34.635856,
      mrsi: 0.434578,
      eccBrakingImpulseNs: 80.33882,
      peakPropulsiveForceN: 2067.343108,
      timeToTakeoffMs: 797,
      markers: {
        kind: "cmj",
        methodVersion: "1.0.0",
        movementStartMs: 1202,
        takeoffMs: 1999,
      },
    });
  });

  it("IMTP wrapper preserves the approved result, points, and event markers exactly", () => {
    const trace = generateImtpTrace({
      massKg: 82,
      peakNetForceN: 2200,
      riseTau: 0.25,
      leftShare: 0.4,
      seed: 88,
    });
    const direct = computeImtp(trace);
    const wrapped = calculateProtocolAttempt(IMTP_PROTOCOL_V1, trace);
    expect(wrapped.testType).toBe("imtp");
    expect(wrapped.result).toEqual(direct);
    expect(wrapped.markers).toEqual(imtpEventMarkers(direct, trace.hz));
    expect({
      methodVersion: direct.methodVersion,
      peakForceN: round6(direct.peakForceN),
      relativeForceNkg: round6(direct.relativeForceNkg),
      timeToPeakForceMs: round6(direct.timeToPeakForceMs),
      rfd0_50: round6(direct.rfd0_50),
      rfd50_150: round6(direct.rfd50_150),
      rfd150_250: round6(direct.rfd150_250),
      forcePoints: direct.forcePoints.map((point) => [point.ms, round6(point.forceN)]),
      markers: wrapped.markers,
    }).toEqual({
      methodVersion: "1.0.0",
      peakForceN: 3007.09755,
      relativeForceNkg: 36.673105,
      timeToPeakForceMs: 2718,
      rfd0_50: 7957.968125,
      rfd50_150: 5927.650695,
      rfd150_250: 3909.798836,
      forcePoints: [
        [50, 1211.684043],
        [100, 1537.479163],
        [150, 1804.449113],
        [200, 2017.450272],
        [250, 2195.428997],
        [300, 2341.964329],
      ],
      markers: {
        kind: "imtp",
        methodVersion: "1.0.0",
        onsetMs: 1501,
        peakForceMs: 4219,
      },
    });
  });

  it("persists protocol lineage on sessions, attempts, and official metrics", () => {
    const db = getDb();
    const athlete = db
      .prepare(`SELECT id, facility_id FROM athlete ORDER BY rowid LIMIT 1`)
      .get() as { id: string; facility_id: string };
    const source = db
      .prepare(
        `SELECT id FROM data_source
         WHERE facility_id = ? AND adapter_key = 'synthetic_signal' LIMIT 1`
      )
      .get(athlete.facility_id) as { id: string };

    db.exec("BEGIN IMMEDIATE");
    try {
      const result = runImportBatch(
        syntheticSignalAdapter,
        {
          sessions: [
            {
              athleteId: athlete.id,
              testType: "cmj",
              sessionDate: "2026-07-28",
              trials: [
                {
                  trialNumber: 1,
                  waveform: generateCmjTrace({
                    massKg: 78,
                    takeoffVelocity: 2.5,
                    depthFactor: 1,
                    leftShare: 0.5,
                    seed: 17,
                  }),
                },
              ],
            },
          ],
        },
        athlete.facility_id,
        source.id,
        "protocol-persistence-golden"
      );
      expect(result.status).toBe("complete");
      const row = db
        .prepare(
          `SELECT s.protocol_id AS session_protocol, s.protocol_version AS session_version,
                  s.calculation_version AS session_calculation, s.setup_variant AS session_setup,
                  t.protocol_id AS trial_protocol, t.protocol_version AS trial_version,
                  m.protocol_id AS metric_protocol, m.protocol_version AS metric_version,
                  m.calculation_version AS metric_calculation, m.setup_variant AS metric_setup
           FROM session s
           JOIN trial t ON t.session_id = s.id
           JOIN metric m ON m.session_id = s.id
           WHERE s.id = ? AND m.metric_type = 'cmj_jump_height'`
        )
        .get(result.sessionIds[0]) as Record<string, string | number>;
      expect(row).toMatchObject({
        session_protocol: "tracelab.cmj",
        session_version: 1,
        session_calculation: "1.0.0",
        session_setup: "standard",
        trial_protocol: "tracelab.cmj",
        trial_version: 1,
        metric_protocol: "tracelab.cmj",
        metric_version: 1,
        metric_calculation: "1.0.0",
        metric_setup: "standard",
      });
    } finally {
      db.exec("ROLLBACK");
    }
  });
});
