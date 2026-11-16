/** The application only owns background work; platform-only context methods
 * remain with the Worker entrypoint. Native invocations also carry cancellation. */
export interface AppExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  signal?: AbortSignal;
}

export interface AppScheduledEvent {
  cron: string;
  scheduledTime: number;
}
