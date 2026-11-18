/**
 * Windows Recycle Bin pre-flight. `SendToRecycleBin` with no confirmation PERMANENTLY deletes what
 * the bin cannot take (too big, NukeOnDelete, network/removable drive) and reports no error, so we
 * decide beforehand from facts gathered by PowerShell and refuse when the bin would not keep it.
 */

export interface TrashFacts {
  /** Drive root such as `C:\`. */
  drive: string
  /** UNC root (`\\server\share`, `\\?\UNC\...`). */
  isUnc: boolean
  /** `Fixed`, `Removable`, `Network`, ... */
  driveType: string
  /** Registry `NukeOnDelete` of the volume; null when unset. */
  nukeOnDelete: boolean | null
  /** Registry `MaxCapacity` in MB; null when unset. */
  maxCapacityMb: number | null
  volumeSize: number
  freeBytes: number
  fileSize: number
  /** Length of the full path in characters. */
  pathLength: number
  /** The path starts with `\\?\` (extended-length form). */
  isExtended: boolean
}

export type TrashDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string }

const MIB = 1024 * 1024
/** Windows' default Recycle Bin size when nothing is configured. */
const DEFAULT_BIN_RATIO = 0.05
/**
 * Measured on Windows 11: a 259-character path is recycled, 260 and longer are silently deleted
 * for good by SHFileOperation. Refuse a few characters early.
 */
export const MAX_RECYCLABLE_PATH = 260
export const PATH_REFUSAL_LENGTH = MAX_RECYCLABLE_PATH - 5

export function decideWindowsTrash(facts: TrashFacts): TrashDecision {
  if (facts.isExtended) return refuse('extended-length (\\\\?\\) paths cannot be sent to the Recycle Bin')
  if (facts.pathLength >= PATH_REFUSAL_LENGTH) {
    return refuse(
      `path is ${facts.pathLength} characters, too long for the Windows Recycle Bin; use --delete-mode permanent to delete it`
    )
  }
  if (facts.isUnc) return refuse('no Recycle Bin on a network (UNC) path')
  if (facts.driveType !== 'Fixed') return refuse(`no Recycle Bin on ${facts.driveType} drive`)
  if (facts.nukeOnDelete === true) {
    return refuse(`the Recycle Bin of ${facts.drive} is set to delete files immediately (NukeOnDelete)`)
  }
  const configured = facts.maxCapacityMb !== null && facts.maxCapacityMb > 0
  const capacity = configured
    ? (facts.maxCapacityMb as number) * MIB
    : Math.min(facts.volumeSize * DEFAULT_BIN_RATIO, facts.freeBytes)
  if (facts.fileSize > capacity) {
    const mb = Math.floor(capacity / MIB)
    return refuse(
      `the file is larger than the Recycle Bin of ${facts.drive} (${mb} MB); use --delete-mode permanent to delete it`
    )
  }
  return { ok: true }
}

function refuse(reason: string): TrashDecision {
  return { ok: false, reason }
}

export function parseTrashFacts(text: string): TrashFacts {
  const raw: unknown = JSON.parse(text.trim())
  if (typeof raw !== 'object' || raw === null) throw new Error('unexpected facts output')
  const num = (key: string): number => {
    const v: unknown = Reflect.get(raw, key)
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const nullableNum = (key: string): number | null => {
    const v: unknown = Reflect.get(raw, key)
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const nuke: unknown = Reflect.get(raw, 'nukeOnDelete')
  const drive: unknown = Reflect.get(raw, 'drive')
  const driveType: unknown = Reflect.get(raw, 'driveType')
  return {
    drive: typeof drive === 'string' ? drive : '?',
    isUnc: Reflect.get(raw, 'isUnc') === true,
    driveType: typeof driveType === 'string' ? driveType : 'Unknown',
    nukeOnDelete: typeof nuke === 'number' ? nuke === 1 : typeof nuke === 'boolean' ? nuke : null,
    maxCapacityMb: nullableNum('maxCapacityMb'),
    volumeSize: num('volumeSize'),
    freeBytes: num('freeBytes'),
    fileSize: num('fileSize'),
    pathLength: num('pathLength'),
    isExtended: Reflect.get(raw, 'isExtended') === true
  }
}

/** Both scripts read the path from `$env:VCONV_TRASH_PATH`; nothing is interpolated into them. */
const GUARD_OPEN = "$ErrorActionPreference='Stop';try{"
const GUARD_CLOSE =
  "}catch{[Console]::Error.WriteLine(($_.Exception.Message -replace '\\s+',' '));exit 1}"

export const WIN_FACTS_SCRIPT =
  GUARD_OPEN +
  '$p=[System.IO.Path]::GetFullPath($env:VCONV_TRASH_PATH);' +
  '$root=[System.IO.Path]::GetPathRoot($p);' +
  "$unc=($root -match '^\\\\\\\\') -and ($root -notmatch '^\\\\\\\\\\?\\\\[A-Za-z]:');" +
  '$f=@{drive=$root;isUnc=$unc;driveType=$null;nukeOnDelete=$null;maxCapacityMb=$null;volumeSize=0;freeBytes=0;fileSize=(Get-Item -LiteralPath $p).Length;pathLength=$p.Length;' +
  "isExtended=$p.StartsWith('\\\\?\\')};" +
  "if(-not $unc -and $root -notmatch '^[A-Za-z]:\\\\'){throw ('unsupported path root '+$root)};" +
  'if(-not $unc){' +
  '$d=[System.IO.DriveInfo]::new($root);$f.driveType=$d.DriveType.ToString();$f.volumeSize=$d.TotalSize;$f.freeBytes=$d.AvailableFreeSpace;' +
  '$letter=$root.Substring(0,2);' +
  'try{$v=Get-CimInstance Win32_Volume -Filter ("DriveLetter=\'"+$letter+"\'");' +
  "if($v.DeviceID -match '(\\{[0-9a-fA-F-]+\\})'){" +
  "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\'+$Matches[1];" +
  'if(Test-Path -LiteralPath $k){$r=Get-ItemProperty -LiteralPath $k;' +
  'if($null -ne $r.NukeOnDelete){$f.nukeOnDelete=[int]$r.NukeOnDelete};' +
  'if($null -ne $r.MaxCapacity){$f.maxCapacityMb=[int64]$r.MaxCapacity}}}}catch{}' +
  '};' +
  '$f|ConvertTo-Json -Compress' +
  GUARD_CLOSE

/**
 * Recycles the file, then lists the `$I` records the Recycle Bin of the current user wrote since
 * just before the delete (base64) so the caller can check that THIS file really landed there.
 */
export const WIN_DELETE_SCRIPT =
  GUARD_OPEN +
  'Add-Type -AssemblyName Microsoft.VisualBasic;' +
  '$p=[System.IO.Path]::GetFullPath($env:VCONV_TRASH_PATH);' +
  '$t=(Get-Date).AddSeconds(-1);' +
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin');" +
  "if(Test-Path -LiteralPath $p){throw 'the file is still there after moving it to the Recycle Bin'};" +
  '$r=@{records=@();error=$null};' +
  'try{$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;' +
  "$bin=Join-Path ([System.IO.Path]::GetPathRoot($p)) ('$Recycle.Bin\\'+$sid);" +
  "$r.records=@(Get-ChildItem -LiteralPath $bin -Force -Filter '$I*' | Where-Object {$_.LastWriteTime -ge $t} | " +
  'ForEach-Object {[Convert]::ToBase64String([System.IO.File]::ReadAllBytes($_.FullName))})}' +
  "catch{$r.error=($_.Exception.Message -replace '\\s+',' ')};" +
  '$r|ConvertTo-Json -Compress' +
  GUARD_CLOSE

// ---- the Recycle Bin's `$I` records -----------------------------------------------------------

/**
 * Original path stored in a `$I` record. Version 2: int64 version, int64 size, int64 FILETIME,
 * int32 path length in chars (with the NUL), UTF-16 path. Version 1: the same header, then a fixed
 * 260-WCHAR path.
 */
export function decodeRecycleRecord(buf: Buffer): string | null {
  if (buf.length < 24) return null
  const version = Number(buf.readBigInt64LE(0))
  if (version === 2) {
    if (buf.length < 28) return null
    const chars = buf.readInt32LE(24)
    if (chars <= 0 || 28 + chars * 2 > buf.length) return null
    return buf.toString('utf16le', 28, 28 + chars * 2).replace(/\0+$/, '')
  }
  if (version === 1) {
    const raw = buf.toString('utf16le', 24, Math.min(buf.length, 24 + 520))
    const nul = raw.indexOf('\0')
    return nul < 0 ? raw : raw.slice(0, nul)
  }
  return null
}

export interface RecycleCheck {
  readonly found: boolean
  /** Why the Recycle Bin could not be read, when it could not. */
  readonly unreadable: string | null
}

const sameWindowsPath = (a: string, b: string): boolean =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

/** Reads the delete script's output and looks for a record of `fullPath`. */
export function checkRecycled(output: string, fullPath: string): RecycleCheck {
  let raw: unknown
  try {
    raw = JSON.parse(output.trim())
  } catch {
    return { found: false, unreadable: 'no readable answer from the Recycle Bin check' }
  }
  const error: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'error') : null
  const list: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'records') : null
  const records = Array.isArray(list) ? list : typeof list === 'string' ? [list] : []
  for (const entry of records) {
    if (typeof entry !== 'string') continue
    const original = decodeRecycleRecord(Buffer.from(entry, 'base64'))
    if (original !== null && sameWindowsPath(original, fullPath)) return { found: true, unreadable: null }
  }
  return { found: false, unreadable: typeof error === 'string' && error !== '' ? error : null }
}
