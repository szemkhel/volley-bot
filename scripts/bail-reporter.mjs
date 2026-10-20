// Stops the whole test run at the first failing test. Node 22's runner has no --test-bail, so
// without this one broken test still lets every other file run to the end before npm test exits.
// Lives outside test/ because `node --test` runs every file in a test/ folder as a test.
export default async function* bail(source) {
  for await (const event of source) {
    // A file-level failure (syntax error, missing module) also arrives as test:fail.
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    const err = details?.error?.cause ?? details?.error;
    // Written synchronously and before exit, so the reason is never lost with the process.
    process.stderr.write(
      `\nbail: stopped at the first failing test\n  ${name} (${file ?? "?"}:${line ?? "?"})\n  ${err?.stack ?? err}\n`,
    );
    process.exit(1);
  }
  yield "";
}
