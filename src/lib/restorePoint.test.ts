import { describe, expect, it } from "vitest";
import type { RestoreResult } from "../api";
import { restoredFiles, restoreSummary, undoRestoreSummary } from "./restorePoint";

const result = (r: Partial<RestoreResult>): RestoreResult => ({ id: 1, put_back: [], removed: [], skipped: [], kept: [], ...r });
const since = 'your message "fix login"';

describe("restoreSummary", () => {
  it("says what went back, what went to the Trash and what was left alone", () => {
    expect(restoreSummary(result({ put_back: ["/p/a"], removed: ["/p/b", "/p/c"] }), since)).toBe(
      '1 file is back to how it stood before your message "fix login". 2 files Claude created were moved to the Trash.',
    );
    expect(restoreSummary(result({ put_back: ["/p/a", "/p/b"], skipped: [{ path: "/p/l", reason: "A link is in the way." }] }), since)).toBe(
      '2 files are back to how they stood before your message "fix login". 1 file was left alone: A link is in the way.',
    );
    expect(restoreSummary(result({}), since)).toBe("Nothing needed changing.");
  });
});

describe("undoRestoreSummary", () => {
  it("names files edited since the restore, which an undo leaves alone", () => {
    expect(undoRestoreSummary(result({}))).toBe("The restore is undone.");
    expect(undoRestoreSummary(result({ kept: ["/p/a"] }))).toBe("The restore is undone, except one file you edited since: it was left as it is.");
    expect(undoRestoreSummary(result({ kept: ["/p/a", "/p/b"] }))).toBe("The restore is undone, except 2 files you edited since: they were left as they are.");
  });
});

describe("restoredFiles", () => {
  it("tells Claude about put-back files and trashed ones, at most fifty", () => {
    const files = restoredFiles(result({ put_back: Array.from({ length: 60 }, (_, i) => `/p/${i}`), removed: ["/p/new"] }));
    expect(files).toHaveLength(50);
    expect(files[0]).toEqual({ path: "/p/0", trashed: false });
    expect(restoredFiles(result({ removed: ["/p/new"] }))).toEqual([{ path: "/p/new", trashed: true }]);
  });
});
