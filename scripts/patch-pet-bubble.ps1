<#
.SYNOPSIS
  dsh-thought-bubble: make the pet's activity bubble show one line of the thinking.

.DESCRIPTION
  Patches Coopanion's bundled cortico-world-desktop-pet:

    src/status.ts  - collect reasoning deltas into the kind='think' status
    web/pet.css    - let the 'think' bubble show that line (icon + one-line clamp)

  It patches the *activity* bubble (status), not the speech bubble:
    - never enters chat history or the conversation context;
    - never goes through say/said, so TTS (fatfish and friends) never reads it;
    - the text clears as soon as she starts answering, and dialogue takes the bubble.

  A Coopanion upgrade overwrites node_modules; run this script again after upgrading.
  Use -Revert to restore the .bak-thoughts backups.

.PARAMETER PetRoot
  Directory of cortico-world-desktop-pet.

.PARAMETER Revert
  Restore the backups.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File patch-pet-bubble.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File patch-pet-bubble.ps1 -Revert
#>
param(
  [string]$PetRoot = 'D:\Coopanion-Setup-0.2.8\resources\app\node_modules\cortico-world-desktop-pet',
  [switch]$Revert
)

$ErrorActionPreference = 'Stop'
$marker = 'dsh-thought-bubble'
$statusPath = Join-Path $PetRoot 'src/status.ts'
$cssPath = Join-Path $PetRoot 'web/pet.css'

foreach ($file in @($statusPath, $cssPath)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Host file not found: $file (pass -PetRoot pointing at cortico-world-desktop-pet)" }
}

function Get-Normalized([string]$path) {
  $raw = [IO.File]::ReadAllText($path)
  [pscustomobject]@{ Text = ($raw -replace "`r`n", "`n"); Crlf = $raw.Contains("`r`n") }
}

function Save-Normalized([string]$path, [string]$text, [bool]$crlf) {
  $out = if ($crlf) { $text -replace "`n", "`r`n" } else { $text }
  [IO.File]::WriteAllText($path, $out, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Revert) {
  foreach ($file in @($statusPath, $cssPath)) {
    $backup = "$file.bak-thoughts"
    if (Test-Path -LiteralPath $backup) {
      Copy-Item -LiteralPath $backup -Destination $file -Force
      Remove-Item -LiteralPath $backup -Force
      Write-Host "restored: $file"
    } else {
      Write-Warning "no backup, skipped: $file"
    }
  }
  Write-Host 'Revert done. Restart Coopanion to take effect.'
  return
}

$statusPairs = @(
  @{
    Old = @'
const THINK: PetStatus = { kind: 'think', text: '' };
'@
    New = @'
const THINK: PetStatus = { kind: 'think', text: '' };
/**
 * dsh-thought-bubble: raw window kept from the reasoning stream (tail); display picks one sentence.
 * Local patch, not upstream; see coopanion-world-thoughts/scripts/patch-pet-bubble.ps1.
 */
const THOUGHT_MAX = 400;
/** dsh-thought-bubble: longest sentence the bubble shows; longer ones are trimmed at a clause/word edge, no ellipsis. */
const THOUGHT_SHOW_MAX = 60;
/**
 * dsh-thought-bubble: binding marker shared with coopanion-world-thoughts.
 * The plugin sets it while running; `zh` is the latest translated Chinese, `fallback` keeps the
 * bubble non-empty before the first translation. Without it (plugin off) or while paused, only the icon shows.
 */
const BUBBLE_KEY = Symbol.for('dsh.thoughts.bubble');

type ThoughtBubbleState = { paused?: boolean; zh?: string; fallback?: string };

function thoughtBubble(): ThoughtBubbleState | undefined {
  return (globalThis as unknown as Record<symbol, ThoughtBubbleState | undefined>)[BUBBLE_KEY];
}

/**
 * dsh-thought-bubble: the last complete sentence of the reasoning, i.e. what she is thinking about.
 *
 * Pure text, no model call and no tokens. Chinese and English enders both split (`。！？!?…`;
 * `.` only when followed by whitespace/quote/end), and newlines split too. A very short last
 * sentence ("End turn.") steps back to a longer one; an over-long one is cut at its last clause,
 * then at a word edge, never with an ellipsis.
 */
export function lastThoughtSentence(text: string, max = THOUGHT_SHOW_MAX): string {
  const sentences: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    buf += ch;
    const ender = '。！？!?…'.includes(ch);
    // an English period ends a sentence only before whitespace, a quote or the end; keeps e.g. / 2.0 whole
    const dot = ch === '.' && (i + 1 >= text.length || /[\s"'”’)\]]/.test(text.charAt(i + 1)));
    if (ender || dot || ch === '\n') {
      const line = buf.trim();
      if (line) sentences.push(line);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) sentences.push(tail);
  if (!sentences.length) return '';
  let picked = sentences[sentences.length - 1];
  // the tail is often "End turn."; step back to a sentence of at least 6 chars when there is one
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].length >= 6) {
      picked = sentences[i];
      break;
    }
  }
  return fitThought(picked, max);
}

/** dsh-thought-bubble: trim one sentence to fit, at the last clause then at a word edge, never with an ellipsis. */
function fitThought(sentence: string, max: number): string {
  let picked = sentence.trim();
  if (picked.length <= max) return picked;
  const clauses = picked.split(/(?<=[，,；;、—–])\s*/).filter((part) => part.trim());
  if (clauses.length) picked = clauses[clauses.length - 1].trim();
  if (picked.length > max) {
    const tail = picked.slice(-max);
    const space = tail.search(/\s/);
    picked = space > 0 && space < max / 2 ? tail.slice(space + 1) : tail;
  }
  return picked.trim();
}
'@
  }
  @{
    Old = @'
  private readonly started = new Map<string, number>();
  private current: PetStatus | null = null;
'@
    New = @'
  private readonly started = new Map<string, number>();
  private current: PetStatus | null = null;
  /** dsh-thought-bubble: reasoning collected this round (tail, see THOUGHT_MAX); bubble only, never dialogue. */
  private thought = '';
'@
  }
  @{
    Old = @'
      case 'idle':
        this.calls.clear();
        this.started.clear();
        this.running = [];
        this.round = undefined;
        this.set(null);
        return;
      case 'backoff':
      case 'handoff':
        this.noteRunning(phase.running);
        this.set(THINK);
        return;
      default:
        // a new round's request starts from thinking; the calls of the round before are done with
        if (phase.round !== this.round) { this.round = phase.round; this.calls.clear(); this.started.clear(); }
        this.noteRunning(phase.running);
        this.update();
'@
    New = @'
      case 'idle':
        this.calls.clear();
        this.started.clear();
        this.running = [];
        this.round = undefined;
        this.thought = '';
        this.set(null);
        return;
      case 'backoff':
      case 'handoff':
        this.noteRunning(phase.running);
        this.set(this.think());
        return;
      default:
        // a new round's request starts from thinking; the calls of the round before are done with
        if (phase.round !== this.round) { this.round = phase.round; this.calls.clear(); this.started.clear(); this.thought = ''; }
        this.noteRunning(phase.running);
        this.update();
'@
  }
  @{
    Old = @'
  onEvent(event: StreamEvent): void {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
'@
    New = @'
  onEvent(event: StreamEvent): void {
    // dsh-thought-bubble: reasoning deltas go into the activity bubble; clear on the first answer text.
    if (event.type === 'response.reasoning.delta' || event.type === 'response.reasoning_summary_text.delta') {
      const delta = (event as { delta?: unknown }).delta;
      if (typeof delta === 'string' && delta) {
        this.thought = (this.thought + delta).slice(-THOUGHT_MAX);
        if (this.state === 'model') this.set(this.think());
      }
      return;
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (this.thought) {
        this.thought = '';
        if (this.state === 'model') this.set(this.think());
      }
      return;
    }
    if (event.type === 'response.reasoning.done' || event.type === 'response.reasoning_summary_text.done') {
      // endpoints that send done without deltas still get one line
      const text = (event as { text?: unknown }).text;
      if (!this.thought && typeof text === 'string' && text) {
        this.thought = text.slice(-THOUGHT_MAX);
        if (this.state === 'model') this.set(this.think());
      }
      return;
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
'@
  }
  @{
    Old = @'
  clear(): void {
    this.calls.clear();
    this.round = undefined;
    this.set(null);
  }
'@
    New = @'
  clear(): void {
    this.calls.clear();
    this.round = undefined;
    this.thought = '';
    this.set(null);
  }
'@
  }
  @{
    Old = @'
    const lead = run[0]?.status;
    if (!last || !lead) { this.set(calls.at(-1)?.done ? null : THINK); return; }
'@
    New = @'
    const lead = run[0]?.status;
    if (!last || !lead) { this.set(calls.at(-1)?.done ? null : this.think()); return; }
'@
  }
  @{
    Old = @'
  private set(status: PetStatus | null): void {
'@
    New = @'
  /** dsh-thought-bubble: show only the plugin's Chinese translation (last sentence), never the English reasoning. */
  private think(): PetStatus {
    const state = thoughtBubble();
    if (!state || state.paused) return THINK;
    const source = state.zh || state.fallback || '';
    const text = source ? lastThoughtSentence(source) : '';
    return text ? { kind: 'think', text } : THINK;
  }

  private set(status: PetStatus | null): void {
'@
  }
)

$cssPairs = @(
  @{
    Old = @'
.status[data-kind="think"]{justify-content:center}
.status[data-kind="think"] .status-text{display:none}
.status[data-kind="think"] .status-icon svg{width:calc(24px * var(--bubble-font, 1))}
'@
    New = @'
/* dsh-thought-bubble: the activity bubble shows the last sentence, may wrap; no ellipsis; separate from dialogue, never spoken. */
.status[data-kind="think"]{justify-content:flex-start; align-items:flex-start}
.status[data-kind="think"] .status-text{display:block; max-width:min(calc(220px * var(--bubble-size, 1)), calc(100vw - 80px)); white-space:normal; text-overflow:clip; overflow-wrap:anywhere}
.status[data-kind="think"] .status-icon{margin-top:1px}
.status[data-kind="think"] .status-icon svg{width:calc(14px * var(--bubble-font, 1))}
'@
  }
)

function Apply-Patch([string]$path, [array]$pairs) {
  $doc = Get-Normalized $path
  if ($doc.Text.Contains($marker)) { Write-Host "already patched, skipped: $path"; return }
  foreach ($pair in $pairs) {
    if (-not $doc.Text.Contains($pair.Old)) {
      throw "Patch anchor not found in $path; this Coopanion version differs, re-adapt the patch."
    }
  }
  if (-not (Test-Path -LiteralPath "$path.bak-thoughts")) {
    Copy-Item -LiteralPath $path -Destination "$path.bak-thoughts" -Force
  }
  $text = $doc.Text
  foreach ($pair in $pairs) { $text = $text.Replace($pair.Old, $pair.New) }
  Save-Normalized $path $text $doc.Crlf
  Write-Host "patched: $path"
}

Apply-Patch $statusPath $statusPairs
Apply-Patch $cssPath $cssPairs
Write-Host 'Done. Restart Coopanion; the activity bubble now carries one line of thinking (never spoken, never in chat).'
