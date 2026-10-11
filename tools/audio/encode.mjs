// Turns render.rb's WAV takes of the THEMES into the game's looping AAC files.
// The cues go through the hub's own encoder instead, for the reason below.
//
//   node tools/audio/encode.mjs WAV_DIR [audio]
//
// Each theme opens with a marker tick and plays its loop twice; the loop starts
// `lead` seconds after the tick. The SECOND pass — which already carries the
// first pass's reverb tails — is cut to the exact loop length, so the seam is
// the piece's own decay wrapping round rather than a drop to silence. Each file
// is peak-normalised on its own and kept stereo: unlike the cues, themes never
// layer with one another (one plays, or two cross-fade for a second), so their
// relative balance is not something to preserve — src/ui/audio.js trims them
// per track at runtime instead.
//
// The cues: node ../tools/audio/encode-oneshots.mjs SFX_WAV_DIR audio
// (one gain shared by the whole set, mono, trimmed — read its header).
//
// Adapted from fishtank/tools/audio/encode.mjs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Loop lengths follow from the compositions: 32 beats at 60 bpm, 64 at 80.
// `lead` is the one beat between the marker tick and the loop.
export const THEMES = {
  'music-title': { loop: 32, lead: 1, bitrate: '128k' },
  'music-build': { loop: 48, lead: 0.75, bitrate: '128k' },
  'music-flood': { loop: 48, lead: 0.75, bitrate: '128k' },
};
// Normalise to here. Not -1: AAC decodes a little hotter than its source, and
// these sit under a runtime bus gain anyway, so the last decibel buys nothing.
const PEAK_DB = -2;

const [wavDir, outDir = 'audio'] = process.argv.slice(2);
if (!wavDir) {
  console.error('Usage: node tools/audio/encode.mjs WAV_DIR [OUT_DIR]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
  return run.stderr;
}

// astats, not volumedetect: volumedetect reports every peak at or above full
// scale as exactly 0.0 dB (see the hub's encode-oneshots.mjs).
function peakDb(file, filter = '') {
  const log = ffmpeg(['-i', file, '-af', `${filter}astats=measure_overall=Peak_level:measure_perchannel=none`, '-f', 'null', '-']);
  return +(log.match(/Peak level dB:\s*(-?[\d.]+)/)?.[1] ?? 0);
}

function onsetAndDuration(file) {
  const log = ffmpeg(['-i', file, '-af', 'silencedetect=n=-45dB:d=0.02', '-f', 'null', '-']);
  const marks = [...log.matchAll(/silence_(start|end): ([\d.]+)/g)].map((m) => [m[1], +m[2]]);
  const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  // The marker tick is the first sound: the end of the opening silence.
  let onset = 0;
  if (marks[0]?.[0] === 'start' && marks[0][1] < 0.01 && marks[1]?.[0] === 'end') onset = marks[1][1];
  return { onset, duration };
}

const report = [];
for (const [name, spec] of Object.entries(THEMES)) {
  const input = path.join(wavDir, `${name}.wav`);
  try { statSync(input); } catch { console.warn(`skip ${name}: no ${input}`); continue; }
  const { onset, duration } = onsetAndDuration(input);
  const start = onset + spec.lead + spec.loop;
  const end = start + spec.loop;
  if (end > duration + 0.01) throw new Error(`${name}: take too short for two loops (${duration}s)`);
  const cut = `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,`;
  const gain = (PEAK_DB - peakDb(input, cut)).toFixed(2);
  // 6 ms fades at the seam: the second pass's first sample and its last are
  // continuous with each other in the music, but not with digital zero.
  const filter = `${cut}afade=t=in:st=0:d=0.006,afade=t=out:st=${spec.loop - 0.006}:d=0.006,volume=${gain}dB`;
  const output = path.join(outDir, `${name}.m4a`);
  ffmpeg(['-i', input, '-af', filter, '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', spec.bitrate, '-movflags', '+faststart', output]);
  report.push(`${name.padEnd(12)} loop ${spec.loop}s from ${start.toFixed(3)}s  gain ${gain} dB  -> ${peakDb(output).toFixed(1)} dBFS, ${(statSync(output).size / 1024).toFixed(0)} KB`);
}
console.log(report.join('\n'));
