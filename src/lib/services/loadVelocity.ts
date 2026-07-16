/**
 * Live load–velocity service — reads the athlete's STORED velocity reps
 * (velocity_rep joined through exercise_set to training_session) and rebuilds
 * each session's profile with calc/loadVelocity.ts on every request. The
 * seed-authored load_velocity_profile table is intentionally not consulted:
 * what the trainer sees is always derived from the rep data on record.
 */

import { getDb } from "../db/db";
import { buildLoadVelocityProfile, LiveLoadVelocityProfile } from "../calc/loadVelocity";

export interface LiveLvSession {
  trainingSessionId: string;
  date: string;
  exercise: string;
  profile: LiveLoadVelocityProfile;
}

export function liveLoadVelocityProfiles(facilityId: string, athleteId: string): LiveLvSession[] {
  const rows = getDb()
    .prepare(
      `SELECT ts.id as training_session_id, ts.session_date, es.exercise,
              es.load_kg, vr.mean_velocity_ms, vr.quality_flag
       FROM velocity_rep vr
       JOIN exercise_set es ON es.id = vr.exercise_set_id
       JOIN training_session ts ON ts.id = es.training_session_id
       WHERE vr.facility_id = ? AND ts.athlete_id = ? AND es.load_kg IS NOT NULL
       ORDER BY ts.session_date ASC, es.exercise ASC, es.load_kg ASC, vr.rep_number ASC`
    )
    .all(facilityId, athleteId) as unknown as {
    training_session_id: string;
    session_date: string;
    exercise: string;
    load_kg: number;
    mean_velocity_ms: number;
    quality_flag: string | null;
  }[];

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.training_session_id}::${r.exercise}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const sessions: LiveLvSession[] = [...groups.values()].map((g) => ({
    trainingSessionId: g[0].training_session_id,
    date: g[0].session_date,
    exercise: g[0].exercise,
    profile: buildLoadVelocityProfile(
      g.map((r) => ({ loadKg: r.load_kg, meanVelocityMs: r.mean_velocity_ms, qualityFlag: r.quality_flag }))
    ),
  }));

  // most recent first; stable within a date by exercise
  sessions.sort((a, b) => (a.date === b.date ? a.exercise.localeCompare(b.exercise) : b.date.localeCompare(a.date)));
  return sessions;
}
