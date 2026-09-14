# `.launch.json` — the config file

Every flag can live in a JSON file instead of the command line, so the launch settings for a
repository are committed once and everybody who runs the gate runs it the same way.

    node scripts/pre-launch.mjs --config <path to .launch.json> --dir <repo>

The conventional place is `.launch.json` in the repository root. The path is not magic — the file
is read only when `--config` names it — so a repository may keep several (one per environment) and
name the one it wants.

**Precedence:** config file values first, then command-line flags. A flag always wins, so
`--skip-build` or `--strict` on the command line overrides whatever the file says.

---

## Schema

Keys are the flag names without the leading `--`.

| Key | Type | Default | Means |
|---|---|---|---|
| `production-url` | string | — | **Required for a gate run.** The url the site will live at. Every host comparison in the gate is against this. |
| `predecessor-url` | string | none | The site being replaced. Enables the three `predecessor` checks and the `gsc-baseline` human item. Must be reachable. |
| `build-dir` | string | auto | The build output directory. Auto-detected in order: `dist`, `out`, `build`, `_site`, `public` (only when it holds an `index.html`), `.next`. |
| `required-env` | string[] | `[]` | Environment variables the production build needs. Each must be defined in the environment, in `.env.production`, or in `.env`. |
| `dev-host` | string[] | `[]` | Extra staging or preview hostnames that must not appear in the build. The built-in list already covers `localhost`, `127.0.0.1`, `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, `staging.`, `dev.` and `.local`. |
| `strict` | boolean | `false` | Raise `placeholders.source-maps` from advisory to blocker. The only severity any option may move. |
| `skip-build` | boolean | `false` | Do not run the build; inspect the output already on disk. Use it only when you have just built. |
| `dir` | string | `.` | The repository to gate. |
| `out` | string | auto | Write the bundle here instead of `./website-launch/<slug>-pre-launch-<date>`. |

---

## Example

```json
{
  "production-url": "https://ridgeline-survey.example",
  "predecessor-url": "https://old.ridgeline-survey.example",
  "build-dir": "dist",
  "required-env": ["PUBLIC_SITE_URL", "PUBLIC_ANALYTICS_ID", "FORM_ENDPOINT"],
  "dev-host": ["ridgeline.internal", "preview.ridgeline-survey.example"],
  "strict": true
}
```

---

## What belongs in it, and what does not

**Put in it** the facts about this launch that do not change between runs: the production url, the
predecessor, the build directory if it is unusual, the environment variables the build needs, and
any internal hostname the built-in dev-host list would not know about.

**Leave out** `skip-build`. It is a convenience for a run you have just built for, and committing
it means the next person's gate run silently inspects a stale `dist` — the exact failure the build
ordering exists to prevent.

**Never put a secret in it.** This file is committed. `required-env` holds variable *names*, never
values; the values belong in the hosting project's environment and in an uncommitted
`.env.production`. `hygiene.env-tracked` and `hygiene.secrets-committed` exist because this mistake
is common and expensive.
