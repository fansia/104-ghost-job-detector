# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Build the store-submission zip with `./build.sh`; it reads the version from `manifest.json` and only packages `manifest.json`, `icons/`, `src/` (not `store/`, `docs/`, or `README.md`).
- `store/LISTING.md` is the Chrome Web Store submission text and process log — read its top banner before touching store listing/screenshots; it tracks what's done, what's pending, and why.
- `www.104.com.tw` sits behind Cloudflare bot management. A fresh/isolated automated browser (e.g. `chrome-devtools-axi` launching its own profile) gets stuck on Cloudflare's interactive human-verification challenge and never reaches real content — this is not a signal that 104's API changed. Real screenshots of the extension's live behavior require an already-authenticated, real (non-isolated) browser session.
- Store screenshots follow a fixed anonymization method (see `docs/screenshot.png` and the `②` write-up in `store/LISTING.md`): capture the real render first, then redact identifying text (job title, company name, landmark-bearing location) in the DOM before the final screenshot — never fabricate the underlying data/numbers, only swap identifying labels for placeholders, and hide/crop 104's own branding and any real company data (e.g. browsing-history sidebars).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
