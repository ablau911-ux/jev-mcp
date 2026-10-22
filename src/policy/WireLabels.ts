import { fill } from "../core/ChoiceChunker.js";
import { JevError } from "../core/JevError.js";
import type { Entry } from "../core/types.js";

/** Canonical array-index keys ("0", "7", "42"): JS objects list them first, ascending, whatever the insertion order. */
export function isIndexKey(key: string): boolean {
  return /^(0|[1-9]\d{0,9})$/.test(key) && Number(key) < 4294967295;
}

/**
 * Option names on the wire for order checks (recipes and the strict reorder check). Choice
 * criteria is a JSON object and integer-like labels ("1", "2") always serialize ascending, so a
 * permuted copy would equal the original. Those labels get a reversible alias (config
 * prompts.indexLabelAlias, "#1") in every variant; other labels go out as given. Answers are
 * mapped back to the caller's labels.
 */
export class WireLabels {
  private readonly out = new Map<string, string>();
  private readonly back = new Map<string, string>();

  constructor(labels: string[], template: string) {
    for (const label of labels) {
      const wire = WireLabels.wireName(label, template);
      if (this.back.has(wire) || isIndexKey(wire)) {
        throw JevError.invalid(`Option label "${label}" cannot keep a permuted order on the wire (alias "${wire}" collides or is integer-like).`, undefined, 'Rename the integer-like labels (e.g. "n1").');
      }
      this.out.set(label, wire);
      this.back.set(wire, label);
    }
  }

  /** The wire name of one label: the alias for an integer-like label, else the label itself. */
  static wireName(label: string, template: string): string {
    return isIndexKey(label) ? fill(template, { label }) : label;
  }

  wire(label: string): string {
    return this.out.get(label) ?? label;
  }

  label(wire: string): string {
    return this.back.get(wire) ?? wire;
  }

  /** Criteria in this order, under wire names. */
  criteria(order: string[], descriptions: Record<string, Entry>): Record<string, Entry> {
    return Object.fromEntries(order.map((l) => [this.wire(l), descriptions[l] ?? null]));
  }

  /** A Choice answer with the caller's labels. */
  answer<A extends { choice: string; probabilities: Record<string, number> }>(a: A): A {
    return { ...a, choice: this.label(a.choice), probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([w, p]) => [this.label(w), p])) };
  }
}
