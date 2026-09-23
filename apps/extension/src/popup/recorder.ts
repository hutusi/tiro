import type { CollectionMessage } from "../messages.ts";
import { serializer } from "../serializer.ts";

export type ToggleOp = Extract<
  CollectionMessage,
  { type: "tiro-collection-toggle" }
>["op"];

export interface ToggleEntry {
  op: ToggleOp;
  /** Whether the page said the article is in the collection. */
  published: boolean;
  member: string[];
}

/**
 * Hand toggles to the worker in the order the reader made them.
 *
 * Each toggle is retried once — a worker still waking is the usual cause of a
 * first failure — and that retry is exactly what made order matter. Sent
 * independently, an add whose first attempt failed could be overtaken by the
 * reader's next click, a remove: the remove reached the worker first and
 * changed nothing (the add had never landed), then the retried add arrived and
 * became the final state — the opposite of the last click. The worker runs
 * toggles one at a time, but in *arrival* order, so order has to be kept here,
 * where the clicks happen. Every record, the retry included, finishes before
 * the next one starts, and Save now's re-sends queue in the same line.
 *
 * `send` answers null for any failure, never throws.
 */
export function createRecorder(
  send: (message: CollectionMessage) => Promise<unknown | null>,
): (entry: ToggleEntry) => Promise<boolean> {
  const inOrder = serializer();
  return (entry) =>
    inOrder(async () => {
      const message: CollectionMessage = {
        type: "tiro-collection-toggle",
        ...entry,
      };
      return (await send(message)) !== null || (await send(message)) !== null;
    });
}
