import { EventEmitter } from "node:events";
import type { PlatypusEvent } from "./types";

/** In-process fan-out. The database is the source of truth; the bus is for live listeners. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: PlatypusEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: PlatypusEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  listenerCount(): number {
    return this.emitter.listenerCount("event");
  }
}

export const defaultBus = new EventBus();
