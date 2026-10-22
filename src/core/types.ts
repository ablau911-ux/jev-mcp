import type { Image } from "@typesafe-ai/sdk";

/** JSON-compatible value used for state, instructions and criteria. */
export type Entry = string | number | boolean | null | Entry[] | { [key: string]: Entry };

export type QuestionType = "noul" | "choice" | "score" | "box";

export interface Question {
  type: QuestionType;
  instructions?: Entry;
  criteria?: Entry;
}

export type Questions = Record<string, Question>;

/** An image asset as the SDK 0.7 sends it: file bytes in their own multipart part. */
export type WireAsset = Image;

/** Body of POST /v1/systemone as sent on the wire. */
export interface WireRequest {
  model: string;
  state: Entry;
  questions: Questions;
  assets?: Record<string, WireAsset>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface BoxCoords {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type RawAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Record<string, Entry>;
      probabilities: Record<string, number>;
    }
  | { type: "box"; box: BoxCoords; confidence: number | null };

/** A parsed, shape-checked API response. */
export interface ParsedResponse {
  model: string;
  answers: Record<string, RawAnswer>;
  usage: Usage;
  warnings: string[];
}

/** One image after loading and inspection. */
export interface ImageInfo {
  name: string;
  format: "png" | "jpg";
  width: number;
  height: number;
  bytes: Buffer;
  sha256: string;
}

export interface ImageSpec {
  path?: string;
  data_base64?: string;
  format?: "png" | "jpg" | "jpeg";
}

/** Outcome of one System One call (before derived fields). */
export interface CallResult {
  /** Identity of the resolved, sanitized model input, questions and image bytes (never raw content). */
  content_hash?: string;
  model: string;
  answers: Record<string, RawAnswer>;
  usage: Usage & { est_cost_usd: number };
  request_id: string | null;
  latency_ms: number;
  cached: boolean;
  warnings: string[];
  images: ImageInfo[];
  /** Client-side id of this call (no vendor request id is documented). */
  client_id: string;
  /** Pre-flight token estimate, for the estimate/actual ratio in jev_status. */
  est_tokens: number;
  /** The answering model differed from the pinned/last-seen version. */
  drifted: boolean;
  /** Untrusted content was present. */
  untrusted: boolean;
  /** Highest injection-probe probability, or null when no probe ran. */
  injection_p: number | null;
  /** Secrets the guard masked before sending (count only). */
  secrets_redacted: number;
  /** The model came from config `models.override`, not the built-in pin. */
  model_overridden: boolean;
  /** Reorder check (strict): questions whose winner changed when the options were reversed; shaped as review. */
  reorder_unstable?: string[];
}
