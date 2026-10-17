# gcmd-command

Mock of the `gcmd` CLI used to test the Slack command runner. It installs globally as **`gcmd`** and will shadow a real `gcmd` on the same machine.

```powershell
npm i -g ./tools/gcmd-command    # from the repo root
gcmd deploy --ticket GCD-123
npm rm -g gcmd-command            # uninstall
```

| Command | Behaviour |
|---|---|
| `gcmd deploy --ticket X` | Prints build steps (one on stderr), asks `Are you sure you want to deploy X to production? [Y/n] `. `Y`/Enter → asks `Release note (optional): `, then succeeds (exit 0). `n` → cancelled (exit 1). EOF → exit 1. |
| `gcmd deploy --ticket X --fail` | Same, but fails after confirmation (exit 2). |
| `gcmd status --ticket X` | Non-interactive, prints a few lines (exit 0). |
| `--delay <ms>` | Delay between output lines (default 400). |
| anything else | Usage on stderr, exit 64. |
