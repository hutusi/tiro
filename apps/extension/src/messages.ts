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
  };
}

export function isClipResult(message: unknown): message is ClipResultMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "tiro-clip-result"
  );
}
