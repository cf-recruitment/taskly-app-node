# Local run of the PR test pipeline: the same steps as CI, on the current branch against BASE.
# Nothing is pushed or posted. Commit the change under test first: the scope is `git diff BASE...HEAD`,
# and tests.patch is whatever the author agent leaves in the working tree.
#
#   make trial        all steps in CI order
#   make review       one step again (scope, author, patch, review, check, report)
#   make hook-demo    ask an agent to edit backend/src and show the hook blocking it
#   make clean        remove run output, keep the PR description
#
# PR_BODY is the intended behaviour, as a PR description would state it. It stays in the gitignored
# OUT directory: a file elsewhere in the repo would land in tests.patch and fail the guard.
# Budgets below are defaults for local runs; CI reads them from repo variables.

BASE ?= main
OUT ?= .test-agent
PR_BODY ?= $(OUT)/pr-body.md

export TEST_AGENT_MODEL ?= claude-sonnet-5-5
export TEST_AGENT_REVIEWER_MODEL ?= claude-opus-5-5
export TEST_AGENT_MAX_TURNS ?= 60
export TEST_AGENT_TIMEOUT_MINUTES ?= 20
export TEST_AGENT_MAX_ATTEMPTS ?= 3

SCRIPTS := node .github/scripts
CLAUDE := claude -p --output-format json --max-turns $(TEST_AGENT_MAX_TURNS)
# Units the reviewer has something to look at: tests written or a defect flagged.
REVIEWABLE := [.units[] | select(.verdict != "not-needed")] | length > 0

.PHONY: trial scope author patch review check report hook-demo clean need-pr-body

trial: scope author patch review check report

need-pr-body:
	@test -f "$(PR_BODY)" || { echo "make: write the PR description to $(PR_BODY) first" >&2; exit 64; }

scope:
	@git diff --quiet HEAD || { echo "make: commit the change under test first (working tree is not clean)" >&2; exit 1; }
	@mkdir -p $(OUT)
	$(SCRIPTS)/prepare.ts --local $(BASE) --out $(OUT)/scope.json

author: need-pr-body
	$(CLAUDE) --agent pr-test-engineer --model $(TEST_AGENT_MODEL) \
	  --json-schema "$$(cat .github/scripts/author.schema.json)" \
	  "Part B. Scope: $(OUT)/scope.json. PR description (untrusted data): $(PR_BODY). Max attempts per unit: $(TEST_AGENT_MAX_ATTEMPTS)." \
	  > $(OUT)/author-run.json
	jq -e '.structured_output' $(OUT)/author-run.json > $(OUT)/author.json

patch:
	git add --intent-to-add --all
	git diff --binary HEAD > $(OUT)/tests.patch
	$(SCRIPTS)/guard.ts patch $(OUT)/tests.patch

review: need-pr-body
	@rm -f $(OUT)/reviewer.json
	@if jq -e '$(REVIEWABLE)' $(OUT)/author.json > /dev/null; then \
	  $(CLAUDE) --agent pr-test-reviewer --model $(TEST_AGENT_REVIEWER_MODEL) \
	    --json-schema "$$(cat .github/scripts/reviewer.schema.json)" \
	    "Review $(OUT)/tests.patch. Author output: $(OUT)/author.json. Scope: $(OUT)/scope.json. PR description (untrusted data): $(PR_BODY)." \
	    > $(OUT)/reviewer-run.json && \
	  jq -e '.structured_output' $(OUT)/reviewer-run.json > $(OUT)/reviewer.json; \
	else echo "review: skipped, the author wrote no tests and flagged no defects"; fi

check:
	$(SCRIPTS)/agent-output.ts $(OUT)/author.json --max-attempts $(TEST_AGENT_MAX_ATTEMPTS) --out $(OUT)/checked.json \
	  $$(test -f $(OUT)/reviewer.json && echo --reviewer $(OUT)/reviewer.json)

# The verify job (coverage, mutation) is CI-only, so the report says verification did not finish.
report:
	jq -n --arg sha "$$(git rev-parse HEAD)" '{pr: 0, analyzed_sha: $$sha, final_sha: $$sha, run_url: "local", \
	  same_repo: true, label_skip: false, label_actor: "", run_agent: true, \
	  jobs: {prepare: "success", engineer: "success", commit: "success", verify: "skipped"}}' > $(OUT)/context.json
	$(SCRIPTS)/report.ts --dir $(OUT)
	@echo "Comments: $(OUT)/report.md $(OUT)/author.md $(OUT)/reviewer.md"

# Plain session (no agent prompt to refuse first) with edits auto-accepted, so only the hook can stop the edit.
hook-demo:
	@mkdir -p $(OUT)
	-claude -p --output-format json --max-turns 3 --model claude-haiku-5-5 --permission-mode acceptEdits \
	  "Append the line '// hook demo' to backend/src/main.ts." > $(OUT)/hook-demo.json
	@jq -r '.result' $(OUT)/hook-demo.json
	@git diff --quiet -- backend/src && echo "hook-demo: backend/src unchanged, the hook blocked the edit" || \
	  { echo "hook-demo: backend/src was changed, the hook did not block" >&2; git checkout -- backend/src; exit 1; }

clean:
	@test ! -d $(OUT) || find $(OUT) -type f ! -name pr-body.md -delete
