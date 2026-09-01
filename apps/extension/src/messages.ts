/** Message sent by the injected clipper back to the popup. */
export interface ClipResultMessage {
  type: "tiro-clip-result";
  payload: {
    url: string;
    title: string;
    excerpt: string;
    author: string;
    markdown: string;
    readabilityFailed: boolean;
    hasMath: boolean;
  };
}

/** The popup's one message boundary. Today only this extension's own clipper
 * can reach it, but the popup dereferences the payload (new URL, word count),
 * so the guard checks the whole shape rather than trusting the type tag. */
export function isClipResult(message: unknown): message is ClipResultMessage {
  if (typeof message !== "object" || message === null) return false;
  const { type, payload } = message as { type?: unknown; payload?: unknown };
  if (type !== "tiro-clip-result") return false;
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.url === "string" &&
    typeof p.title === "string" &&
    typeof p.excerpt === "string" &&
    typeof p.author === "string" &&
    typeof p.markdown === "string" &&
    typeof p.readabilityFailed === "boolean" &&
    typeof p.hasMath === "boolean"
  );
}
