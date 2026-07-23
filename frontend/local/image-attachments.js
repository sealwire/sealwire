export const ALLOWED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES = 16 * 1024 * 1024;

export function pastedImageFiles(clipboardData) {
  return [...(clipboardData?.items || [])]
    .filter((item) => item?.kind === "file" && ALLOWED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
}

export function validateImageAttachments(existing, incoming) {
  const accepted = [];
  const errors = [];
  let count = existing.length;
  let totalBytes = existing.reduce((sum, attachment) => sum + attachment.file.size, 0);

  for (const file of incoming) {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      errors.push(`${file.name || "Image"} is not a supported image type.`);
      continue;
    }
    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      errors.push(`${file.name || "Image"} is larger than 8 MB.`);
      continue;
    }
    if (count >= MAX_IMAGE_ATTACHMENTS) {
      errors.push("You can attach at most 4 images.");
      break;
    }
    if (totalBytes + file.size > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES) {
      errors.push("Image attachments are larger than 16 MB in total.");
      break;
    }
    accepted.push(file);
    count += 1;
    totalBytes += file.size;
  }

  return { accepted, errors };
}

export function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("Failed to read image")), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}

export function formatAttachmentBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
