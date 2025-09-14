# Repository Guidelines

## Project Structure & Module Organization
- Source code lives in `src/`. Entry point: `src/server/roam-server.ts` (bundled to `build/`).
- CLI binary builds to `build/index.js` (see `bin` in `package.json`).
- MCP tools and schemas live under `src/tools/` (e.g., `src/tools/operations/*`, `src/tools/helpers/*`).
- Configuration helpers: `src/config/environment.ts` and `src/utils/*`.
- Documentation at repo root: `README.md`, `Functionality.md`, `Manifest.md`, `CHANGELOG.md`.

## Build, Test, and Development Commands
- `npm install` — install dependencies.
- `npm run build` — TypeScript compile to `build/` and set executable bit for `build/index.js`.
- `npm run watch` — compile on change (use during development).
- Run server (after build): `node build/index.js` or `npm run inspector` to launch MCP Inspector.

## Coding Style & Naming Conventions
- TypeScript, 2‑space indentation, no trailing semicolons preference left to contributor (stay consistent with nearby code).
- Filenames: kebab-case (e.g., `hierarchy-search.ts`). Types/interfaces: PascalCase. Functions/variables: camelCase. Constants: UPPER_SNAKE_CASE.
- Prefer named exports from modules. Keep modules focused; colocate types in `types/` when shared.
- Add JSDoc for public functions and all MCP tool handlers (inputs/outputs).

## Testing Guidelines
- There are no automated tests today. If adding tests, prefer lightweight unit tests (Vitest/Jest) colocated in `src/**/__tests__/` with `*.test.ts` naming.
- Keep tests deterministic; mock network and Roam API calls.

## Commit & Pull Request Guidelines
- Use Conventional Commits when possible: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, etc. Keep subjects in present tense and under 72 chars.
- PRs should include: purpose/summary, notable changes, any breaking behaviors, and basic verification steps. Link related issues. Screenshots or examples are welcome for user‑visible changes.
- Keep PRs small and focused; update `README.md` and `Functionality.md` when adding or changing MCP tools.

## Security & Configuration Tips
- Configure credentials via environment variables (loaded with `dotenv`). Add a local `.env`; never commit secrets. See `src/config/environment.ts` for expected keys.
- Rate limiting is handled in `src/utils/rate-limiter.ts`; avoid ad‑hoc sleeps and reuse helpers.

## Agent-Specific Notes
- When introducing new MCP tools, place handlers in `src/tools/operations/<tool-name>/`, define schemas in `src/tools/schemas.ts` or a dedicated file, export via `src/tools/tool-handlers.ts`, and document the tool in `README.md` and `Functionality.md`.
