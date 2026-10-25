export interface IdRequest { email: string; password: string; }
export interface PlanningRequest extends IdRequest { startTimestamp?: number; endTimestamp?: number; }
export type NormalizedPlanningRequest = PlanningRequest & { startTimestamp: number; endTimestamp: number };
export const gradeProps = { date: "string", code: "string", name: "string", grade: "string", coefficient: "string",
  average: "string", min: "string", max: "string", median: "string", standardDeviation: "string", comment: "string" } as const;
export const absenceProps = { date: "string", type: "string", duration: "string", time: "string", class: "string", teacher: "string" } as const; type RowOf<P> = { [K in keyof P]: string };
export type AurionGradeRow = RowOf<typeof gradeProps>;
export type AurionAbsenceRow = RowOf<typeof absenceProps>;
export const lessonProps = { id: "string", title: "string", start: "string", end: "string", allDay: "boolean", editable: "boolean", className: "string" } as const;
type PropType<T> = T extends "string" ? string : T extends "number" ? number : boolean;
export type PlanningLesson = { [K in keyof typeof lessonProps]: PropType<(typeof lessonProps)[K]> };
export const lessonRequired: string[] = Object.keys(lessonProps);
export const credentialsBodySchema = { type: "object", properties: { email: { type: "string", writeOnly: true, minLength: 1 }, password: { type: "string", writeOnly: true, minLength: 1 } }, required: ["email", "password"] };
