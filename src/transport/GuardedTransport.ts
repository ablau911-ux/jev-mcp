import type { WireRequest } from "../core/types.js";
import type { OutboundSanitizer } from "../security/OutboundSanitizer.js";
import type { JevTransport, TransportOptions, TransportResponse } from "./JevTransport.js";

/**
 * Wraps the real transport so EVERY body passes the OutboundSanitizer immediately before it
 * is sent (each retry included). This is the guarantee of the secret guard: whatever an
 * earlier step missed is masked, or the request is refused, here.
 */
export class GuardedTransport implements JevTransport {
  constructor(
    private readonly inner: JevTransport,
    private readonly sanitizer: OutboundSanitizer,
  ) {}

  systemOne(body: WireRequest, options: TransportOptions): Promise<TransportResponse> {
    let wire: WireRequest;
    try {
      wire = this.sanitizer.sanitize(body).wire;
    } catch (err) {
      return Promise.reject(err);
    }
    return this.inner.systemOne(wire, options);
  }

  listModels(options: TransportOptions): Promise<TransportResponse> {
    return this.inner.listModels(options);
  }
}
