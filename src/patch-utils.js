const { parsePatch } = require("diff");
const core = require("./core-wrapper");

/**
 * Checks if two hunks overlap based on line ranges in the new file.
 *
 * @param {import('diff').StructuredPatchHunk} hunk1 - First hunk (from diff library)
 * @param {import('diff').StructuredPatchHunk} hunk2 - Second hunk (from diff library)
 * @returns {boolean} True if hunks overlap
 */
function hunksOverlap(hunk1, hunk2) {
    // diff library provides: oldStart, oldLines, newStart, newLines
    const h1Start = hunk1.newStart;
    const h1End = hunk1.newStart + hunk1.newLines - 1;
    const h2Start = hunk2.newStart;
    const h2End = hunk2.newStart + hunk2.newLines - 1;

    // Overlaps if: h1Start <= h2End AND h2Start <= h1End
    //
    // Visual examples:
    //
    // OVERLAP (partial):        OVERLAP (h1 contains h2):
    //   h1: [====]                 h1: [==========]
    //   h2:    [====]              h2:    [====]
    //
    // OVERLAP (h2 contains h1):  NO OVERLAP (h1 before h2):
    //   h1:    [====]              h1: [====]
    //   h2: [==========]           h2:          [====]
    //
    // The condition catches all overlap cases and excludes non-overlapping ranges.
    const overlaps = h1Start <= h2End && h2Start <= h1End;

    if (overlaps) {
        core.debug(`hunksOverlap: Hunks overlap - [${h1Start}-${h1End}] overlaps with [${h2Start}-${h2End}]`);
    }

    return overlaps;
}

/**
 * Reconstructs a patch string from filtered hunks.
 *
 * @param {Array<import('diff').StructuredPatchHunk>} hunks - Array of hunk objects from diff library
 * @returns {string} Reconstructed patch string
 */
function reconstructPatch(hunks) {
    return hunks
        .map((hunk) => {
            // Reconstruct hunk header
            const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

            // Hunk lines already include +/- prefixes and spaces
            const lines = hunk.lines;

            return [header, ...lines].join("\n");
        })
        .join("\n");
}

/**
 * Filters hunks from incrementalPatch to only include those that overlap
 * with hunks in wholePRPatch.
 *
 * This is used during incremental reviews to exclude hunks that came from
 * merge commits (syncing target branch into PR branch).
 *
 * @param {string} incrementalPatch - Patch from incremental diff
 * @param {string} wholePRPatch - Patch from whole PR diff
 * @returns {string|null} Filtered patch string or null if no relevant hunks
 */
function filterPatchHunks(incrementalPatch, wholePRPatch) {
    if (!incrementalPatch) {
        core.debug("filterPatchHunks: incrementalPatch is empty, returning null");
        return null;
    }

    // Parse both patches using diff library's parsePatch
    const incrementalPatches = parsePatch(incrementalPatch);
    const wholePRPatches = parsePatch(wholePRPatch);

    core.debug(`filterPatchHunks: Parsed ${incrementalPatches.length} incremental patches, ${wholePRPatches.length} whole PR patches`);

    // Handle edge cases
    if (!incrementalPatches[0] || !incrementalPatches[0].hunks || incrementalPatches[0].hunks.length === 0) {
        core.debug("filterPatchHunks: No hunks in incremental patch, returning as-is");
        return incrementalPatch; // No hunks to filter
    }

    if (!wholePRPatches[0] || !wholePRPatches[0].hunks || wholePRPatches[0].hunks.length === 0) {
        core.debug("filterPatchHunks: No hunks in whole PR patch, file is merge-only");
        return null; // File is merge-only (not in whole PR)
    }

    const incrementalHunks = incrementalPatches[0].hunks;
    const wholePRHunks = wholePRPatches[0].hunks;

    core.debug(`filterPatchHunks: Comparing ${incrementalHunks.length} incremental hunks against ${wholePRHunks.length} whole PR hunks`);

    // Filter: keep incremental hunks that overlap with any whole PR hunk
    const filteredHunks = incrementalHunks.filter((incHunk) => {
        const hasOverlap = wholePRHunks.some((prHunk) => hunksOverlap(incHunk, prHunk));
        if (!hasOverlap) {
            core.debug(`filterPatchHunks: Hunk at lines ${incHunk.newStart}-${incHunk.newStart + incHunk.newLines - 1} has no overlap, filtering out`);
        }
        return hasOverlap;
    });

    core.debug(`filterPatchHunks: Filtered ${incrementalHunks.length} hunks to ${filteredHunks.length} hunks`);

    if (filteredHunks.length === 0) {
        core.debug("filterPatchHunks: All hunks filtered out, returning null");
        return null; // All hunks are merge-only
    }

    // Reconstruct patch from filtered hunks
    const reconstructed = reconstructPatch(filteredHunks);
    core.debug(`filterPatchHunks: Reconstructed patch with ${filteredHunks.length} hunks`);
    return reconstructed;
}

module.exports = {
    filterPatchHunks,
};
