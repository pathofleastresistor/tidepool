import { execFile } from 'node:child_process'

/**
 * Apps launched from Finder/Dock on macOS get a minimal PATH (/usr/bin:/bin:...), so
 * stdio servers launched with `npx`, `uvx`, `node`, etc. fail with ENOENT. Ask the
 * user's login shell for its PATH once at startup, the same trick VS Code uses.
 */
export async function loadShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const marker = '__TIDEPOOL_PATH__'
  const path = await new Promise<string | undefined>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5000, env: process.env },
      (err, stdout) => {
        if (err) return resolve(undefined)
        const match = stdout.match(new RegExp(`${marker}(.*)${marker}`))
        resolve(match?.[1])
      }
    )
  })
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
  const parts = new Set([...(path ?? process.env.PATH ?? '').split(':'), ...extra].filter(Boolean))
  process.env.PATH = [...parts].join(':')
}
