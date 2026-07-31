/**
 * Build an env record that ensures `$HOME/.local/bin` is on PATH.
 *
 * Per-user CLI installs (fabric, notebooklm, markitdown, yt-dlp, ...) commonly
 * live in `$HOME/.local/bin`, but that directory is not on the default PATH
 * for cron, sudo, or service invocations. The bash wrapper scripts prepend
 * it before invoking tsx; this helper does the same inside Node so spawn /
 * execFile calls made by the TypeScript runtime always see those binaries,
 * regardless of how the process was started.
 */
export function envWithHomeLocalBin(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") env[k] = v;
  }
  env.PATH = withHomeLocalBin(env.PATH, env.HOME);
  return env;
}

function withHomeLocalBin(
  pathValue: string | undefined,
  homeValue: string | undefined,
): string {
  const homeBin = homeValue ? `${homeValue}/.local/bin` : "";
  const entries = (pathValue ?? "").split(":").filter((e) => e.length > 0);
  if (homeBin.length === 0) {
    return entries.join(":");
  }
  const filtered = entries.filter((e) => e !== homeBin);
  filtered.unshift(homeBin);
  return filtered.join(":");
}
