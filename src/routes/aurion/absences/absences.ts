import { PageParser } from "../utils/page-parser";
import type { AurionAbsenceRow } from "../../../types/aurion";
import { AURION_BASE, aurionTableFlow, warmKey } from "../utils/session-manager";
const MES_ABSENCES = `${AURION_BASE}/faces/MesAbsences.xhtml`;
const absencesCacheKeyOf = (warm: string): string => `aurion-absences:${warm}`;
export const absencesCacheKey = <B extends { email: string; password: string }>(b: B, warm?: string): string => absencesCacheKeyOf(warm ?? warmKey(b.email, b.password));
export class AurionAbsences extends aurionTableFlow<AurionAbsenceRow>("absences", "Mes absences", MES_ABSENCES, PageParser.parseFormIdAbsences, PageParser.parseAbsences, (idInit) => ({ largeur: "885", afterLargeur: [["form:idInit", idInit]], afterReflow: [["form:table_selection", ""]] })) {
  getAllAbsences(email: string, password: string): Promise<AurionAbsenceRow[]> { return this.readAll(email, password); }
}
