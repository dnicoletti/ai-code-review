const path = require("path");
const he = require("he");
const shellQuote = require("shell-quote").quote;

const core = require("./core-wrapper");
const GitHubAPI = require("./github-api");
const OpenAIAgent = require("./openai-agent");
const AnthropicAgent = require("./anthropic-agent");
const GoogleAgent = require("./google-agent");
const DeepseekAgent = require("./deepseek-agent");
const XAgent = require("./x-agent");
const PerplexityAgent = require("./perplexity-agent");
const { AI_REVIEW_COMMENT_PREFIX, SUMMARY_SEPARATOR } = require("./constants");
const { filterPatchHunks } = require("./patch-utils");

/* -------------------------------------------------------------------------- */
/*                               Sanitizers                                   */
/* -------------------------------------------------------------------------- */

function sanitizeString(value, { maxLen = 10_000, context = "none" } = {}) {
    if (value === null || value === undefined) {
        return "";
    }
    const str = String(value).trim().slice(0, maxLen);

    switch (context) {
        case "html":
            return he.encode(str, { useNamedReferences: true });
        case "shell":
            return shellQuote([str]);
        default:
            // eslint-disable-next-line no-control-regex
            return str.replace(/[\u0000-\u001F\u007F]/g, "");
    }
}

// eslint-disable-next-line no-unused-vars
function sanitizeNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const num = Number(value);
    if (Number.isNaN(num)) {
        throw new TypeError("Expected a number");
    }
    return Math.min(Math.max(num, min), max);
}

function sanitizeBool(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return /^(true|1)$/i.test(value.trim());
    }
    return Boolean(value);
}

function sanitizePath(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const str = String(value).trim();
    if (!str) {
        return "";
    }
    // eslint-disable-next-line no-control-regex
    const safe = str.replace(/[<>:"|?*\x00-\x1F]/g, "_");
    const normalized = path.posix.normalize(safe).replace(/^(\.\.(\/|\\|$))+/, "");
    return normalized === "." ? "" : normalized;
}

/* -------------------------------------------------------------------------- */
/*                               InputProcessor                               */
/* -------------------------------------------------------------------------- */

class InputProcessor {
    constructor() {
        this._repo = null;
        this._owner = null;
        this._pullNumber = null;
        this._githubToken = null;
        this._aiProvider = null;
        this._apiKey = null;
        this._model = null;
        this._failAction = true;
        this._githubAPI = null;
        this._baseCommit = null;
        this._headCommit = null;
        this._filteredDiffs = [];
        this._fileContentGetter = null;
        this._fileCommentator = null;
        this._reviewRulesFile = null;
        this._reviewRulesContent = null;
    }

    /* ----------------------------- Public API ------------------------------ */

    async processInputs() {
        this._readInputs();
        this._validateInputs();
        await this._setupGitHubAPI();
        await this._processChangedFiles();
        await this._loadReviewRules(); // Load review rules after GitHub API is set up
        this._setupReviewTools();
        return this;
    }

    /* --------------------------- Private helpers --------------------------- */

    _readInputs() {
        this._repo = sanitizeString(core.getInput("repo", { required: true, trimWhitespace: true }));
        this._owner = sanitizeString(core.getInput("owner", { required: true, trimWhitespace: true }));
        this._pullNumber = sanitizeNumber(core.getInput("pr_number", { required: true, trimWhitespace: true }), { min: 1 });
        this._githubToken = sanitizeString(core.getInput("token", { required: true, trimWhitespace: true }));
        this._aiProvider = sanitizeString(core.getInput("ai_provider", { required: true, trimWhitespace: true })).toLowerCase();
        this._apiKey = sanitizeString(core.getInput(`${this._aiProvider}_api_key`, { required: true, trimWhitespace: true }));
        this._model = sanitizeString(core.getInput(`${this._aiProvider}_model`, { required: true, trimWhitespace: true }));
        this._failAction = sanitizeBool(core.getInput("fail_action_if_review_failed"));

        this._includeExtensions = sanitizeString(core.getInput("include_extensions"));
        this._excludeExtensions = sanitizeString(core.getInput("exclude_extensions"));
        this._includePaths = sanitizePath(core.getInput("include_paths"));
        this._excludePaths = sanitizePath(core.getInput("exclude_paths"));
        this._reviewRulesFile = sanitizePath(core.getInput("review_rules_file"));

        if (!this._includeExtensions) {
            core.info("Using default: include all extensions");
        }
        if (!this._excludeExtensions) {
            core.info("Using default: exclude no extensions");
        }
        if (!this._includePaths) {
            core.info("Using default: include all paths");
        }
        if (!this._excludePaths) {
            core.info("Using default: exclude no paths");
        }

        if (!this._reviewRulesFile) {
            core.info("No custom review rules file specified.");
        }
    }

    _validateInputs() {
        if (!this._repo) {
            throw new Error("Repository name is required.");
        }
        if (!this._owner) {
            throw new Error("Owner name is required.");
        }
        if (!this._pullNumber) {
            throw new Error("Pull request number must be a valid number.");
        }
        if (!this._githubToken) {
            throw new Error("GitHub token is required.");
        }
        if (!this._aiProvider) {
            throw new Error("AI provider is required.");
        }
        if (!this._apiKey) {
            throw new Error(`${this._aiProvider} API key is required.`);
        }

        const supportedProviders = ["openai", "anthropic", "google", "deepseek", "x", "perplexity"];
        if (!supportedProviders.includes(this._aiProvider)) {
            throw new Error(`Unsupported AI provider: ${this._aiProvider}. Supported providers: ${supportedProviders.join(", ")}`);
        }
    }

    async _setupGitHubAPI() {
        this._githubAPI = new GitHubAPI(this._githubToken);
        const pullRequestData = await this._githubAPI.getPullRequest(this._owner, this._repo, this._pullNumber);
        this._headCommit = pullRequestData.head.sha;
        this._baseCommit = pullRequestData.base.sha;
    }

    async _processChangedFiles() {
        // Store original PR base before any modifications
        const originalPRBase = this._baseCommit;
        let incrementalBaseCommit = this._baseCommit;

        const comments = await this._githubAPI.listPRComments(this._owner, this._repo, this._pullNumber);
        const lastReviewComment = [...comments].reverse().find(c => c.body && c.body.startsWith(AI_REVIEW_COMMENT_PREFIX));

        if (lastReviewComment) {
            core.info(`Found last review comment: ${lastReviewComment.body.split("\n")[0]}`);
            const newBaseCommit = lastReviewComment.body
                .split(SUMMARY_SEPARATOR)[0]
                .replace(AI_REVIEW_COMMENT_PREFIX, "")
                .split(" ")[0]
                .trim();

            if (newBaseCommit) {
                incrementalBaseCommit = newBaseCommit;
                core.info(`Incremental review from ${newBaseCommit} to ${this._headCommit}`);
            }
        } else {
            core.info("Full PR review: no previous review found");
        }

        let changedFiles = await this._githubAPI.getFilesBetweenCommits(
            this._owner,
            this._repo,
            incrementalBaseCommit,
            this._headCommit
        );

        // Filter out merge-only files if doing incremental review
        if (incrementalBaseCommit !== originalPRBase) {
            changedFiles = await this._excludeMergeOnlyChanges(changedFiles, originalPRBase);
        }

        this._filteredDiffs = this._filterChangedFiles(
            changedFiles,
            this._includeExtensions,
            this._excludeExtensions,
            this._includePaths,
            this._excludePaths
        );

        core.info(`Found ${this._filteredDiffs.length} files to review after all filtering`);
    }

    /**
     * Excludes merge-only changes from incremental review at the hunk level.
     *
     * When a PR branch is synced with the target branch (e.g., merging main into the PR),
     * the incremental diff includes hunks (change blocks) from the merge commit that are
     * not part of the developer's actual changes. This method excludes those by comparing:
     *
     * 1. Incremental diff: changes since last review
     * 2. Whole PR diff: changes in the entire PR (from original base to head)
     *
     * For each file, only hunks that overlap with hunks in the whole PR are kept.
     * If a file has no overlapping hunks (all merge-only), the entire file is excluded.
     *
     * HOW THE EXCLUSION WORKS:
     *
     * A hunk is KEPT if:
     *   - It overlaps with any hunk in the whole PR diff
     *   - This means the line ranges have some intersection
     *
     * A hunk is EXCLUDED if:
     *   - It does NOT overlap with any hunk in the whole PR diff
     *   - This means the changes came from the merge commit, not the PR author
     *
     * CONCRETE EXAMPLE:
     *
     * Timeline of events:
     *   1. Commit A (developer adds feature) → AI reviews
     *   2. Commit B (merge main into PR) → brings in unrelated changes from main
     *   3. Commit C (developer fixes bug) → new changes to review
     *
     * File: utils.js
     *
     * Incremental diff (from last review to now):
     *   Hunk 1: Lines 10-15 (from Commit B - someone else added logging in main)
     *   Hunk 2: Lines 50-55 (from Commit C - developer's bug fix)
     *   Hunk 3: Lines 100-105 (from Commit B - another change merged from main)
     *
     * Whole PR diff (from PR base to PR head):
     *   Hunk A: Lines 20-25 (from Commit A - original feature)
     *   Hunk B: Lines 50-55 (from Commit C - bug fix)
     *   NOTE: Lines 10-15 and 100-105 are NOT here because they were already in main
     *
     * Filtering logic:
     *   Hunk 1 (lines 10-15): NO overlap with any whole PR hunk → EXCLUDED
     *   Hunk 2 (lines 50-55): Overlaps with Hunk B → KEPT (review this!)
     *   Hunk 3 (lines 100-105): NO overlap with any whole PR hunk → EXCLUDED
     *
     * Result: Only Hunk 2 remains for AI review (the developer's actual new change)
     *
     * FILE-LEVEL EXCLUSION:
     *   - If a file appears in incremental diff but NOT in whole PR diff → entire file EXCLUDED (merge-only file)
     *   - If all hunks in a file are excluded → entire file EXCLUDED (file touched by both developer and merge, but no new hunks to review)
     *
     * Why hunk-level filtering is needed:
     * - Without filtering, AI would review code already in the target branch
     * - More precise than file-level: handles cases where developer modifies same file as merge
     * - Wastes fewer tokens by excluding only merge-only hunks, not entire files
     * - Provides better "best effort" incremental review experience
     *
     * @param {Array} changedFiles - Files changed since last review
     * @param {string} originalPRBase - Original PR base commit (target branch)
     * @returns {Promise<Array>} Filtered list of files with filtered patches
     */
    async _excludeMergeOnlyChanges(changedFiles, originalPRBase) {
        core.info(`Filtering incremental changes against whole PR at hunk level (base: ${originalPRBase})`);

        const wholePRFiles = await this._githubAPI.getFilesBetweenCommits(
            this._owner,
            this._repo,
            originalPRBase,
            this._headCommit
        );

        // Create map of filename -> whole PR file object for fast lookup
        const wholePRFileMap = new Map(wholePRFiles.map((f) => [f.filename, f]));

        const beforeCount = changedFiles.length;
        const filteredOutFiles = [];

        // Filter files and their patches at hunk level
        const filteredFiles = changedFiles
            .map((incFile) => {
                core.debug(`Checking incremental file: ${incFile.filename}`);
                const prFile = wholePRFileMap.get(incFile.filename);

                if (!prFile) {
                    // File not in whole PR - it's merge-only
                    filteredOutFiles.push(incFile.filename);
                    core.debug(`File not in whole PR (merge-only): ${incFile.filename}`);
                    return null;
                }

                // Filter hunks within the file
                const filteredPatch = filterPatchHunks(incFile.patch, prFile.patch);

                if (!filteredPatch) {
                    // All hunks are merge-only
                    filteredOutFiles.push(incFile.filename);
                    core.debug(`All hunks in file are merge-only: ${incFile.filename}`);
                    return null;
                }

                // Return file with filtered patch
                return {
                    ...incFile,
                    patch: filteredPatch,
                };
            })
            .filter((f) => f !== null); // Remove nulls

        core.info(`Filtered ${beforeCount} incremental files to ${filteredFiles.length} files with PR-relevant hunks`);

        // Log filtered-out files at debug level for troubleshooting
        if (filteredOutFiles.length > 0) {
            core.debug(`Filtered out files/hunks: ${filteredOutFiles.join(", ")}`);
        }

        return filteredFiles;
    }

    _filterChangedFiles(changedFiles, includeExtensions, excludeExtensions, includePaths, excludePaths) {
        const toArray = str => (str ? str.split(",").map(s => s.trim()).filter(Boolean) : []);

        const incExt = toArray(includeExtensions);
        const excExt = toArray(excludeExtensions);
        const incPath = toArray(includePaths);
        const excPath = toArray(excludePaths);

        const shouldReview = file => {
            const filePath = file.filename.replace(/\\/g, "/");
            const ext = path.posix.extname(filePath);

            const extAllowed = !incExt.length || incExt.includes(ext);
            const extExcluded = excExt.includes(ext);

            const inAllowedPath = !incPath.length || incPath.some(p => filePath.startsWith(p));
            const inExcludedPath = excPath.some(p => filePath.startsWith(p));

            return extAllowed && !extExcluded && inAllowedPath && !inExcludedPath;
        };

        return changedFiles.filter(shouldReview);
    }

    async _loadReviewRules() {
        if (this._reviewRulesFile) {
            core.info(`Attempting to load review rules from: ${this._reviewRulesFile}`);
            try {
                this._reviewRulesContent = await this._githubAPI.getContent(
                    this._owner,
                    this._repo,
                    this._headCommit, // Use head commit to get the latest version of the rules file
                    this._headCommit,
                    this._reviewRulesFile
                );
                core.info("Successfully loaded review rules.");
            } catch (error) {
                core.warning(`Could not load review rules from ${this._reviewRulesFile}: ${error.message}`);
                this._reviewRulesContent = null; // Ensure it's null if loading fails
            }
        }
    }

    _setupReviewTools() {
        this._fileContentGetter = filePath =>
            this._githubAPI.getContent(this._owner, this._repo, this._baseCommit, this._headCommit, filePath);

        this._fileCommentator = async (comment, filePath, side, startLineNumber, endLineNumber) => {
            await this._githubAPI.createReviewComment(
                this._owner,
                this._repo,
                this._pullNumber,
                this._headCommit,
                comment,
                filePath,
                side,
                startLineNumber,
                endLineNumber
            );
        };
    }

    /* ----------------------------- AI agent -------------------------------- */
    getAIAgent() {
        switch (this._aiProvider) {
            case "openai":
                return new OpenAIAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "anthropic":
                return new AnthropicAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "google":
                return new GoogleAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "deepseek":
                return new DeepseekAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "x":
                return new XAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "perplexity":
                return new PerplexityAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            default:
                throw new Error(`Unsupported AI provider: ${this._aiProvider}`);
        }
    }

    /* ------------------------------ Getters -------------------------------- */

    get filteredDiffs() { return this._filteredDiffs; }
    get githubAPI() { return this._githubAPI; }
    get headCommit() { return this._headCommit; }
    get repo() { return this._repo; }
    get owner() { return this._owner; }
    get pullNumber() { return this._pullNumber; }
    get failAction() { return this._failAction; }
}

module.exports = InputProcessor;
