/** An error whose message is safe to show the user, with an HTTP status. */
export class GuardianError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
