import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUILTIN_PROTOCOLS, TestProtocolContract, protocolForTestType } from "./registry";

const PUBLISHED_AT = "2026-07-28T00:00:00.000Z";

function contractJson(contract: TestProtocolContract): string {
  return JSON.stringify(contract);
}

export function protocolContractHash(contract: TestProtocolContract): string {
  return createHash("sha256").update(contractJson(contract)).digest("hex");
}

/** Idempotently installs the immutable built-in protocol catalog. */
export function ensureBuiltinProtocolCatalog(db: DatabaseSync): void {
  for (const protocol of BUILTIN_PROTOCOLS) {
    db.prepare(
      `INSERT OR IGNORE INTO test_protocol_definition
       (id, test_type, label, scope, status, created_at)
       VALUES (?, ?, ?, 'system', 'published', ?)`
    ).run(protocol.id, protocol.testType, protocol.label, PUBLISHED_AT);

    const versionId = `${protocol.id}@${protocol.version}`;
    const json = contractJson(protocol);
    const hash = protocolContractHash(protocol);
    db.prepare(
      `INSERT OR IGNORE INTO test_protocol_version
       (id, protocol_id, version, calculation_version, contract_json, contract_hash, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      versionId,
      protocol.id,
      protocol.version,
      protocol.calculationVersion,
      json,
      hash,
      PUBLISHED_AT
    );

    const stored = db
      .prepare(
        `SELECT calculation_version, contract_hash
         FROM test_protocol_version WHERE protocol_id = ? AND version = ?`
      )
      .get(protocol.id, protocol.version) as
      | { calculation_version: string; contract_hash: string }
      | undefined;
    if (
      !stored ||
      stored.calculation_version !== protocol.calculationVersion ||
      stored.contract_hash !== hash
    ) {
      throw new Error(
        `Stored protocol ${protocol.id}@${protocol.version} does not match the immutable application contract.`
      );
    }
  }
}

/**
 * Conservatively attaches protocol lineage to existing CMJ and IMTP rows.
 * It does not classify source capability or invent setup metadata.
 */
export function backfillBuiltinProtocolLineage(db: DatabaseSync): void {
  for (const testType of ["cmj", "imtp"] as const) {
    const protocol = protocolForTestType(testType)!;
    db.prepare(
      `UPDATE session
       SET protocol_id = COALESCE(protocol_id, ?),
           protocol_version = COALESCE(protocol_version, ?),
           calculation_version = COALESCE(calculation_version, ?),
           setup_variant = COALESCE(setup_variant, ?),
           setup_metadata_json = COALESCE(setup_metadata_json, '{}')
       WHERE test_type = ?`
    ).run(
      protocol.id,
      protocol.version,
      protocol.calculationVersion,
      protocol.defaultSetupVariant,
      testType
    );
  }

  db.exec(`
    UPDATE trial
    SET protocol_id = COALESCE(protocol_id, (SELECT s.protocol_id FROM session s WHERE s.id = trial.session_id)),
        protocol_version = COALESCE(protocol_version, (SELECT s.protocol_version FROM session s WHERE s.id = trial.session_id)),
        calculation_version = COALESCE(calculation_version, (SELECT s.calculation_version FROM session s WHERE s.id = trial.session_id)),
        setup_variant = COALESCE(setup_variant, (SELECT s.setup_variant FROM session s WHERE s.id = trial.session_id))
    WHERE EXISTS (
      SELECT 1 FROM session s
      WHERE s.id = trial.session_id AND s.protocol_id IS NOT NULL
    );

    UPDATE metric
    SET protocol_id = COALESCE(protocol_id, (SELECT s.protocol_id FROM session s WHERE s.id = metric.session_id)),
        protocol_version = COALESCE(protocol_version, (SELECT s.protocol_version FROM session s WHERE s.id = metric.session_id)),
        calculation_version = COALESCE(calculation_version, method_version),
        setup_variant = COALESCE(setup_variant, (SELECT s.setup_variant FROM session s WHERE s.id = metric.session_id))
    WHERE EXISTS (
      SELECT 1 FROM session s
      WHERE s.id = metric.session_id AND s.protocol_id IS NOT NULL
    );
  `);
}
