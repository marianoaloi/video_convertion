/**
 * Loaded with `node --import` into the CLI process by the scale test: writes the process's
 * `resourceUsage()` (maxRSS in KiB) to `$VCONV_IT_RSS_FILE` when it exits.
 */
import { writeFileSync } from 'node:fs'

const target = process.env['VCONV_IT_RSS_FILE']
if (target !== undefined && target !== '') {
  process.on('exit', () => {
    writeFileSync(target, JSON.stringify(process.resourceUsage()))
  })
}
