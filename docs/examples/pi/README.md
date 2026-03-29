# Pi example config files

These are example Pi config files for a local `llamabarn` / OpenAI-compatible setup.

They are **examples only** and are not loaded by NanoClaw automatically.

Current NanoClaw Pi runtime behavior:

- generates Pi settings/models config dynamically inside the container
- uses env vars such as `PI_PROVIDER`, `PI_MODEL`, `PI_BASE_URL`, and `PI_API_KEY`
- copies host `~/.pi/agent/auth.json` into the per-group Pi agent directory when needed

Files:

- `models.llamabarn.json` — example `models.json` for a local provider
- `settings.llamabarn.json` — example Pi agent settings
- `project-settings.json` — example project `.pi/settings.json`
