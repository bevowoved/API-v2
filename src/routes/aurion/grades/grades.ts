import { PageParser } from "../utils/page-parser"; import type { AurionGradeRow } from "../../../types/aurion"; import { AURION_BASE, aurionTableFlow } from "../utils/session-manager";
const CHOIX = `${AURION_BASE}/faces/ChoixIndividu.xhtml`;
export const gradesCacheKeyOf = (warm: string): string => `aurion-grades:${warm}`;
export class AurionGrades extends aurionTableFlow<AurionGradeRow>("grades", "Mes notes", CHOIX, PageParser.parseFormIdGrade,
  PageParser.parseGrades, { largeur: "1620", afterLargeur: [["form:messagesRubriqueInaccessible", ""]] }) { getAllGrades(email: string, password: string): Promise<AurionGradeRow[]> { return this.readAll(email, password); } }
