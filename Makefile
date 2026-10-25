# Release automation. `make release-*` cuts and pushes a release tag, which
# triggers the GitHub Actions 'release' workflow (.github/workflows/release.yml):
# typecheck + compile + unit tests + `vsce package`, a guard that the tag matches
# package.json, a GitHub Release with the .vsix and checksums, and a Marketplace
# publish via the VSCE_PAT repository secret. Tags are strictly vX.Y.Z (no
# pre-releases; see the Versioning section in CONTRIBUTING.md). Pick the
# version one of two ways:
#   make release-patch | release-minor | release-major  -- bump from the latest tag
#   make release VERSION=vX.Y.Z                        -- explicit override
# Before touching the remote it runs the same checks CI runs (lint,
# typecheck + unit tests) so a broken tree never gets a tag, verifies
# CHANGELOG.md already has a section for the new version (Keep a Changelog
# discipline), and asks y/N.
.PHONY: release release-patch release-minor release-major

release-patch:
	@$(MAKE) --no-print-directory release LEVEL=patch

release-minor:
	@$(MAKE) --no-print-directory release LEVEL=minor

release-major:
	@$(MAKE) --no-print-directory release LEVEL=major

release:
	@set -e; \
	[ "$$(git symbolic-ref --short HEAD)" = main ] || { echo "not on main"; exit 1; }; \
	git fetch -q origin main; \
	[ "$$(git rev-list --count HEAD..origin/main)" -eq 0 ] || { echo "local main is behind origin/main; sync first"; exit 1; }; \
	status=$$(git status --porcelain); \
	[ -z "$$status" ] || { echo "working tree not clean:"; printf '%s\n' "$$status" | sed 's/^/    /'; exit 1; }; \
	latest=$$(git describe --tags --abbrev=0 2>/dev/null) || { echo "no tags found; use: make release VERSION=vX.Y.Z"; exit 1; }; \
	base=$${latest#v}; \
	major=$${base%%.*}; rest=$${base#*.}; minor=$${rest%%.*}; patch=$${rest##*.}; \
	if [ -n "$(VERSION)" ]; then \
		newtag=v$$(printf '%s' "$(VERSION)" | sed 's/^v//'); \
	elif [ -n "$(LEVEL)" ]; then \
		case "$(LEVEL)" in \
			patch) patch=$$((patch+1)); newtag=v$$major.$$minor.$$patch ;; \
			minor) minor=$$((minor+1)); newtag=v$$major.$$minor.0 ;; \
			major) major=$$((major+1)); newtag=v$$major.0.0 ;; \
			*) echo "bad LEVEL=$(LEVEL)"; exit 1 ;; \
		esac; \
	else \
		echo "usage: make release-{patch,minor,major}  |  make release VERSION=vX.Y.Z"; exit 1; \
	fi; \
	printf '%s\n' "$$newtag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "invalid tag '$$newtag' (want vX.Y.Z, stable releases only)"; exit 1; }; \
	(git rev-parse -q --verify "refs/tags/$$newtag" >/dev/null) && { echo "$$newtag already exists"; exit 1; } || true; \
	newver=$${newtag#v}; \
	grep -qF "## [$$newver]" CHANGELOG.md || { echo "CHANGELOG.md has no '## [$$newver]' section -- write it first"; exit 1; }; \
	echo "preflight  : npm run lint + typecheck + npm test (what CI runs)"; \
	if ! out=$$(npm run lint 2>&1 && npm run typecheck 2>&1 && npm test 2>&1); then \
		printf '%s\n' "$$out" | tail -30; \
		echo "aborting: preflight failed"; \
		exit 1; \
	fi; \
	echo "latest tag : $$latest"; \
	echo "new tag    : $$newtag"; \
	echo "main HEAD  : $$(git rev-parse --short HEAD) - $$(git log -1 --format='%s')"; \
	if git rev-parse -q --verify origin/main >/dev/null 2>&1; then \
		echo "commits to push to main (plus the release commit):"; \
		pending=$$(git log origin/main..HEAD --oneline); \
		if [ -n "$$pending" ]; then printf '%s\n' "$$pending" | sed 's/^/    /'; else echo "    (none; main is up to date)"; fi; \
	else echo "commits to push to main: (origin/main unknown)"; fi; \
	echo "Pushing will trigger the 'release' GitHub Actions workflow."; \
	printf "Push main + tag %s? [y/N] " "$$newtag"; read ans; \
	case "$$ans" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1;; esac; \
	npm version "$$newver" --no-git-tag-version >/dev/null; \
	git add package.json package-lock.json; \
	git commit -q -m "chore(release): prepare $$newtag" \
		-m "Bump package.json and package-lock.json to $$newver. The tag triggers the release workflow: vsce package, GitHub Release with the .vsix and checksums, then a Marketplace publish."; \
	git tag -a "$$newtag" -m "Release $$newtag"; \
	git push --atomic origin main "$$newtag" || { echo "push failed; local undo: git tag -d $$newtag && git reset --hard HEAD~1"; exit 1; }
