export const MAX_FILE_SIZE = 4 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 5;

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const ALLOWED_MIME_TYPES = new Set(Object.values(EXTENSION_MIME));
export const MATERIAL_FILE_ACCEPT = Object.keys(EXTENSION_MIME).map((extension) => `.${extension}`).join(",");

export function resolveFileMime(filename: string, suppliedMime: string) {
  if (ALLOWED_MIME_TYPES.has(suppliedMime)) return suppliedMime;
  if (suppliedMime) return null;
  const extension = filename.toLowerCase().split(".").pop() || "";
  return EXTENSION_MIME[extension] || null;
}

export function validateFileMetadata(file: { name: string; size: number; type: string }) {
  if (!file.name || file.name.length > 255) return "Use a filename of 1–255 characters.";
  if (file.size <= 0) return `${file.name} is empty.`;
  if (file.size > MAX_FILE_SIZE) return `${file.name} is larger than 4 MB.`;
  if (!resolveFileMime(file.name, file.type)) {
    return `${file.name} is not a supported file type.`;
  }
  return null;
}
