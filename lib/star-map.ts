export type Position = [number, number, number];

export type MaterialKind = "note" | "web" | "github" | "image" | "voice" | "file";

export type ScreenOrigin = {
  x: number;
  y: number;
};

export type StarMaterial = {
  id: string;
  kind: MaterialKind;
  label: string;
  detail: string;
  status: "queued" | "processing" | "ready" | "failed";
  sourceUrl: string | null;
  textContent: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: number;
  origin: ScreenOrigin;
};

export type ExperienceStar = {
  id: string;
  name: string;
  position: Position;
  hue: number;
  createdAt: number;
  materials: StarMaterial[];
};

export const MATERIAL_META: Record<
  MaterialKind,
  { label: string; color: string; shortLabel: string }
> = {
  note: { label: "Note", color: "#E8ECFF", shortLabel: "N" },
  web: { label: "Web link", color: "#67E8F9", shortLabel: "W" },
  github: { label: "GitHub link", color: "#86EFAC", shortLabel: "G" },
  image: { label: "Image", color: "#F9A8D4", shortLabel: "I" },
  voice: { label: "Audio", color: "#FCD34D", shortLabel: "A" },
  file: { label: "File", color: "#A5B4FC", shortLabel: "F" },
};

const STAR_POSITIONS: Position[] = [
  [-2.8, 0.6, 0.2],
  [1.25, 1.35, -1.4],
  [3.6, -1.1, 0.4],
  [-0.75, -1.9, -0.8],
  [-4.6, -1.45, -2.2],
  [0.3, 3.1, -3.4],
  [4.8, 1.75, -3.2],
  [-3.5, 2.8, -4.1],
  [2.25, -3.15, -2.8],
  [-5.4, 0.7, -5.2],
  [5.5, -0.1, -5.6],
  [0.1, -3.7, -4.8],
];

export function getStarPosition(index: number): Position {
  if (index < STAR_POSITIONS.length) return STAR_POSITIONS[index];

  const angle = index * 2.399963229728653;
  const radius = 4.5 + (index % 4) * 0.65;
  return [
    Math.cos(angle) * radius,
    Math.sin(angle * 1.37) * 3.2,
    -3 - (index % 5) * 0.8,
  ];
}

export function createId(): string {
  return globalThis.crypto.randomUUID();
}

export function classifyText(value: string): MaterialKind {
  if (/^https?:\/\/(www\.)?github\.com\//i.test(value)) return "github";
  if (/^https?:\/\//i.test(value)) return "web";
  return "note";
}

export function kindForFile(mimeType: string): MaterialKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "voice";
  return "file";
}
