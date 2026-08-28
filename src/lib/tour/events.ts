// Semantic events pages emit so the tour can wait for something to actually
// happen ("the project was created") instead of guessing from the DOM.
// Emitting is a one-liner inside an existing handler and is a no-op when no
// tour is running.

export type TourEventName =
  | "project:created"
  | "project:opened"
  | "recording:added"
  | "recording:selected";

type Listener = (name: TourEventName) => void;

const listeners = new Set<Listener>();

export function emitTourEvent(name: TourEventName) {
  listeners.forEach((l) => l(name));
}

export function onTourEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
