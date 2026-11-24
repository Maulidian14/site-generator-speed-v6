// Fast Static Site Generator v6 — the program the harness runs (`node /bot/main.ts`,
// node22). It reads every case from /input/cases.json, answers each one alone
// with run() from solve.js, and writes /output/answers.json: a JSON array of
// the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// v6's solve.js caches constant partials (rendered once per case instead of
// once per page) and finds fence closes with indexOf instead of a line walk;
// this driver serialises the answers with a manual per-value JSON builder
// instead of one bulk JSON.stringify. Measured locally, the whole run's
// fresh-process median falls from ~330 ms (v5) to ~302 ms on the practice
// cases, with byte-identical answers.

import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, and its optimising compiler off too, set
// before solve.js is imported so all of its work runs under them (the rules
// allow an entry to tune V8's flags this way). This program runs once per
// container and lives half a second: the optimising compiler's background
// threads cost more CPU than the faster code they produce ever pays back,
// and every thread's CPU counts against the entry. Measured locally,
// --no-opt alone cuts the whole run's CPU by about 14%.
setFlagsFromString('--no-opt --no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(`${INPUT_DIR}/cases.json`, 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

// Serialise without one bulk JSON.stringify: each answer is a flat
// path -> text object, so its entries are stringified one value at a time
// and joined. Byte-identical to JSON.stringify(answers) for this shape
// (all keys are non-integer strings in insertion order, all values are
// strings), and about 10% cheaper on the serialisation step.
function stringifyAnswers(answers: unknown[]): string {
  const parts: string[] = ['['];
  for (let i = 0; i < answers.length; i++) {
    if (i > 0) parts.push(',');
    parts.push('{');
    const a = answers[i] as Record<string, string>;
    let first = true;
    for (const k in a) {
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(k), ':', JSON.stringify(a[k]));
    }
    parts.push('}');
  }
  parts.push(']');
  return parts.join('');
}

writeFileSync(`${OUTPUT_DIR}/answers.json`, stringifyAnswers(answers));
