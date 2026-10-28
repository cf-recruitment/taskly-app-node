// Line-by-line text scanning driven by a rule table.

export type LineRule<State> = { pattern: RegExp; apply: (state: State, match: RegExpExecArray) => void };

// For each line, the first rule whose pattern matches handles it; other lines are ignored.
export function scanLines<State>(text: string, rules: readonly LineRule<State>[], state: State): State {
  for (const line of text.split('\n')) {
    for (const { pattern, apply } of rules) {
      const match = pattern.exec(line);
      if (match) {
        apply(state, match);
        break;
      }
    }
  }
  return state;
}
