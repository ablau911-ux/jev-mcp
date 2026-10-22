import { EscapeDialect } from "./EscapeDialect.js";
import { MultilineLiterals } from "./MultilineLiterals.js";
import { TextIndex } from "./TextIndex.js";
import { ShellWords } from "./ShellWords.js";

/** A value next to a secret-like key: where it is and what it says. */
export interface ValueSpan {
  /** The whole key token before the separator (`settings.delete_token`, `API_TOKEN`). */
  key: string;
  start: number;
  end: number;
  text: string;
  /** A YAML block scalar body (YamlValueScanner): always a secret, no exemption (bug r13). */
  block?: boolean;
  /** A connection-string field value cut at its `;` (ConnectionLines): a keyed pattern's run ends there too. */
  field?: boolean;
  /** ODBC braces are quoting, never a placeholder or variable expansion exemption. */
  braceQuoted?: boolean;
}

const QUOTES = "\"'`";
/** A quoted literal: its inside, and the offset just after its closing quote. */
interface QuotedLiteral {
  start: number;
  end: number;
  text: string;
  close: number;
}
const MASK_RE = /\[REDACTED:[a-z0-9_]+\]/;
/** A simple variable expansion, the whole value: `$X`, `${X}`, `%X%` (`${{ }}` / `$( )`: balanced, see isExpansion). */
const EXPANSION_RE = /^(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|%[A-Za-z_]\w*%)$/;
/** An unquoted YAML anchor or alias name at the value's start (`&pw `, `*credentials`): skipped, the rest is the value (bug r17). */
const REFERENCE_RE = /[&*][\w-]+[ \t]*/y;
/**
 * The next field on the line, `key=value` / `key: value` (`password=x retry=1`), a quoted JSON key
 * (`, "user":`), a URL query parameter (`&user=`) or a compact object / flow-mapping key
 * (`{token:t,retries:3}`): it ends the value; a shell-escaped space (`\ `) does not start one
 * (bug r24). The last two: break hunt (later fields were masked, and a long line was quadratic).
 */
const FIELD_RE = /(?<!\\)[ \t]+[\w.-]+(?:=|:[ \t])/;
const QUERY_FIELD_G = /&[\w.-]+=/g;
const MAPPING_FIELD_G = /,[ \t]*(?:\\?["'][\w.-]+\\?["'][ \t]*:|[\w.-]+:)/g;
/** FIELD_RE as a global regex for an in-place search from the value start. */
const FIELD_G = new RegExp(FIELD_RE.source, "g");
/** What may follow a lone quoted value on its line: nothing but whitespace and a `,` / `;`. */
const LONE_TAIL_RE = /^[\s,;]*$/;
/** A closer of the enclosing object, array or call right after a quoted value (`"x1"},{"id":5`): the value ends at its quote (break hunt). */
const CLOSER_AFTER_RE = /[ \t]*[}\])]/y;
/** A line's prefix, in any combination: a diff marker (`+`, `-`, space), indentation, a comment marker (`#`) (bug r17). */
const PREFIX_RE = /[+\- ]?[ \t]*(#[ \t]*)?/y;
/** A run of structure (list dashes, prefixes, block indicators) and masks: a multi-line value that is all this is inert. */
const STRUCTURE_RUN_RE = /(?:[\s+\-#|>]|\[REDACTED:[a-z0-9_]+\])*/y;
/** A character of a whole key token (`settings.delete_token`, `db-password`). */
const KEY_CHAR_RE = /[\w.-]/;
/** A `Key=` field of a connection string: at the line start, after `;` or after a quote (`connectionString="Server=`). */
const CONNECTION_FIELD_RE = /(?:^|[;"'])[ \t]*([A-Za-z][\w ]*?)[ \t]*=/g;
/** A comparison separator: `==`, `===`, `!=`, `!==`, `.equals(` / `.equalsIgnoreCase(`. */
const COMPARISON_SEP_RE = /==|!=|\.equals/i;
/** Two characters that end a comparison operand at depth 0: `&&`, `||`, or a `:` before whitespace / the line end. */
const OPERAND_END_RE = /^(?:&&|\|\||:(?:\s|$))/;
/** A `:` separator (not `:=`) between a key and its value, with the key's closing quote or bracket. */
const COLON_SEP_RE = /^[^=]*:[ \t]*$/;
/** List dashes and an opening quote: all that may stand before a key that opens a mapping entry at its line start (sticky). */
const LIST_LEAD_RE = /(?:-[ \t]+)*["']?/y;
/** A `;` right after a quoted connection-string value (`Password="a;b";Server=x`). */
const SEMI_AFTER_RE = /[ \t]*;/y;

/** A fact about each line of the last text, worked out once per line (keyed reads ask per key). */
class LineMemo<T> {
  private text: string | null = null;
  private readonly lines = new Map<number, T>();

  get(text: string, lineStart: number, make: () => T): T {
    if (text !== this.text) {
      this.text = text;
      this.lines.clear();
    }
    if (!this.lines.has(lineStart)) this.lines.set(lineStart, make());
    return this.lines.get(lineStart) as T;
  }
}

/**
 * Quoted runs of a line (break hunt: `curl -H "Authorization: Bearer x" <url>` masked the URL): a
 * key inside a quoted word has its value end at that word's closing quote. Shell rules: `\`
 * escapes outside quotes and inside `"..."`; `'...'` is literal; an unclosed quote is no run.
 */
class QuotedRuns {
  private readonly memo = new LineMemo<Array<[number, number]>>();

  /** The closing quote of the run on the line that holds both `keyAt` and `valueAt`, or -1. */
  closeAround(text: string, lineStart: number, lineEnd: number, keyAt: number, valueAt: number): { open: number; close: number } | null {
    const runs = this.memo.get(text, lineStart, () => QuotedRuns.runs(text, lineStart, lineEnd));
    let lo = 0;
    let hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [open, close] = runs[mid]!;
      if (close < keyAt) lo = mid + 1;
      else if (open >= keyAt) hi = mid - 1;
      else return valueAt < close ? { open, close } : null;
    }
    return null;
  }

  private static runs(text: string, from: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let quote = "";
    let open = -1;
    for (let i = from; i < to; i++) {
      const c = text[i];
      if (c === "\\" && quote !== "'") i++;
      else if (quote === "" && (c === '"' || c === "'")) [quote, open] = [c, i];
      else if (c === quote) {
        out.push([open, i]);
        quote = "";
      }
    }
    return out;
  }
}

/**
 * ADO / ODBC connection-string lines (break hunt): 2+ `Key=value` fields with a key from config
 * `secretGuard.connectionKeys` (`Server=db;Password=x;Database=shop`). By the connection-string
 * spec an unquoted value cannot hold `;` (such a value is quoted), so there a field value ends at
 * its `;`. Anywhere else (`.env` `DB_PASS=a;b`, shell) the value is not shortened. Each line of
 * the last text is judged once.
 */
class ConnectionLines {
  private readonly keys: Set<string>;
  private readonly memo = new LineMemo<boolean>();

  constructor(keys: string[]) {
    this.keys = new Set(keys.map((k) => ConnectionLines.norm(k)));
  }

  /** True when the line `[lineStart, lineEnd)` of `text` is a connection string. */
  has(text: string, lineStart: number, lineEnd: number): boolean {
    return this.memo.get(text, lineStart, () => this.judge(text.slice(lineStart, lineEnd)));
  }

  private judge(line: string): boolean {
    if (!line.includes(";")) return false;
    let fields = 0;
    let known = false;
    for (const m of line.matchAll(CONNECTION_FIELD_RE)) {
      fields++;
      known ||= this.keys.has(ConnectionLines.norm(m[1] ?? ""));
    }
    return fields >= 2 && known;
  }

  private static norm(key: string): string {
    return key.trim().replace(/\s+/g, " ").toLowerCase();
  }
}

/**
 * THE classifier of values next to secret-like keys (bug r12 "mask always", r17 strict line
 * rule), shared by every check and every sink (wire, disk, MCP output, errors, logs). After a
 * secret-like key and its `:` / `=`, the value is the quoted string (to its closing quote, across
 * lines), else the rest of the line (up to the next `key=value` / `key: value` field of a log
 * line, a trailing `,` / `;` left out) plus every more-indented continuation line. Diff (`+`,
 * `-`, space) and comment (`#`) prefixes count as indentation, in any combination. An unquoted
 * anchor or alias name (`&pw`, `*credentials`) is skipped. Exempt: an empty value, a configured
 * placeholder, a variable expansion that is the whole value and balanced, a value that is only
 * the guard's own marker.
 */
export class ValueSyntax {
  private readonly placeholders: RegExp[];
  private readonly connection: ConnectionLines;
  private readonly typeWords: Set<string>;
  private readonly quotes = new QuotedRuns();
  private readonly queries = new LineMemo<Array<[number, number]>>();

  constructor(placeholders: string[], connectionKeys: string[] = [], typeWords: string[] = []) {
    this.placeholders = placeholders.map((p) => new RegExp(`^(?:${p})$`, "i"));
    this.connection = new ConnectionLines(connectionKeys);
    this.typeWords = new Set(typeWords);
  }

  /**
   * THE value-extent rule (bug r20): every keyed reader (`k: v`, `k = v`, `export K=v`,
   * `ENV K v`, `ENV K=v`, `set K=v`, JSON keys, the YAML fallback, the keyed patterns, the
   * space-separated contexts) only finds where the value starts, after the key
   * `text[keyStart, keyEnd)` and its separator; this decides where it ends. (A CLI flag or
   * command word value is one shell word, read by SpacedKeys / ShellWords, bug r26.)
   */
  read(text: string, keyStart: number, keyEnd: number, valueStart: number): ValueSpan | null {
    const lineStart = ValueSyntax.lineStart(text, keyStart);
    const lineEnd = ValueSyntax.lineEnd(text, valueStart);
    let tokenStart = keyStart;
    while (tokenStart > lineStart && KEY_CHAR_RE.test(text[tokenStart - 1] ?? "")) tokenStart--;
    const key = text.slice(tokenStart, keyEnd);
    const sep = text.slice(keyEnd, valueStart);
    if (COLON_SEP_RE.test(sep) && ValueSyntax.typeAnnotation(text, lineStart, tokenStart, valueStart, lineEnd)) return null;
    // A comparison (`token == x`, `.equals(x)`) compares one operand: it ends at its expression's end, never continues (break hunt).
    const operand = COMPARISON_SEP_RE.test(sep);
    // `type Token = { ... }` names a type, not data: no value (break hunt: the type body was masked).
    if (!operand && sep.includes("=") && this.typeWords.has(ValueSyntax.wordBefore(text, lineStart, tokenStart))) return null;
    // A multi-line string literal runs to its matching closer, across lines (bug r44: MultilineLiterals).
    const literal = MultilineLiterals.end(text, valueStart);
    if (literal > valueStart) return { key, start: valueStart, end: literal, text: text.slice(valueStart, literal) };
    const connection = this.connection.has(text, lineStart, lineEnd);
    // ODBC braces quote semicolons; a doubled closing brace is literal data.
    if (connection && text[valueStart] === "{") return ValueSyntax.odbcValue(text, key, valueStart, lineEnd);
    // Deeper-indented lines continue a `key:` value only when the key opens a mapping entry (YAML, JSON); after
    // other words (`if not token:`, `class Token:`) the `:` ends a statement header and its body is code (break hunt).
    const lead = COLON_SEP_RE.test(sep) ? text.slice(lineStart + ValueSyntax.prefix(text, lineStart, lineEnd).length, tokenStart) : "";
    const codeHeader = /^(?:async[ \t]+)?(?:if|elif|else|for|while|with|def|class|except|try|finally|match|case)\b/.test(lead);
    const indent = !operand && (!COLON_SEP_RE.test(sep) || ValueSyntax.opensEntry(text, lineStart, lineEnd, tokenStart) || !codeHeader);
    const quoted = ValueSyntax.quoted(text, valueStart);
    if (quoted && operand) return { key, start: quoted.start, end: quoted.end, text: quoted.text };
    if (quoted) return ValueSyntax.quotedValue(text, key, valueStart, lineStart, quoted, connection, indent, ValueSyntax.enclosing(text, tokenStart, sep));
    REFERENCE_RE.lastIndex = valueStart;
    const start = valueStart + (REFERENCE_RE.exec(text)?.[0].length ?? 0);
    // The next field on this line ends the value; searched in place, no per-key line copy (bug r45).
    const next = this.nextField(text, lineStart, lineEnd, tokenStart, start, sep);
    const fieldEnd = next >= 0 && next < lineEnd ? next : lineEnd;
    if (operand) return ValueSyntax.span(key, start, text.slice(start, ValueSyntax.operandEnd(text, start, fieldEnd)));
    // In a connection string a field value ends at its `;` (ConnectionLines).
    const semi = connection ? text.indexOf(";", start) : -1;
    if (semi >= 0 && semi < fieldEnd) {
      const span = ValueSyntax.span(key, start, text.slice(start, semi));
      return span && { ...span, field: true };
    }
    // A key inside a quoted word (`-H "Authorization: Bearer x" <url>`): the value ends at the word's closing quote.
    const inside = this.insideQuotedWord(text, key, lineStart, lineEnd, tokenStart, start, fieldEnd);
    if (inside) return inside;
    if (next >= 0 && next < lineEnd) return ValueSyntax.span(key, start, text.slice(start, next));
    const end = ValueSyntax.continuationEnd(text, lineStart, lineEnd, indent);
    return end < 0 ? ValueSyntax.span(key, start, text.slice(start, lineEnd)) : { key, start, end, text: text.slice(start, end) };
  }

  private static odbcValue(text: string, key: string, start: number, limit: number): ValueSpan {
    let end = start + 1;
    for (; end < limit; end++) {
      if (text[end] !== "}") continue;
      if (text[end + 1] === "}") { end++; continue; }
      end++;
      break;
    }
    const closed = text[end - 1] === "}";
    const innerStart = start + 1;
    const innerEnd = closed ? end - 1 : end;
    return { key, start: innerStart, end: innerEnd, text: text.slice(innerStart, innerEnd), field: true, braceQuoted: true };
  }

  /** Exempt complete source annotations only; defaults and uncertain prose remain credential values. */
  private static typeAnnotation(text: string, lineStart: number, keyStart: number, valueStart: number, lineEnd: number): boolean {
    const lead = text.slice(lineStart, keyStart).trimStart();
    const tail = text.slice(valueStart, lineEnd);
    // Function declarations and arrow parameter lists establish a code context. A type must end
    // at a parameter separator/closer; `= value` is a default assignment and must still be masked.
    const header = /^(?:(?:export\s+)?(?:async\s+)?function\s*\w*\s*\(|(?:async\s+)?def\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\()/.exec(lead);
    const parameters = header !== null && /^(?:[A-Za-z_$][\w$]*\??[ \t]*:[ \t]*[A-Za-z_$][\w$]*(?:[ \t]*\[\])*[ \t]*,[ \t]*)*$/.test(lead.slice(header[0].length));
    if (parameters && /^(?:string|number|boolean|bigint|symbol|unknown|never|any|object|str|int|float|bool|bytes)(?:[ \t]*\[\])*[ \t]*(?=[,)])/.test(tail)) return true;
    // A standalone typed declaration is unambiguous only for the built-in type vocabulary.
    return /^(?:export\s+)?(?:declare\s+)?(?:let|const|var)\s+$/.test(lead)
      && /^(?:string|number|boolean|bigint|symbol|unknown|never|any|object)(?:[ \t]*\[\])*[ \t]*;?[ \t]*$/.test(tail);
  }

  /** Inspect only the punctuation immediately before this key, never the whole line. */
  private static enclosing(text: string, keyStart: number, sep: string): boolean {
    let before = keyStart;
    if (text[before - 1] === '"' || text[before - 1] === "'") before--;
    while (before > 0 && /[ \t]/.test(text[before - 1] ?? "")) before--;
    return (COLON_SEP_RE.test(sep) ? "{," : "(,").includes(text[before - 1] ?? " ");
  }

  /** Compact separators are structural only in a URL query or a mapping entry. */
  private nextField(text: string, lineStart: number, lineEnd: number, tokenStart: number, start: number, sep: string): number {
    let next = TextIndex.of(text).nextMatch(FIELD_G, start);
    const queryRanges = this.queries.get(text, lineStart, () => [...text.slice(lineStart, lineEnd).matchAll(/(?:https?:\/\/|\/)[^\s"'<>]*\?[^\s"'<>]*/g)].map((m): [number, number] => [lineStart + m.index, lineStart + m.index + m[0].length]));
    let before = tokenStart;
    if (text[before - 1] === '"' || text[before - 1] === "'") before--;
    while (before > lineStart && /[ \t]/.test(text[before - 1] ?? "")) before--;
    const syntax = queryRanges.some(([from, to]) => tokenStart >= from && tokenStart < to) ? QUERY_FIELD_G
      : "{,".includes(text[before - 1] ?? " ") && COLON_SEP_RE.test(sep) ? MAPPING_FIELD_G : null;
    if (syntax) {
      const structural = TextIndex.of(text).nextMatch(syntax, start);
      if (structural >= 0 && (next < 0 || structural < next)) next = structural;
    }
    return next;
  }

  private insideQuotedWord(text: string, key: string, lineStart: number, lineEnd: number, tokenStart: number, start: number, limit: number): ValueSpan | null {
    const run = this.quotes.closeAround(text, lineStart, lineEnd, tokenStart, start);
    if (!run || run.close >= limit) return null;
    const prefix = text.slice(lineStart, run.open);
    const mapping = /[{,][ \t]*["']?[\w.-]+["']?[ \t]*:[ \t]*$/.test(prefix);
    const tail = text.slice(run.close + 1, limit);
    const concatenated = !mapping && tail.length > 0 && !/^[\s;&|]/.test(tail);
    const end = concatenated ? ShellWords.wordEnd(text, run.close + 1) : run.close;
    return { key, start, end, text: text.slice(start, end) };
  }

  /**
   * End of an unquoted comparison operand from `start` (before `limit`): an unbalanced closer
   * (`if (token == x) {`), or at depth 0 a `{` (a block), `;`, `,`, `?`, `&&`, `||` or a `:` that
   * ends a Python header.
   */
  private static operandEnd(text: string, start: number, limit: number): number {
    let depth = 0;
    for (let i = start; i < limit; i++) {
      const c = text[i] ?? "";
      if (c === "{" && depth === 0) return i;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && depth-- === 0) return i;
      else if (depth === 0 && (";,?".includes(c) || OPERAND_END_RE.test(text.slice(i, i + 2)))) return i;
    }
    return limit;
  }

  /** The word just before `pos` on its line, across blanks (`type` in `type Token`), or "". */
  private static wordBefore(text: string, lineStart: number, pos: number): string {
    let end = pos;
    while (end > lineStart && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
    if (end === pos) return "";
    let start = end;
    while (start > lineStart && /\w/.test(text[start - 1] ?? "")) start--;
    return start > lineStart && /[$.]/.test(text[start - 1] ?? "") ? "" : text.slice(start, end);
  }

  /** True when the key token at `tokenStart` opens a mapping entry: nothing but its line prefix, list dashes and an opening quote before it, or a `{` / `[` / `,`. */
  private static opensEntry(text: string, lineStart: number, lineEnd: number, tokenStart: number): boolean {
    const from = lineStart + ValueSyntax.prefix(text, lineStart, lineEnd).length;
    if (tokenStart <= from) return true;
    // Read back from the key (no scan of the whole line before it: a long JSON line has many keys).
    let at = tokenStart;
    if (text[at - 1] === '"' || text[at - 1] === "'") at--;
    while (at > from && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
    if (at > from && "{[,".includes(text[at - 1] ?? "")) return true;
    LIST_LEAD_RE.lastIndex = from;
    return (LIST_LEAD_RE.exec(text)?.[0].length ?? 0) >= tokenStart - from;
  }

  /**
   * A value that is not a secret: empty, already masked, a placeholder, a whole balanced
   * variable expansion; a multi-line value only when nothing but masks and structure is left.
   */
  isInert(value: string): boolean {
    if (value.includes("\n")) {
      // Sticky: stops at the first character that is neither structure nor a mask, no copy of the value (break hunt: speed).
      STRUCTURE_RUN_RE.lastIndex = 0;
      return (STRUCTURE_RUN_RE.exec(value)?.[0].length ?? 0) === value.length;
    }
    return value.trim().length === 0 || MASK_RE.test(value) || this.isPlaceholder(value) || ValueSyntax.isExpansion(value);
  }

  isPlaceholder(value: string): boolean {
    return value.length === 0 || this.placeholders.some((re) => re.test(value));
  }

  /** The whole value is one expansion: `$X`, `${X}`, `%X%`, or a balanced `${{ ... }}` / `$( ... )` (bug r14). */
  private static isExpansion(value: string): boolean {
    if (EXPANSION_RE.test(value)) return true;
    return (value.startsWith("${{") || value.startsWith("$(")) && ValueSyntax.balancedEnd(value) === value.length;
  }

  /** End of the bracket that opens at offset 1 (`${{`, `$(`): after its balanced close, or -1 when it never closes. */
  private static balancedEnd(text: string): number {
    let depth = 0;
    for (let i = 1; i < text.length; i++) {
      const c = text[i] ?? "";
      if ("{([".includes(c)) depth++;
      else if ("})]".includes(c) && --depth === 0) return i + 1;
    }
    return -1;
  }

  /**
   * A quoted value (bug r18): a lone quoted string is its inside; with more on the line after the
   * closing quote (`"a" "b"`, `'a' + 'b'`) the value runs from the opening quote to the line end
   * or the next field. A closer right after the quote (`"x1"},{"id":5}`, `f(k="v") + g`) ends
   * the enclosing object, array or call, so the value is the lone string.
   */
  private static quotedValue(text: string, key: string, valueStart: number, keyLineStart: number, q: QuotedLiteral, connection: boolean, indent: boolean, enclosing: boolean): ValueSpan | null {
    CLOSER_AFTER_RE.lastIndex = q.close;
    SEMI_AFTER_RE.lastIndex = q.close;
    // A connection-string field's quoted value ends at its quote when `;` follows (`Password="a;b";Server=x`).
    if ((enclosing && CLOSER_AFTER_RE.test(text)) || (connection && SEMI_AFTER_RE.test(text))) return { key, start: q.start, end: q.end, text: q.text };
    const closeLineEnd = ValueSyntax.lineEnd(text, q.close);
    const index = TextIndex.of(text);
    const plainAt = index.nextMatch(FIELD_G, q.close);
    const mappingAt = enclosing ? index.nextMatch(MAPPING_FIELD_G, q.close) : -1;
    const plainField = plainAt >= 0 && plainAt < closeLineEnd ? plainAt - q.close : -1;
    const mappingField = mappingAt >= 0 && mappingAt < closeLineEnd ? mappingAt - q.close : -1;
    const field = mappingField >= 0 && (plainField < 0 || mappingField < plainField) ? mappingField : plainField;
    const tail = text.slice(q.close, field >= 0 ? q.close + field : closeLineEnd);
    // A quoted value follows the same continuation rule as an unquoted one (bug r19: `"a" +\n  "b"`, shell `\`).
    const end = field >= 0 ? -1 : ValueSyntax.continuationEnd(text, keyLineStart, closeLineEnd, indent);
    if (end >= 0) return { key, start: valueStart, end, text: text.slice(valueStart, end) };
    if (LONE_TAIL_RE.test(tail) && (enclosing || !tail.includes(","))) return { key, start: q.start, end: q.end, text: q.text };
    const raw = (text.slice(valueStart, q.close) + tail).trimEnd();
    return { key, start: valueStart, end: valueStart + raw.length, text: raw };
  }

  /** A one-line value from `raw`: trailing whitespace and `,` / `;` left out; null when empty. */
  private static span(key: string, start: number, raw: string): ValueSpan | null {
    const value = raw.trimEnd().replace(/[,;]+$/, "");
    return value.length === 0 ? null : { key, start, end: start + value.length, text: value };
  }

  /**
   * End of the last continuation line after the key's line: every following line indented
   * deeper than the key's line, comment or not (bug r18); when both lines are comments the
   * comment prefixes count too (`+ # password:` / `+ #   - x`). A line that ends in a shell `\`
   * continues onto the next line whatever its indent (bug r19). Blank lines do not end it. The
   * scan starts after `fromLineEnd`. -1 when there is none. Without `indent` only `\` joins count.
   */
  private static continuationEnd(text: string, keyLineStart: number, fromLineEnd: number, indent = true): number {
    const key = ValueSyntax.prefix(text, keyLineStart, ValueSyntax.lineEnd(text, keyLineStart));
    let end = -1;
    let joined = EscapeDialect.continues(text, fromLineEnd);
    const index = TextIndex.of(text);
    for (let at = text.indexOf("\n", fromLineEnd) + 1; at > 0 && at < text.length; at = text.indexOf("\n", at) + 1) {
      if (joined) {
        // A joined run extends whatever its indent; its end is found once per text, not per key (break hunt: quadratic).
        end = index.joinedRunEnd(at, (e) => EscapeDialect.continues(text, e));
        at = end;
        joined = false;
        continue;
      }
      if (!indent) break;
      const lineEnd = ValueSyntax.lineEnd(text, at);
      const line = ValueSyntax.prefix(text, at, lineEnd);
      if (at + line.length === lineEnd && !joined) continue;
      const deeper = key.comment && line.comment ? line.length > key.length : line.indent > key.indent;
      if (!deeper && !joined) break;
      end = lineEnd;
      joined = EscapeDialect.continues(text, lineEnd);
    }
    return end;
  }

  /** A line's prefix: its full length (diff marker, indentation, comment marker), its indentation alone, and whether it is a comment. */
  private static prefix(text: string, lineStart: number, lineEnd: number): { length: number; indent: number; comment: boolean } {
    // Sticky at the line start (no slice; the prefix never crosses a line break, bug r28: speed).
    PREFIX_RE.lastIndex = lineStart;
    const m = lineStart < lineEnd ? PREFIX_RE.exec(text) : null;
    const length = m?.[0].length ?? 0;
    return { length, indent: length - (m?.[1]?.length ?? 0), comment: m?.[1] !== undefined };
  }

  /** A quoted literal at `i` (plain or JSON-escaped quotes), to its closing quote across lines; unterminated: up to whitespace. */
  private static quoted(text: string, i: number): QuotedLiteral | null {
    const escaped = text[i] === "\\" && QUOTES.includes(text[i + 1] ?? "x");
    const q = text[escaped ? i + 1 : i] ?? "";
    if (q === "" || !QUOTES.includes(q)) return null;
    const start = i + (escaped ? 2 : 1);
    for (let j = start; j < text.length; j++) {
      if (text[j] !== q) continue;
      // A JSON-escaped string ends at `\"`; a plain one at a quote that no escape character (`\`, backtick) precedes.
      const backslash = escaped ? text[j - 1] === "\\" : EscapeDialect.escapesIn(q) && EscapeDialect.escaped(text, j);
      if (escaped && backslash) return { start, end: j - 1, text: text.slice(start, j - 1), close: j + 1 };
      if (!escaped && !backslash) return { start, end: j, text: text.slice(start, j), close: j + 1 };
    }
    const end = start + (/^[^\s"'`\\]*/.exec(text.slice(start))?.[0].length ?? 0);
    return { start, end, text: text.slice(start, end), close: end };
  }

  private static lineStart(text: string, pos: number): number {
    return TextIndex.of(text).lineStart(pos);
  }

  /** Offset where the line holding `pos` ends (before `\r\n` / `\n`). */
  private static lineEnd(text: string, pos: number): number {
    return TextIndex.of(text).lineEnd(pos);
  }
}
