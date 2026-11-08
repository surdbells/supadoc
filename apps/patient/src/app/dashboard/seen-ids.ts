/**
 * Ids seen so far, for one API read's "New" mark. `fresh(ids)`: false on the
 * first call (the baseline: whatever the first successful read returns is not
 * new), then whether any id is new. One instance per read, fed only after that
 * read succeeds: a shared one would take its baseline from whichever read came
 * first and then flag everything the next read returns on page load.
 */
export class SeenIds {
  private readonly known = new Set<string>();
  private ready = false;

  fresh(ids: readonly string[]): boolean {
    const any = ids.some((i) => !this.known.has(i));
    for (const i of ids) this.known.add(i);
    const out = this.ready && any;
    this.ready = true;
    return out;
  }
}
