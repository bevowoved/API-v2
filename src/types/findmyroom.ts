export interface Building { code: string; nom: string; dispo: number; total: number; pourcentage: number; fermees?: number; }
export type RoomStatus = "DISPONIBLE" | "OCCUPEE" | "FERMEE";
interface Room { salle: string; statut: RoomStatus; capacite: number | null; type_salle: string | null; libre_jusqua: string | null; libre_jusqua_en: string | null; duree_max: string | null; duree_max_en: string | null; }
export interface RoomsForBuilding { date: string; heure: string; salles: Room[]; }
