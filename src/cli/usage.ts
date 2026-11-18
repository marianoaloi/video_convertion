import { DEFAULTS } from '../types.js'

/** The full `--help` text. Kept apart from the parser so each file stays small. */
export function usage(): string {
  const d = DEFAULTS
  return `vconv - batch video converter (ffmpeg), for Windows and Linux

USAGE
  vconv [options] <path...>
  vconv --tools [--json]

  <path> is a folder, a video file or a .json job file. Several paths can be given.
  A video with a "<video>.json" job file (made by the VideoEditor app) is cut/cropped
  as the job says; any other video is converted whole.

INPUTS
  -r, --recursive            Descend into sub-folders (skips dot-folders, ruimFolder,
                             $RECYCLE.BIN, System Volume Information and lost+found)
      --source <mode>        auto | json | force            (default: ${d.source})
                               auto  = use the job file when there is one, else convert whole
                               json  = only process videos that have a job file
                               force = convert every video whole, ignore job files
      --force                Same as --source force
      --ext <list>           Video extensions, e.g. mp4,mkv,avi (default: the built-in list)

PROCESSING
  -j, --parallel <n>         Videos converted at the same time, 1..${d.maxParallel}   (default: ${d.parallel})
      --ffmpeg <path>        ffmpeg file or the folder that contains it (default: PATH, or $VCONV_FFMPEG)
      --ffprobe <path>       ffprobe file or folder                    (default: PATH, or $VCONV_FFPROBE)
      --encoders <list>      H.264 encoders to try in order            (default: ${d.encoders.join(',')})
      --hwaccel <mode>       none | auto | cuda  (GPU decoding)        (default: ${d.hwaccel})
                             Consumer NVIDIA GPUs allow only about 5-8 NVENC sessions: with a
                             higher -j the extra jobs fall back to libx264 automatically.
      --cpu                  Same as --hwaccel none
      --same-size            Keep the source resolution (no --max-side cap)
      --max-side <px>        Longest side of the output                (default: ${d.maxSide})
      --max-rate <kbps>      Video bitrate cap                         (default: ${d.maxRateKbps})
      --min-output-bytes <n> An output smaller than this is a failure  (default: ${d.minOutputBytes})
      --keep-parts           Keep the cut parts of a concat job
      --ignore-errors        Do not print ffmpeg's error output (it stays in the job log;
                             a failing job still fails)
      --verbose-ffmpeg       Run ffmpeg without "-loglevel error"
      --stall-timeout <min>  Kill an ffmpeg step with no progress for this long, 0 = off (default: ${d.stallTimeoutMs / 60_000})
      --hook-timeout <sec>   Kill an upload command after this long, 0 = no limit (default: ${d.hookTimeoutMs / 1000})

WHOLE-VIDEO SETTINGS (videos without a job file, and --force)
      --size <WxH|W:H|-1>    Output size, e.g. 640x360 (-1 = source size)
      --rate <kbps>          Video bitrate (default: source bitrate capped by --max-rate)
      --crop <x:y:w:h>       Crop rectangle in source pixels
      --bright <-1..1>       Brightness
      --contrast <-4..4>     Contrast (1 = neutral)
      --transpose <deg>      Rotation in degrees, a multiple of 90
      --convert-first        Re-encode the whole source to clean H.264/MP4 first

OUTPUTS
      --existing <policy>    skip | rename | replace                   (default: ${d.existing})
                               when the output file already exists

AFTER SUCCESS
      --delete-original      Delete the source video (and its .json) after a verified
                             success. OFF by default.
      --delete-mode <mode>   trash | permanent                         (default: ${d.deleteMode})
      --upload "<command>"   Run a command per video after success (before deleting)
      --upload-all "<command>"  Run a command once with every output when the run ends
                             Placeholders (write {{ and }} for literal braces):
                               {file}    the SOURCE video path
                               {outputs} all outputs of that video; as its own word it expands
                                         to one argument per output
                               {files}   every output of the run (--upload-all only)
                               {dir}     folder of the source video
                               {root}    input root the video was found under
                               {md5}     MD5 of the SOURCE video
                             --upload gets: {file} {outputs} {dir} {root} {md5}
                             --upload-all gets: {outputs} {files} {dir}
                             A template with any other placeholder is rejected (exit 2), and so
                             is a .bat/.cmd command (use an .exe, or
                             powershell -NoProfile -File script.ps1 {outputs}).
                             Do not put secrets in the command line: set them as environment
                             variables, which the hooks inherit.
      --move-orphans         Move orphan/empty job files to <root>/${d.ruimFolder}/

REPORTING AND RESUME
      --state <file>         Ledger of converted videos (default: see below)
      --no-state             Do not remember converted videos: the next run converts everything again
      --log-file <file>      Append every log line to this file
      --no-failure-log       Do not write "<video>.log" next to a failed video
      --dry-run              Print the ffmpeg commands, run nothing, touch no file
      --list                 Scan and count only
      --json                 Events as JSON lines on stdout (nothing else on stdout)
      --plain                One line per event, no live panel (default when not a terminal)
  -q, --quiet                Only errors and the final summary
      --verbose              Also print info lines and ffmpeg stderr
      --tools                Show ffmpeg/ffprobe paths and versions, H.264 encoders, hwaccels
  -h, --help                 Show this help
  -v, --version              Show the version

RESUME LEDGER
  vconv remembers every video it converted, so a rerun skips them. The ledger is
  kept per user (override with --state <file>, turn off with --no-state):
    Windows  %LOCALAPPDATA%\\vconv\\state.jsonl
    Linux    $XDG_STATE_HOME/vconv/state.jsonl, else ~/.local/state/vconv/state.jsonl
    macOS    ~/Library/Application Support/vconv/state.jsonl
  The ledger skips already-converted videos even with --existing rename|replace;
  use --no-state to convert them again.
  --dry-run reads the ledger (done videos show as skipped) but never writes it.

EXIT CODES
  0   every job finished (skipped videos are fine)
  1   at least one job failed (invalid or orphan job files are reported but do not
      change the exit code)
  2   usage error, an input path that does not exist, or ffmpeg/ffprobe not found
  130 interrupted

SIGNALS
  Ctrl+C once = stop launching new jobs; twice = kill the running jobs; three times =
  force quit. SIGTERM, SIGHUP and Ctrl+Break kill the running jobs at once.

EXAMPLES
  PowerShell:  vconv -r -j 4 D:\\Videos
  cmd:         vconv --ffmpeg "C:\\Program Files\\ffmpeg\\bin" -r "D:\\My Videos"
  Linux:       vconv --ffmpeg /opt/ffmpeg/bin -r --delete-original --state ~/vconv.state /data/videos
  Count only:  vconv --list -r .
  CPU only:    vconv --cpu --encoders libx264 -r ./clips
  Upload:      vconv -r --upload "rclone copy {outputs} remote:videos" ./clips
  Pipe events: vconv --json -r ./clips > events.ndjson
`
}
