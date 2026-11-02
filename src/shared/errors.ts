export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    const tag = (error as { _tag?: unknown })._tag;
    if (typeof tag === "string" && tag) return tag;
  }
  return String(error);
}
