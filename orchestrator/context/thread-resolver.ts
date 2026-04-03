/**
 * Extracts thread ID from different source types.
 */

export function resolveThreadId(
  source: string,
  sourceData?: Record<string, unknown>
): string | undefined {
  if (!sourceData) return undefined;

  switch (source) {
    case "email":
      return (sourceData.messageId as string) || (sourceData.threadId as string);
    case "webhook":
      return (sourceData.correlationId as string) || (sourceData.requestId as string);
    case "manual":
      return sourceData.threadId as string;
    case "schedule":
      return undefined;
    default:
      return undefined;
  }
}
