/**
 * Boolean search parser and evaluator.
 *
 * Supports:
 *   - AND (explicit or implicit between terms)
 *   - OR
 *   - NOT  (prefix negation)
 *   - "quoted phrases"
 *   - Parentheses for grouping
 *
 * Examples:
 *   React AND TypeScript
 *   Python OR Java
 *   NOT junior
 *   "senior engineer"
 *   (React OR Vue) AND NOT junior
 */

// ── Token types ──────────────────────────────────────────────────────────────

type Token =
  | { type: 'TERM'; value: string }
  | { type: 'AND' }
  | { type: 'OR' }
  | { type: 'NOT' }
  | { type: 'LPAREN' }
  | { type: 'RPAREN' };

// ── AST node types ───────────────────────────────────────────────────────────

type ASTNode =
  | { kind: 'term'; value: string }
  | { kind: 'and'; left: ASTNode; right: ASTNode }
  | { kind: 'or'; left: ASTNode; right: ASTNode }
  | { kind: 'not'; child: ASTNode };

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const src = input.trim();

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i])) {
      i++;
      continue;
    }

    // Parentheses
    if (src[i] === '(') {
      tokens.push({ type: 'LPAREN' });
      i++;
      continue;
    }
    if (src[i] === ')') {
      tokens.push({ type: 'RPAREN' });
      i++;
      continue;
    }

    // Quoted phrase
    if (src[i] === '"' || src[i] === '\u201C' || src[i] === '\u201D') {
      i++; // skip opening quote
      let phrase = '';
      while (i < src.length && src[i] !== '"' && src[i] !== '\u201C' && src[i] !== '\u201D') {
        phrase += src[i];
        i++;
      }
      if (i < src.length) i++; // skip closing quote
      if (phrase) tokens.push({ type: 'TERM', value: phrase.toLowerCase() });
      continue;
    }

    // Word (could be operator or search term)
    let word = '';
    while (i < src.length && !/[\s()""\u201C\u201D]/.test(src[i])) {
      word += src[i];
      i++;
    }

    const upper = word.toUpperCase();
    if (upper === 'AND') {
      tokens.push({ type: 'AND' });
    } else if (upper === 'OR') {
      tokens.push({ type: 'OR' });
    } else if (upper === 'NOT') {
      tokens.push({ type: 'NOT' });
    } else if (word) {
      tokens.push({ type: 'TERM', value: word.toLowerCase() });
    }
  }

  return tokens;
}

// ── Parser (recursive descent) ──────────────────────────────────────────────
//
// Grammar:
//   expr     → orExpr
//   orExpr   → andExpr ('OR' andExpr)*
//   andExpr  → notExpr (('AND' | implicit) notExpr)*
//   notExpr  → 'NOT' notExpr | primary
//   primary  → TERM | '(' expr ')'

function parse(tokens: Token[]): ASTNode | null {
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }

  function consume(): Token {
    return tokens[pos++];
  }

  function parseOr(): ASTNode | null {
    let left = parseAnd();
    if (!left) return null;

    while (peek()?.type === 'OR') {
      consume(); // skip OR
      const right = parseAnd();
      if (!right) break;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  function parseAnd(): ASTNode | null {
    let left = parseNot();
    if (!left) return null;

    while (true) {
      const next = peek();
      if (!next) break;
      if (next.type === 'RPAREN' || next.type === 'OR') break;

      if (next.type === 'AND') {
        consume(); // skip explicit AND
      }
      // implicit AND: next token is TERM, NOT, or LPAREN

      const right = parseNot();
      if (!right) break;
      left = { kind: 'and', left, right };
    }
    return left;
  }

  function parseNot(): ASTNode | null {
    if (peek()?.type === 'NOT') {
      consume();
      const child = parseNot();
      if (!child) return null;
      return { kind: 'not', child };
    }
    return parsePrimary();
  }

  function parsePrimary(): ASTNode | null {
    const tok = peek();
    if (!tok) return null;

    if (tok.type === 'LPAREN') {
      consume(); // skip (
      const node = parseOr();
      if (peek()?.type === 'RPAREN') consume(); // skip )
      return node;
    }

    if (tok.type === 'TERM') {
      consume();
      return { kind: 'term', value: tok.value };
    }

    return null;
  }

  return parseOr();
}

// ── Evaluator ────────────────────────────────────────────────────────────────

function evaluate(node: ASTNode, text: string): boolean {
  switch (node.kind) {
    case 'term':
      return text.includes(node.value);
    case 'and':
      return evaluate(node.left, text) && evaluate(node.right, text);
    case 'or':
      return evaluate(node.left, text) || evaluate(node.right, text);
    case 'not':
      return !evaluate(node.child, text);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Test whether a candidate's searchable text matches a Boolean query.
 *
 * @param query   - The user-entered search string (may contain AND/OR/NOT/"quotes")
 * @param fields  - An array of string field values to search against
 * @returns true if the query matches
 */
export function booleanMatch(query: string, fields: string[]): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true; // empty query matches everything

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return true;

  const ast = parse(tokens);
  if (!ast) return true;

  // Combine all fields into one searchable string
  const text = fields.map((f) => (f ?? '').toLowerCase()).join(' \n ');
  return evaluate(ast, text);
}

/**
 * Check if a query string uses Boolean operators (for UI hints).
 */
export function hasBooleanOperators(query: string): boolean {
  return /\b(AND|OR|NOT)\b/.test(query) || /"[^"]*"/.test(query) || /[()]/.test(query);
}
