// Graded test instructions for worker prompts. Every planned test carries a complexity grade on the same scale as
// the whole-task completion grade and is written from the easiest grade upward until the coverage gate passes.

export const GRADE_SCALE = 'A (most complex), B, C, D, E (easiest)';
export const NOT_NEEDED_NOTE = 'not needed: coverage reached';

const percent = (coverage: number): string => `${coverage}%`;

/** Plan session: tasks.md must contain a graded, E-to-A ordered and marked test section. */
export function planTestInstructions(coverage: number): string {
  return 'Graded tests: tasks.md must contain a test section in which every planned test has a complexity grade ' +
    `from ${GRADE_SCALE}, and the tests are listed from E to A (easiest first). ` +
    'Mark each planned test (required) when a source criterion or spec scenario demands it, otherwise ' +
    '(coverage-only). Work sessions write tests grade by grade starting with E until the coverage gate passes at ' +
    `${percent(coverage)}; (required) tests are always written.`;
}

/** Planning review: grades, order and required marks gate specification binding. */
export function planningReviewTestInstructions(coverage: number): string {
  return 'Graded tests: report changes-required when a planned test in the tasks.md test section lacks a grade ' +
    `from ${GRADE_SCALE}, when the tests are not listed from E to A, or when a test demanded by a source ` +
    'criterion or spec scenario is not marked (required); other tests are marked (coverage-only). ' +
    `The resolved coverage threshold for the coverage gate is ${percent(coverage)}.`;
}

/** Work session: grade-by-grade writing with run_checks until the gate passes; required tests always. */
export function workTestInstructions(coverage: number): string {
  return `Graded tests (grades ${GRADE_SCALE}): write tests grade by grade starting with E, then D, C, B and A, ` +
    'following the tasks.md test section. Call run_checks after each grade and continue with the next harder ' +
    `grade until the coverage gate passes at ${percent(coverage)}. ` +
    'Tests marked (required) are always written, whatever the coverage, also in harder grades; the stop at the ' +
    'threshold applies only to (coverage-only) tests. Coverage-only grades left unwritten because the threshold ' +
    `was reached stay unchecked in tasks.md with the note \`${NOT_NEEDED_NOTE}\`; check off every written test.`;
}

/** Implementation review: coverage gate, grade order and required tests gate acceptance. */
export function implementationReviewTestInstructions(coverage: number): string {
  return `Graded tests: report changes-required when the coverage gate did not pass at ${percent(coverage)}, ` +
    'when a harder grade was written while an easier planned grade is still unchecked without the note ' +
    `\`${NOT_NEEDED_NOTE}\`, or when a test marked (required) is unwritten or carries that note.`;
}
