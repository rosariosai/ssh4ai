# Contributing

Thanks for considering it — this is a small homelab project, so contributing is low-ceremony.

## Getting set up

1. Fork and clone the repo
2. `cp .env.example .env`, fill in a MariaDB connection you control and a generated `ENCRYPTION_KEY`
3. `npm install`
4. `npm run dev` (uses `nodemon`) or `npm start`

Run the tests with `npm test` (Node's built-in test runner). They cover the request guards in `security.js` so far; more tests are very welcome.

## Good first areas

**Scratchpad and macros** (`public/js/app.js`) are good places to start: layout polish, keyboard handling, accessibility and tests. Secret redaction is no longer built into the app (it is delegated to an external Presidio service), so there is no redactor to contribute to.

**Everything else** is fair game too — device management, the macro system, scratchpad layouts, styling, documentation, Docker/deployment improvements. If you're unsure whether something's in scope, open an issue first and ask.

## Submitting changes

- Keep PRs focused — one feature or fix per PR is easier to review than a bundle of unrelated changes
- Explain *why*, not just *what*, in the PR description
- If your change touches the database schema (`db.js`), explain the migration path for existing installs — this project avoids forced migrations where possible (see how password encryption was rolled out as a good example: old plaintext rows keep working, new saves get encrypted)
- If your change touches security-sensitive code (password handling, auth, the encryption module), call that out explicitly in the PR description so it gets extra scrutiny

## Reporting bugs

Open an issue with: what you did, what you expected, what actually happened, and your setup (Docker/manual, MariaDB version, browser). Screenshots or terminal output help a lot.

For security issues, please avoid posting exploit details in a public issue — flag it as sensitive or reach out privately first.
