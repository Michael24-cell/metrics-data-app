import { cookies } from "next/headers";
import { listFacilities } from "./db/dal";

/**
 * Resolves the active facility from the session cookie.
 * All page/API data access is scoped to this facility via the DAL.
 */
export async function currentFacility() {
  const jar = await cookies();
  const facilities = listFacilities();
  if (facilities.length === 0) {
    throw new Error("No facilities found — run `npm run db:seed` first.");
  }
  const id = jar.get("flid")?.value;
  return facilities.find((f) => f.id === id) ?? facilities[0];
}
