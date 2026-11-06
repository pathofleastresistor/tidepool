import type { Store } from './store'

const ROOT = '/memories'
/** Longest file view before Claude is asked to read it in ranges. */
const VIEW_LIMIT = 16_000
/** Longest a single memory file may grow. */
const MAX_FILE = 100_000

export interface MemoryOutcome {
  text: string
  isError?: boolean
}

class MemoryError extends Error {}

/**
 * Checks a path Claude gave and returns it in canonical form: under /memories, no `.` or `..`
 * segments, no empty segments, nothing encoded. Anything else is refused rather than cleaned up.
 */
export function memoryPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new MemoryError('Error: path is required')
  const path = raw.trim().replace(/\/+$/, '')
  if (path === ROOT) return ROOT
  if (!path.startsWith(`${ROOT}/`)) throw new MemoryError(`Error: The path ${raw} is outside ${ROOT}`)
  const segments = path.slice(ROOT.length + 1).split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[\\%\0]/.test(segment)) {
      throw new MemoryError(`Error: The path ${raw} is not allowed`)
    }
  }
  return path
}

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${(bytes / 1024 / 1024).toFixed(1)}M`

const numbered = (lines: string[], from: number): string =>
  lines.map((line, i) => `${String(from + i).padStart(6)}\t${line}`).join('\n')

/**
 * The memory tool (memory_20250818) for one project. Files live in the store, keyed by project and
 * path; directories are implied by the paths under them. Return strings follow Anthropic's
 * reference implementation, which is what Claude expects.
 */
export class ProjectMemory {
  constructor(private store: Store) {}

  run(projectId: string, input: Record<string, unknown>): MemoryOutcome {
    try {
      switch (input.command) {
        case 'view':
          return this.view(projectId, memoryPath(input.path), input.view_range)
        case 'create':
          return this.create(projectId, memoryPath(input.path), input.file_text)
        case 'str_replace':
          return this.replace(projectId, memoryPath(input.path), input.old_str, input.new_str)
        case 'insert':
          return this.insert(projectId, memoryPath(input.path), input.insert_line, input.insert_text)
        case 'delete':
          return this.delete(projectId, memoryPath(input.path))
        case 'rename':
          return this.rename(projectId, memoryPath(input.old_path), memoryPath(input.new_path))
        default:
          return { text: `Error: unknown command ${String(input.command)}`, isError: true }
      }
    } catch (err) {
      if (err instanceof MemoryError) return { text: err.message, isError: true }
      throw err
    }
  }

  private files(projectId: string): Map<string, string> {
    return new Map(this.store.memoryFiles(projectId).map((f) => [f.path, f.content]))
  }

  private isDirectory(files: Map<string, string>, path: string): boolean {
    return path === ROOT || [...files.keys()].some((p) => p.startsWith(`${path}/`))
  }

  private view(projectId: string, path: string, range: unknown): MemoryOutcome {
    const files = this.files(projectId)
    const content = files.get(path)
    if (content !== undefined) {
      const lines = content.replace(/\n$/, '').split('\n')
      let [start, end] = Array.isArray(range) && range.length === 2 ? (range as number[]) : [1, lines.length]
      if (end === -1) end = lines.length
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || start > lines.length) {
        return { text: `Error: Invalid view_range ${JSON.stringify(range)} for a file with ${lines.length} lines`, isError: true }
      }
      let body = numbered(lines.slice(start - 1, end), start)
      if (body.length > VIEW_LIMIT) {
        body = `${body.slice(0, VIEW_LIMIT)}\n[truncated: view a smaller view_range to see the rest]`
      }
      return { text: `Here's the content of ${path} with line numbers:\n${body}` }
    }
    if (!this.isDirectory(files, path)) {
      return { text: `The path ${path} does not exist. Please provide a valid path.`, isError: true }
    }
    // Up to two levels below the directory, with sizes; a directory's size is what's in it.
    const depth = (p: string): number => p.slice(path.length + 1).split('/').length
    const entries = new Map<string, number>()
    let total = 0
    for (const [p, c] of files) {
      if (!p.startsWith(`${path}/`)) continue
      const bytes = Buffer.byteLength(c)
      total += bytes
      const parts = p.slice(path.length + 1).split('/')
      for (let i = 1; i <= Math.min(parts.length, 2); i++) {
        const shown = `${path}/${parts.slice(0, i).join('/')}`
        entries.set(shown, (entries.get(shown) ?? 0) + bytes)
      }
    }
    const lines = [`${size(total)}\t${path}`]
    for (const p of [...entries.keys()].sort()) if (depth(p) <= 2 && !p.split('/').pop()!.startsWith('.')) lines.push(`${size(entries.get(p)!)}\t${p}`)
    return {
      text: `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n${lines.join('\n')}`
    }
  }

  /** Creates or overwrites, as Claude's tool description says it may. */
  private create(projectId: string, path: string, fileText: unknown): MemoryOutcome {
    if (path === ROOT) return { text: `Error: ${ROOT} is a directory`, isError: true }
    if (typeof fileText !== 'string') return { text: 'Error: file_text is required', isError: true }
    if (fileText.length > MAX_FILE) return { text: `Error: Memory files are limited to ${MAX_FILE.toLocaleString('en-US')} characters`, isError: true }
    if (this.isDirectory(this.files(projectId), path)) return { text: `Error: ${path} is a directory`, isError: true }
    this.store.writeMemory(projectId, path, fileText)
    return { text: `File created successfully at: ${path}` }
  }

  private replace(projectId: string, path: string, oldStr: unknown, newStr: unknown): MemoryOutcome {
    const content = this.store.readMemory(projectId, path)
    if (content === undefined) return { text: `Error: The path ${path} does not exist. Please provide a valid path.`, isError: true }
    if (typeof oldStr !== 'string' || !oldStr) return { text: 'Error: old_str is required', isError: true }
    const at = content.indexOf(oldStr)
    if (at === -1) {
      return { text: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`, isError: true }
    }
    if (content.indexOf(oldStr, at + 1) !== -1) {
      const lines: number[] = []
      for (let i = content.indexOf(oldStr); i !== -1; i = content.indexOf(oldStr, i + 1)) {
        lines.push(content.slice(0, i).split('\n').length)
      }
      return {
        text: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(', ')}. Please ensure it is unique`,
        isError: true
      }
    }
    const replacement = typeof newStr === 'string' ? newStr : ''
    const next = content.slice(0, at) + replacement + content.slice(at + oldStr.length)
    if (next.length > MAX_FILE) return { text: `Error: Memory files are limited to ${MAX_FILE.toLocaleString('en-US')} characters`, isError: true }
    this.store.writeMemory(projectId, path, next)
    // A few lines around the edit, so Claude can see it landed.
    const lines = next.split('\n')
    const line = next.slice(0, at).split('\n').length
    const from = Math.max(1, line - 2)
    const to = Math.min(lines.length, line + replacement.split('\n').length + 2)
    return { text: `The memory file has been edited.\n${numbered(lines.slice(from - 1, to), from)}` }
  }

  private insert(projectId: string, path: string, insertLine: unknown, insertText: unknown): MemoryOutcome {
    const content = this.store.readMemory(projectId, path)
    if (content === undefined) return { text: `Error: The path ${path} does not exist`, isError: true }
    if (typeof insertText !== 'string') return { text: 'Error: insert_text is required', isError: true }
    const lines = content.split('\n')
    if (typeof insertLine !== 'number' || !Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
      return {
        text: `Error: Invalid \`insert_line\` parameter: ${String(insertLine)}. It should be within the range of lines of the file: [0, ${lines.length}]`,
        isError: true
      }
    }
    lines.splice(insertLine, 0, insertText.replace(/\n$/, ''))
    const next = lines.join('\n')
    if (next.length > MAX_FILE) return { text: `Error: Memory files are limited to ${MAX_FILE.toLocaleString('en-US')} characters`, isError: true }
    this.store.writeMemory(projectId, path, next)
    return { text: `The file ${path} has been edited.` }
  }

  private delete(projectId: string, path: string): MemoryOutcome {
    if (path === ROOT) return { text: `Error: ${ROOT} itself can't be deleted`, isError: true }
    if (this.store.deleteMemory(projectId, path) === 0) return { text: `Error: The path ${path} does not exist`, isError: true }
    return { text: `Successfully deleted ${path}` }
  }

  private rename(projectId: string, from: string, to: string): MemoryOutcome {
    if (from === ROOT || to === ROOT) return { text: `Error: ${ROOT} itself can't be renamed`, isError: true }
    const files = this.files(projectId)
    if (!files.has(from) && !this.isDirectory(files, from)) return { text: `Error: The path ${from} does not exist`, isError: true }
    if (files.has(to) || this.isDirectory(files, to)) return { text: `Error: The destination ${to} already exists`, isError: true }
    if (to.startsWith(`${from}/`)) return { text: `Error: Can't move ${from} inside itself`, isError: true }
    this.store.renameMemory(projectId, from, to)
    return { text: `Successfully renamed ${from} to ${to}` }
  }
}
